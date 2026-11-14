/**
 * Camera rotation compensation (pan / tilt / roll) from point correspondences.
 *
 * A rotating camera makes the image flow like  d = A(p) * omega  (3 unknowns, depends only on the focal length), which
 * is NOT zero-divergence away from the image centre: one side of the picture stretches, the other compresses, and a
 * local affine fit then reports fake expansion. We estimate omega robustly (Cauchy-weighted least squares) and remove
 * that flow from the current positions. Forward translation produces a divergent flow that this 3-parameter family
 * cannot absorb, so genuine approach (including walking towards a wall) is preserved.
 */
import type { Correspondence } from './expansion';

export interface DerotationResult {
  /** estimated rotation (rad over the window) about x (tilt), y (pan), z (roll) */
  omega: [number, number, number];
  /** number of correspondences used */
  n: number;
}

function basis(px: number, py: number, cx: number, cy: number, f: number): [number[], number[]] {
  const x = px - cx, y = py - cy;
  return [
    [(x * y) / f, -(f + (x * x) / f), y],
    [f + (y * y) / f, -(x * y) / f, -x],
  ];
}

export function focalFromHfov(width: number, hfovDeg: number): number {
  return width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
}

/** returns the rotation estimate and subtracts the rotational flow from pts' q positions in place */
export function derotate(pts: Correspondence[], width: number, height: number, f: number, cauchyPx: number): DerotationResult {
  const n = pts.length;
  const cx = width / 2, cy = height / 2;
  if (n < 12) return { omega: [0, 0, 0], n };
  const rows = pts.map((p) => basis(p.px, p.py, cx, cy, f));
  let om: [number, number, number] = [0, 0, 0];
  // columns are scaled so the 3 unknowns are comparable (rad * f is in pixels)
  for (let it = 0; it < 6; it++) {
    const ATA = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const ATb = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const dx = p.qx - p.px, dy = p.qy - p.py;
      const [ex, ey] = rows[i];
      const rx = dx - (ex[0] * om[0] + ex[1] * om[1] + ex[2] * om[2]);
      const ry = dy - (ey[0] * om[0] + ey[1] * om[1] + ey[2] * om[2]);
      const w = 1 / (1 + (rx * rx + ry * ry) / (cauchyPx * cauchyPx));
      for (let a = 0; a < 3; a++) {
        ATb[a] += w * (ex[a] * dx + ey[a] * dy);
        for (let b = 0; b < 3; b++) ATA[a * 3 + b] += w * (ex[a] * ex[b] + ey[a] * ey[b]);
      }
    }
    const ridge = 1e-6 * (ATA[0] + ATA[4] + ATA[8]);
    ATA[0] += ridge; ATA[4] += ridge; ATA[8] += ridge;
    const sol = solve3(ATA, ATb);
    if (!sol) break;
    om = sol;
  }
  if (!om.every(Number.isFinite)) return { omega: [0, 0, 0], n };
  for (let i = 0; i < n; i++) {
    const [ex, ey] = rows[i];
    pts[i].qx -= ex[0] * om[0] + ex[1] * om[1] + ex[2] * om[2];
    pts[i].qy -= ey[0] * om[0] + ey[1] * om[1] + ey[2] * om[2];
  }
  return { omega: om, n };
}

function solve3(M: number[], b: number[]): [number, number, number] | null {
  const [a, bb, c, d, e, f, g, h, i] = M;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (!(Math.abs(det) > 1e-12)) return null;
  const x = (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
  const y = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
  const z = (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
  return [x, y, z];
}
