/**
 * Local optical-expansion estimation from point correspondences.
 *
 * Pure maths, no OpenCV, no DOM: unit-testable and usable from a worker.
 *
 * Model: inside a local neighbourhood, correspondences obey  q = A p + b.
 * Linear scale change  s = sqrt(det A)  (rotation has det 1, translation does
 * not enter A), and
 *     expansionRate = ln(s) / elapsedSeconds        [1/s]
 * Positive rate: the surface patch is growing in the image, which (for a rigid
 * surface, fixed zoom) is evidence that its distance to the camera is shrinking.
 * It equals 1/TTC for a fronto-parallel surface approached at constant speed.
 */

export interface Correspondence {
  id: number;
  /** position at the reference time */
  px: number;
  py: number;
  /** position at the current time */
  qx: number;
  qy: number;
}

export interface ExpansionParams {
  /** minimum number of correspondences inside the neighbourhood */
  minPoints: number;
  /** minimum RANSAC inliers (must exceed 3, the mathematical minimum) */
  minInliers: number;
  /** minimum inlier / total fraction */
  minInlierFraction: number;
  /** inlier distance threshold in pixels (processing resolution) */
  inlierThresholdPx: number;
  /** maximum inlier RMS residual in pixels */
  maxRmsPx: number;
  /** minimum sqrt of the smaller covariance eigenvalue of inlier positions, as a fraction of radius */
  minSpreadFraction: number;
  /** max ratio of singular values (shear/anisotropy limit) */
  maxAnisotropy: number;
  /** accepted range of linear scale s = sqrt(det) over the window */
  minScale: number;
  maxScale: number;
  /** positional measurement noise floor in pixels (prevents over-confident perfect fits) */
  noiseFloorPx: number;
  /** minimum / maximum elapsed seconds between correspondences */
  minDt: number;
  maxDt: number;
  /** expansion rate [1/s] where approach evidence starts / saturates */
  rateLow: number;
  rateHigh: number;
  /** required significance rate / sigmaRate to begin / fully count */
  zLow: number;
  zHigh: number;
  ransacIterations: number;
  /** number of inliers at which support confidence saturates */
  fullSupport: number;
}

export const DEFAULT_EXPANSION_PARAMS: ExpansionParams = {
  minPoints: 5,
  minInliers: 4,
  minInlierFraction: 0.5,
  inlierThresholdPx: 1.2,
  maxRmsPx: 1.0,
  minSpreadFraction: 0.15,
  maxAnisotropy: 1.5,
  minScale: 0.3,
  maxScale: 4.0,
  noiseFloorPx: 0.2,
  minDt: 0.03,
  maxDt: 1.0,
  rateLow: 0.12,
  rateHigh: 0.5,
  zLow: 2.5,
  zHigh: 5,
  ransacIterations: 60,
  fullSupport: 9,
};

export type UnknownReason =
  | 'bad-dt'
  | 'few-points'
  | 'degenerate-geometry'
  | 'few-inliers'
  | 'low-inlier-fraction'
  | 'poor-spread'
  | 'high-residual'
  | 'reflection'
  | 'anisotropic'
  | 'implausible-scale'
  | 'non-finite';

export interface FitOk {
  status: 'ok';
  /** affine part [a b; c d] and translation, q = A p + t */
  A: [number, number, number, number];
  t: [number, number];
  /** linear scale sqrt(det A) */
  scale: number;
  /** signed expansion rate in 1/s (negative = contraction) */
  rate: number;
  /** 1-sigma uncertainty of rate, 1/s */
  sigmaRate: number;
  /** 0..1 fit quality (support, inlier fraction, residual, conditioning, spread) */
  confidence: number;
  /** 0..1 statistical significance of a positive rate (0 for contraction) */
  significance: number;
  /** 0..1 instantaneous approach evidence = ramp(rate) * significance * confidence */
  evidence: number;
  rms: number;
  anisotropy: number;
  rotationRad: number;
  nTotal: number;
  nInliers: number;
  inlierIds: number[];
  /** centroid of the inlier positions at the current time */
  cx: number;
  cy: number;
}

export interface FitUnknown {
  status: 'unknown';
  reason: UnknownReason;
  nTotal: number;
}

export type FitResult = FitOk | FitUnknown;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (!(e1 > e0)) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** deterministic PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares affine q = A p + t over the given subset (indices into pts).
 * Returns null if the points are (near) collinear.
 */
function solveAffine(pts: Correspondence[], idx: ArrayLike<number>, n: number): Affine | null {
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (let k = 0; k < n; k++) {
    const p = pts[idx[k]];
    mpx += p.px; mpy += p.py; mqx += p.qx; mqy += p.qy;
  }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  let uxx = 0, uxy = 0, uyx = 0, uyy = 0; // sum dq * dp^T
  for (let k = 0; k < n; k++) {
    const p = pts[idx[k]];
    const dx = p.px - mpx, dy = p.py - mpy;
    const ex = p.qx - mqx, ey = p.qy - mqy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    uxx += ex * dx; uxy += ex * dy; uyx += ey * dx; uyy += ey * dy;
  }
  const det = sxx * syy - sxy * sxy;
  // scale-aware singularity test: relative to trace^2
  const tr = sxx + syy;
  if (!(tr > 1e-9) || !(det > 1e-6 * tr * tr)) return null;
  const i00 = syy / det, i01 = -sxy / det, i11 = sxx / det;
  const a = uxx * i00 + uxy * i01;
  const b = uxx * i01 + uxy * i11;
  const c = uyx * i00 + uyy * i01;
  const d = uyx * i01 + uyy * i11;
  return { a, b, c, d, tx: mqx - (a * mpx + b * mpy), ty: mqy - (c * mpx + d * mpy) };
}

function residual(m: Affine, p: Correspondence): number {
  const rx = m.a * p.px + m.b * p.py + m.tx - p.qx;
  const ry = m.c * p.px + m.d * p.py + m.ty - p.qy;
  return Math.hypot(rx, ry);
}

const unknown = (reason: UnknownReason, nTotal: number): FitUnknown => ({ status: 'unknown', reason, nTotal });

/**
 * Robustly fit a local affine map to the correspondences inside one neighbourhood and
 * derive an expansion rate. Never throws; returns `status:'unknown'` when evidence is insufficient.
 *
 * @param radius  neighbourhood radius in pixels (used to judge spatial spread)
 * @param dt      elapsed seconds between the p and q samples (actual timestamps)
 */
export function fitLocalExpansion(
  pts: Correspondence[],
  radius: number,
  dt: number,
  params: ExpansionParams = DEFAULT_EXPANSION_PARAMS,
  seed = 12345,
): FitResult {
  const n = pts.length;
  if (!Number.isFinite(dt) || dt < params.minDt || dt > params.maxDt) return unknown('bad-dt', n);
  if (n < params.minPoints) return unknown('few-points', n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.px + p.py + p.qx + p.qy)) return unknown('non-finite', n);
  }

  // --- RANSAC over minimal 3-point samples -------------------------------------------------
  const rng = mulberry32(seed + n * 7919);
  const thr = params.inlierThresholdPx;
  let best: Affine | null = null;
  let bestScore = -Infinity;
  const sample = new Int32Array(3);
  const all = new Int32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  const minArea = 0.02 * radius * radius;
  for (let it = 0; it < params.ransacIterations; it++) {
    sample[0] = Math.floor(rng() * n);
    sample[1] = Math.floor(rng() * n);
    sample[2] = Math.floor(rng() * n);
    if (sample[0] === sample[1] || sample[0] === sample[2] || sample[1] === sample[2]) continue;
    const a = pts[sample[0]], b = pts[sample[1]], c = pts[sample[2]];
    const area2 = Math.abs((b.px - a.px) * (c.py - a.py) - (c.px - a.px) * (b.py - a.py));
    if (area2 < minArea) continue; // nearly collinear sample
    const m = solveAffine(pts, sample, 3);
    if (!m) continue;
    // truncated (MSAC) score: robust to threshold choice
    let score = 0;
    for (let i = 0; i < n; i++) {
      const r = residual(m, pts[i]);
      score += r < thr ? 1 - (r * r) / (thr * thr) * 0.5 : 0;
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best) return unknown('degenerate-geometry', n);

  // --- refine on inliers (iterated LSQ) --------------------------------------------------
  let model: Affine = best;
  let inl: number[] = [];
  for (let iter = 0; iter < 3; iter++) {
    inl = [];
    for (let i = 0; i < n; i++) if (residual(model, pts[i]) < thr) inl.push(i);
    if (inl.length < 4) return unknown('few-inliers', n);
    const m2 = solveAffine(pts, inl, inl.length);
    if (!m2) return unknown('degenerate-geometry', n);
    model = m2;
  }
  inl = [];
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const r = residual(model, pts[i]);
    if (r < thr) { inl.push(i); sumSq += r * r; }
  }
  const nIn = inl.length;
  if (nIn < params.minInliers) return unknown('few-inliers', n);
  const frac = nIn / n;
  if (frac < params.minInlierFraction) return unknown('low-inlier-fraction', n);
  const rms = Math.sqrt(sumSq / nIn);
  if (!Number.isFinite(rms)) return unknown('non-finite', n);
  if (rms > params.maxRmsPx) return unknown('high-residual', n);

  // --- spatial spread of inliers (guards against collinear / tiny clusters) -----------------
  let cpx = 0, cpy = 0, cqx = 0, cqy = 0;
  for (const i of inl) { cpx += pts[i].px; cpy += pts[i].py; cqx += pts[i].qx; cqy += pts[i].qy; }
  cpx /= nIn; cpy /= nIn; cqx /= nIn; cqy /= nIn;
  let sxx = 0, sxy = 0, syy = 0;
  for (const i of inl) {
    const dx = pts[i].px - cpx, dy = pts[i].py - cpy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  sxx /= nIn; sxy /= nIn; syy /= nIn;
  const mid = (sxx + syy) / 2;
  const disc = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const lamMin = Math.max(0, mid - disc);
  const spreadMin = Math.sqrt(lamMin);
  if (spreadMin < params.minSpreadFraction * radius * 0.5) return unknown('poor-spread', n);

  // --- conditioning of A -----------------------------------------------------------------
  const { a, b, c, d } = model;
  const E = (a + d) / 2, F = (a - d) / 2, G = (c + b) / 2, H = (c - b) / 2;
  const Q = Math.hypot(E, H);
  const R = Math.hypot(F, G);
  const det = a * d - b * c;
  if (!(det > 0) || Q - R <= 1e-9) return unknown('reflection', n);
  const anisotropy = (Q + R) / (Q - R);
  if (anisotropy > params.maxAnisotropy) return unknown('anisotropic', n);
  const scale = Math.sqrt(det);
  if (scale < params.minScale || scale > params.maxScale) return unknown('implausible-scale', n);
  const rotationRad = Math.atan2(H, E);

  const rate = Math.log(scale) / dt;
  if (!Number.isFinite(rate)) return unknown('non-finite', n);

  // 1-sigma of the scale parameter from residuals and point spread: var(s) = sigma^2 / sum|p-c|^2
  const sigmaPx = Math.max(rms, params.noiseFloorPx);
  const sumR2 = nIn * (sxx + syy);
  const sigmaRate = sigmaPx / Math.sqrt(Math.max(sumR2, 1e-9)) / dt;

  const cSupport = clamp01((nIn - 3) / (params.fullSupport - 3));
  const cFrac = smoothstep(params.minInlierFraction, 0.95, frac);
  const cRes = 1 - smoothstep(0.3 * params.maxRmsPx, params.maxRmsPx, rms);
  const cCond = 1 - smoothstep(1.0, params.maxAnisotropy, anisotropy) * 0.6;
  const cSpread = smoothstep(params.minSpreadFraction * 0.5 * radius, 0.2 * radius, spreadMin);
  const confidence = clamp01(cSupport * (0.4 + 0.6 * cFrac) * (0.4 + 0.6 * cRes) * cCond * (0.3 + 0.7 * cSpread));

  const evRate = smoothstep(params.rateLow, params.rateHigh, rate);
  const z = rate / sigmaRate;
  const evSig = smoothstep(params.zLow, params.zHigh, z);
  // confidence gates evidence (soft threshold) rather than scaling it linearly, so well-supported fits can reach full brightness
  const evidence = clamp01(evRate * evSig * smoothstep(0.1, 0.55, confidence));

  return {
    status: 'ok',
    A: [a, b, c, d],
    t: [model.tx, model.ty],
    scale,
    rate,
    sigmaRate,
    confidence,
    evidence,
    significance: evSig,
    rms,
    anisotropy,
    rotationRad,
    nTotal: n,
    nInliers: nIn,
    inlierIds: inl.map((i) => pts[i].id),
    cx: cqx,
    cy: cqy,
  };
}

/** Validate a frame timestamp pair. Returns the dt in seconds or null if the pair must be rejected/reset. */
export function validateFrameInterval(tPrevMs: number, tNowMs: number, maxGapMs = 600): number | null {
  if (!Number.isFinite(tPrevMs) || !Number.isFinite(tNowMs)) return null;
  const dt = (tNowMs - tPrevMs) / 1000;
  if (dt <= 0 || dt * 1000 > maxGapMs) return null;
  return dt;
}
