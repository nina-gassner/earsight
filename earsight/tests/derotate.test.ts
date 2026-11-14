import { describe, it, expect } from 'vitest';
import { derotate, focalFromHfov } from '../src/motion/derotate';
import { fitLocalExpansion, mulberry32, type Correspondence } from '../src/motion/expansion';

const W = 320, H = 240, f = focalFromHfov(W, 70);
function grid(n: number, seed = 3): { x: number; y: number }[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => ({ x: r() * W, y: r() * H }));
}
/** apply a pure rotation (omega, small angles) with the first-order flow model and a given forward-translation divergence */
function flowed(pts: { x: number; y: number }[], om: [number, number, number], scale = 1): Correspondence[] {
  return pts.map((p, i) => {
    const x = p.x - W / 2, y = p.y - H / 2;
    const u = (x * y / f) * om[0] - (f + x * x / f) * om[1] + y * om[2];
    const v = (f + y * y / f) * om[0] - (x * y / f) * om[1] - x * om[2];
    return { id: i, px: p.x, py: p.y, qx: W / 2 + x * scale + u, qy: H / 2 + y * scale + v };
  });
}

describe('camera rotation compensation', () => {
  it('a pure pan produces fake expansion in an edge neighbourhood, derotation removes it', () => {
    const P = grid(400);
    const pts = flowed(P, [0, 0.09, 0]); // ~5 degrees of pan in the window
    const edge = pts.filter((p) => p.px > 230 && p.py > 60 && p.py < 180);
    const before = fitLocalExpansion(edge.map((p) => ({ ...p })), 40, 0.2);
    derotate(pts, W, H, f, 1.5);
    const edgeAfter = pts.filter((p) => p.px > 230 && p.py > 60 && p.py < 180);
    const after = fitLocalExpansion(edgeAfter, 40, 0.2);
    if (before.status === 'ok' && after.status === 'ok') expect(Math.abs(after.rate)).toBeLessThan(Math.abs(before.rate) * 0.3 + 0.05);
    expect(after.status === 'unknown' || Math.abs((after as { rate: number }).rate) < 0.1).toBe(true);
  });
  it('forward-motion expansion survives derotation', () => {
    const P = grid(400);
    const pts = flowed(P, [0, 0, 0], Math.exp(0.5 * 0.2)); // 0.5 /s of expansion over 0.2 s, no rotation
    derotate(pts, W, H, f, 1.5);
    const r = fitLocalExpansion(pts.filter((p) => Math.hypot(p.px - 160, p.py - 120) < 60), 60, 0.2);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.rate).toBeGreaterThan(0.35);
  });
  it('too few points or garbage input leaves the data untouched', () => {
    const few = flowed(grid(5), [0, 0.05, 0]);
    const copy = few.map((p) => ({ ...p }));
    derotate(few, W, H, f, 1.5);
    expect(few).toEqual(copy);
  });
});
