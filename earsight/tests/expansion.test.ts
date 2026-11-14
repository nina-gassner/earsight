import { describe, it, expect } from 'vitest';
import {
  fitLocalExpansion, mulberry32, validateFrameInterval, DEFAULT_EXPANSION_PARAMS,
  type Correspondence,
} from '../src/motion/expansion';

const R = 30;
function cloud(n = 30, seed = 1): { x: number; y: number }[] {
  const rnd = mulberry32(seed);
  const out = [];
  while (out.length < n) {
    const x = (rnd() * 2 - 1) * R, y = (rnd() * 2 - 1) * R;
    if (x * x + y * y < R * R) out.push({ x: x + 100, y: y + 80 });
  }
  return out;
}
/** apply q = s*Rot(theta) p + t about (100,80), plus gaussian-ish noise */
function make(s: number, theta: number, tx: number, ty: number, noise = 0.08, n = 30, seed = 1): Correspondence[] {
  const rnd = mulberry32(seed + 99);
  const c = Math.cos(theta), sn = Math.sin(theta);
  return cloud(n, seed).map((p, i) => {
    const dx = p.x - 100, dy = p.y - 80;
    return {
      id: i, px: p.x, py: p.y,
      qx: 100 + s * (c * dx - sn * dy) + tx + (rnd() - 0.5) * 2 * noise,
      qy: 80 + s * (sn * dx + c * dy) + ty + (rnd() - 0.5) * 2 * noise,
    };
  });
}
const ok = (r: ReturnType<typeof fitLocalExpansion>) => {
  if (r.status !== 'ok') throw new Error('expected ok, got unknown: ' + r.reason);
  return r;
};

describe('fitLocalExpansion', () => {
  it('1. identity -> ~0 expansion', () => {
    const r = ok(fitLocalExpansion(make(1, 0, 0, 0), R, 0.2));
    expect(Math.abs(r.rate)).toBeLessThan(0.05);
    expect(r.evidence).toBe(0);
  });
  it('2. pure translation -> ~0 expansion', () => {
    const r = ok(fitLocalExpansion(make(1, 0, 6, -3), R, 0.2));
    expect(Math.abs(r.rate)).toBeLessThan(0.08);
    expect(r.evidence).toBe(0);
  });
  it('3. scale > 1 -> positive expansion matching ln(s)/dt, with approach evidence', () => {
    const s = Math.exp(0.5 * 0.2); // 0.5 /s over 0.2 s
    const r = ok(fitLocalExpansion(make(s, 0, 0, 0), R, 0.2));
    expect(r.rate).toBeGreaterThan(0.4);
    expect(r.rate).toBeLessThan(0.6);
    expect(r.evidence).toBeGreaterThan(0.3);
  });
  it('4. scale < 1 -> negative expansion and zero approach output', () => {
    const r = ok(fitLocalExpansion(make(Math.exp(-0.5 * 0.2), 0, 0, 0), R, 0.2));
    expect(r.rate).toBeLessThan(-0.3);
    expect(r.evidence).toBe(0);
  });
  it('5. in-plane rotation -> ~0 expansion', () => {
    const r = ok(fitLocalExpansion(make(1, 0.12, 0, 0), R, 0.2));
    expect(Math.abs(r.rate)).toBeLessThan(0.08);
    expect(r.evidence).toBe(0);
    expect(Math.abs(r.rotationRad - 0.12)).toBeLessThan(0.02);
  });
  it('5b. rotation + expansion + translation: expansion unaffected by the rotation', () => {
    const r = ok(fitLocalExpansion(make(Math.exp(0.5 * 0.2), 0.2, 4, 2), R, 0.2));
    expect(r.rate).toBeGreaterThan(0.4);
    expect(r.rate).toBeLessThan(0.6);
  });
  it('6. same scale-change rate at different frame intervals -> consistent rates', () => {
    const rate = 0.6;
    const rates = [0.1, 0.2, 0.3].map((dt) => ok(fitLocalExpansion(make(Math.exp(rate * dt), 0, 0, 0, 0.05), R, dt)).rate);
    for (const r of rates) expect(Math.abs(r - rate)).toBeLessThan(0.12);
  });
  it('7. outlier correspondences -> robust estimate (or explicit rejection)', () => {
    const pts = make(Math.exp(0.6 * 0.2), 0, 0, 0, 0.08, 36);
    for (let i = 0; i < 8; i++) { pts[i].qx += 15 * (i % 2 ? 1 : -1); pts[i].qy -= 12; }
    const r = fitLocalExpansion(pts, R, 0.2);
    if (r.status === 'ok') {
      expect(Math.abs(r.rate - 0.6)).toBeLessThan(0.15);
      for (let i = 0; i < 8; i++) expect(r.inlierIds).not.toContain(i);
    } else expect(r.status).toBe('unknown');
    // a plain least-squares fit over all points would be badly biased; ensure we are not
    expect(r.status).toBe('ok');
  });
  it('7b. neighbourhood mixing two opposing motions is rejected rather than averaged', () => {
    const a = make(1, 0, 8, 0, 0.05, 15, 3);
    const b = make(1, 0, -8, 0, 0.05, 15, 4).map((p, i) => ({ ...p, id: 100 + i }));
    const r = fitLocalExpansion([...a, ...b], R, 0.2);
    if (r.status === 'ok') expect(r.evidence).toBe(0);
  });
  it('8. empty / insufficient / collinear -> unknown, no crash', () => {
    expect(fitLocalExpansion([], R, 0.2).status).toBe('unknown');
    expect(fitLocalExpansion(make(1.1, 0, 0, 0).slice(0, 3), R, 0.2).status).toBe('unknown');
    const line: Correspondence[] = Array.from({ length: 20 }, (_, i) => ({ id: i, px: 70 + i * 3, py: 80, qx: 70 + i * 3.3, qy: 80, }));
    const r = fitLocalExpansion(line, R, 0.2);
    expect(r.status).toBe('unknown');
    const nan = make(1, 0, 0, 0); nan[3].qx = NaN;
    expect(fitLocalExpansion(nan, R, 0.2).status).toBe('unknown');
    // all identical points
    const same: Correspondence[] = Array.from({ length: 20 }, (_, i) => ({ id: i, px: 5, py: 5, qx: 6, qy: 6 }));
    expect(fitLocalExpansion(same, R, 0.2).status).toBe('unknown');
  });
  it('8b. reflections and strong anisotropy are rejected', () => {
    const refl = make(1, 0, 0, 0).map((p) => ({ ...p, qx: 200 - p.qx }));
    expect(fitLocalExpansion(refl, R, 0.2).status).toBe('unknown');
    const aniso = make(1, 0, 0, 0, 0.03).map((p) => ({ ...p, qx: 100 + (p.qx - 100) * 1.35, qy: 80 + (p.qy - 80) * 0.8 }));
    const r = fitLocalExpansion(aniso, R, 0.2);
    expect(r.status === 'unknown' || r.evidence < 0.2).toBe(true);
  });
  it('9. invalid timestamps / long gaps -> rejected, never extreme brightness', () => {
    const pts = make(1.5, 0, 0, 0);
    for (const dt of [0, -0.1, NaN, Infinity, 5, 0.001]) {
      const r = fitLocalExpansion(pts, R, dt);
      expect(r.status).toBe('unknown');
    }
    expect(validateFrameInterval(100, 100)).toBeNull();
    expect(validateFrameInterval(100, 50)).toBeNull();
    expect(validateFrameInterval(0, 5000)).toBeNull();
    expect(validateFrameInterval(NaN, 5)).toBeNull();
    expect(validateFrameInterval(0, 33)).toBeCloseTo(0.033);
  });
  it('implausibly large scale (bad tracks) is not rendered as approach', () => {
    const r = fitLocalExpansion(make(6, 0, 0, 0), R, 0.2);
    expect(r.status === 'unknown' || r.evidence === 0).toBe(true);
  });
  it('params expose a margin above the 3-point mathematical minimum', () => {
    expect(DEFAULT_EXPANSION_PARAMS.minInliers).toBeGreaterThan(3);
  });
});
