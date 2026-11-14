/**
 * Circle detector in two stages:
 *  1. candidates: OpenCV Hough circles (permissive; gradient based, so it also works when the ball's outline touches
 *     background edges, which breaks contour-based methods),
 *  2. verification (`ringSupport`, pure and unit-tested): the image is sampled along 48 rays from the candidate centre;
 *     on each ray the strongest radial edge near the candidate radius is found. A circle is accepted only if >= 75 % of
 *     the rays have a clear edge at (nearly) the same radius and a least-squares circle through those edge points is
 *     round (small rms). Centre and radius are refined from these edge points (sub-pixel), which is what makes the
 *     later growth-rate estimate accurate.
 * Squares, ellipses, arcs, texture and blobs fail the verification.
 */
import type { CV } from '../motion/opencv';
import { circleQuality, fitCircle } from './geometry';

export interface CircleDet { x: number; y: number; r: number; /** 0..1 shape quality */ q: number }

export interface DetectOptions {
  /** radius limits as fractions of image width */
  minRadiusFrac: number;
  maxRadiusFrac: number;
  /** max rms deviation / radius (with an absolute floor in px for tiny circles) */
  maxRmsRel: number;
  minRmsPx: number;
  /** fraction of the 48 rays that must show an edge consistent with the circle */
  minSupport: number;
  /** minimum radial edge strength (grey levels per px, after blur) */
  minGrad: number;
  maxCandidates: number;
  maxDetections: number;
}

export const DEFAULT_DETECT: DetectOptions = {
  minRadiusFrac: 0.025, maxRadiusFrac: 0.42, maxRmsRel: 0.07, minRmsPx: 0.8, minSupport: 0.7, minGrad: 3, maxCandidates: 40, maxDetections: 10,
};

const RAYS = 48;

function bilinear(img: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return img[y0 * w + x0] * (1 - fx) * (1 - fy) + img[y0 * w + x1] * fx * (1 - fy) + img[y1 * w + x0] * (1 - fx) * fy + img[y1 * w + x1] * fx * fy;
}

/** Verify (and refine) a circle candidate on a (pre-blurred) grey image. Returns null if it is not a circle. */
export function ringSupport(img: ArrayLike<number>, w: number, h: number, cx: number, cy: number, r: number, o: DetectOptions = DEFAULT_DETECT): CircleDet | null {
  let c = { cx, cy, r };
  for (let pass = 0; pass < 2; pass++) {
    const d = Math.max(3, 0.3 * c.r);
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < RAYS; k++) {
      const a = (2 * Math.PI * k) / RAYS, ca = Math.cos(a), sa = Math.sin(a);
      let best = 0, bestRho = NaN;
      for (let rho = c.r - d; rho <= c.r + d + 1e-9; rho += 0.5) {
        const p1 = bilinear(img, w, h, c.cx + (rho + 0.75) * ca, c.cy + (rho + 0.75) * sa);
        const p0 = bilinear(img, w, h, c.cx + (rho - 0.75) * ca, c.cy + (rho - 0.75) * sa);
        if (Number.isNaN(p0) || Number.isNaN(p1)) continue;
        const g = Math.abs(p1 - p0) / 1.5;
        if (g > best) { best = g; bestRho = rho; }
      }
      if (best >= o.minGrad && !Number.isNaN(bestRho)) { xs.push(c.cx + bestRho * ca); ys.push(c.cy + bestRho * sa); }
    }
    if (xs.length < o.minSupport * RAYS * 0.9) return null;
    const f = fitCircle(xs, ys);
    if (!f) return null;
    c = f;
    if (c.r < o.minRadiusFrac * w * 0.9 || c.r > o.maxRadiusFrac * w * 1.1) return null;
    if (pass === 1) {
      // keep only edge points that agree with the final circle, then judge
      const tol = Math.max(o.maxRmsRel * c.r, o.minRmsPx);
      const ix: number[] = [], iy: number[] = [];
      for (let i = 0; i < xs.length; i++) if (Math.abs(Math.hypot(xs[i] - c.cx, ys[i] - c.cy) - c.r) <= 1.5 * tol) { ix.push(xs[i]); iy.push(ys[i]); }
      const f2 = fitCircle(ix, iy);
      if (!f2) return null;
      const q = circleQuality(ix, iy, f2);
      const support = ix.length / RAYS;
      if (support < o.minSupport || q.coverage < 0.75 || q.rms > tol) return null;
      if (f2.r < o.minRadiusFrac * w || f2.r > o.maxRadiusFrac * w) return null;
      return { x: f2.cx, y: f2.cy, r: f2.r, q: Math.max(0, Math.min(1, 0.5 * (1 - q.rms / tol) + 0.5 * support)) };
    }
  }
  return null;
}

/** Remove near-duplicates (same circle found twice), keeping the better-scoring one; nested circles of different size stay. */
export function dedupe(dets: CircleDet[]): CircleDet[] {
  const sorted = [...dets].sort((a, b) => b.q - a.q);
  const out: CircleDet[] = [];
  for (const d of sorted) {
    if (out.some((k) => Math.hypot(k.x - d.x, k.y - d.y) < 0.4 * Math.max(k.r, d.r) && Math.abs(Math.log(k.r / d.r)) < 0.3)) continue;
    out.push(d);
  }
  return out;
}

export function detectCircles(cv: CV, gray: Uint8Array, w: number, h: number, o: DetectOptions = DEFAULT_DETECT): CircleDet[] {
  const src = cv.matFromArray(h, w, cv.CV_8UC1, gray);
  const blur = new cv.Mat(), half = new cv.Mat(), circles = new cv.Mat(), gx = new cv.Mat(), ag = new cv.Mat();
  const dets: CircleDet[] = [];
  try {
    cv.GaussianBlur(src, blur, new cv.Size(5, 5), 1.2);
    // candidates from a half-resolution copy (4x cheaper); ringSupport() then refines on the full-resolution image
    cv.resize(blur, half, new cv.Size(Math.round(w / 2), Math.round(h / 2)), 0, 0, cv.INTER_AREA);
    const minR = Math.max(3, Math.floor(o.minRadiusFrac * w * 0.9 / 2)), maxR = Math.ceil(o.maxRadiusFrac * w * 1.1 / 2);
    // Hough's edge threshold adapts to the image contrast (soft / low-contrast balls have weak edges)
    cv.Sobel(half, gx, cv.CV_16S, 1, 0, 3); cv.convertScaleAbs(gx, ag);
    const hist = new Uint32Array(256); const ad = ag.data as Uint8Array; for (let i = 0; i < ad.length; i += 2) hist[ad[i]]++;
    let acc = 0, p97 = 0; const tot = Math.ceil(ad.length / 2) * 0.97; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= tot) { p97 = v; break; } }
    const p1 = Math.max(25, Math.min(150, p97 * 1.2));
    cv.HoughCircles(half, circles, cv.HOUGH_GRADIENT, 1, Math.max(4, minR), p1, 22, minR, maxR);
    const data = blur.data as Uint8Array;
    const n = Math.min(circles.cols, o.maxCandidates);
    const cd = circles.data32F as Float32Array;
    for (let i = 0; i < n; i++) {
      const v = ringSupport(data, w, h, cd[3 * i] * 2, cd[3 * i + 1] * 2, cd[3 * i + 2] * 2, o);
      if (v) dets.push(v);
    }
  } finally { src.delete(); blur.delete(); half.delete(); circles.delete(); gx.delete(); ag.delete(); }
  return dedupe(dets).slice(0, o.maxDetections);
}
