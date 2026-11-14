/** Pure circle geometry: least-squares fit and quality measures for a closed/open contour. */

export interface CircleFit { cx: number; cy: number; r: number }

export interface CircleQuality {
  /** rms radial deviation divided by radius (0 = perfect circle) */
  rmsRel: number;
  /** rms radial deviation in px */
  rms: number;
  /** fraction of angular bins (of 24) that contain contour points */
  coverage: number;
  /** contour length / circumference of the fitted circle (1 = one full turn) */
  turns: number;
}

/** Algebraic (Kåsa) least-squares circle fit. Returns null for degenerate input (too few / collinear points). */
export function fitCircle(xs: ArrayLike<number>, ys: ArrayLike<number>): CircleFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx, v = ys[i] - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-9 * Math.max(1, suu * svv))) return null; // collinear
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (b2 * suu - b1 * suv) / det;
  const r2 = uc * uc + vc * vc + (suu + svv) / n;
  if (!(r2 > 0) || !Number.isFinite(r2)) return null;
  return { cx: mx + uc, cy: my + vc, r: Math.sqrt(r2) };
}

export function circleQuality(xs: ArrayLike<number>, ys: ArrayLike<number>, f: CircleFit): CircleQuality {
  const n = Math.min(xs.length, ys.length);
  const BINS = 24;
  const seen = new Uint8Array(BINS);
  let s2 = 0, len = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - f.cx, dy = ys[i] - f.cy;
    const d = Math.hypot(dx, dy) - f.r;
    s2 += d * d;
    seen[Math.min(BINS - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * BINS))] = 1;
    const j = (i + 1) % n;
    len += Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
  }
  const rms = Math.sqrt(s2 / Math.max(1, n));
  let cov = 0; for (let b = 0; b < BINS; b++) cov += seen[b];
  return { rms, rmsRel: rms / Math.max(1e-6, f.r), coverage: cov / BINS, turns: len / (2 * Math.PI * Math.max(1e-6, f.r)) };
}

/** Pan law: image x position (0..1) -> per-ear gains (constant power). `mirror`: picture is shown mirrored; `flip`: user swap. */
export function panGains(x: number, mirror: boolean, flip: boolean): { left: number; right: number } {
  let p = Math.min(1, Math.max(0, x));
  if (mirror) p = 1 - p;
  if (flip) p = 1 - p;
  return { left: Math.cos((p * Math.PI) / 2), right: Math.sin((p * Math.PI) / 2) };
}
