import { describe, it, expect } from 'vitest';
import { extractObjects, suppressNonObjects, CLOSENESS_OBJECT_OPTS, APPROACH_OBJECT_OPTS } from '../src/motion/objects';

const W = 80, H = 60;
const blank = () => new Float32Array(W * H);
function rect(a: Float32Array, x0: number, y0: number, x1: number, y1: number, v = 1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * W + x] = v;
}
const accepted = (a: Float32Array, o = CLOSENESS_OBJECT_OPTS) => extractObjects(a, W, H, o).objects.filter((x) => x.accepted).length;
const reasons = (a: Float32Array, o = CLOSENESS_OBJECT_OPTS) => extractObjects(a, W, H, o).objects.map((x) => x.reason);

describe('separable object filter', () => {
  it('accepts a solid compact blob', () => {
    const a = blank(); rect(a, 30, 20, 46, 40);
    expect(accepted(a)).toBe(1);
  });
  it('rejects a smooth horizontal gradient (flickering background / depth drift)', () => {
    const a = blank();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = x / W; // 0..1 ramp
    expect(accepted(a)).toBe(0);
    expect(reasons(a)).toContain('soft-edge');
  });
  it('rejects a gradient that covers a limited area, too', () => {
    const a = blank();
    for (let y = 40; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = 0.3 + 0.7 * ((y - 40) / 20);
    expect(accepted(a)).toBe(0);
  });
  it('rejects a region that fills most of the frame', () => {
    const a = blank(); rect(a, 0, 0, 80, 50);
    expect(accepted(a)).toBe(0);
    expect(reasons(a)).toContain('too-large');
  });
  it('rejects speckle and thin streaks', () => {
    const a = blank(); rect(a, 10, 10, 12, 12); rect(a, 5, 30, 75, 31); rect(a, 60, 5, 61, 55);
    expect(accepted(a)).toBe(0);
  });
  it('keeps the object and removes the gradient when both are present', () => {
    const a = blank();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = 0.9 * (x / W);
    rect(a, 30, 20, 46, 40, 1);
    const out = suppressNonObjects(a, W, H, CLOSENESS_OBJECT_OPTS);
    expect(out[30 * W + 38]).toBe(1);
    expect(out[10 * W + 70]).toBe(0);
  });
  it('approach options accept a soft-ish splatted blob but not a full-frame wash', () => {
    const a = blank();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - 40, y - 30); a[y * W + x] = Math.exp(-(d * d) / (2 * 8 * 8)); }
    expect(accepted(a, APPROACH_OBJECT_OPTS)).toBe(1);
    const b = blank().fill(0.5);
    expect(accepted(b, APPROACH_OBJECT_OPTS)).toBe(0);
  });
  it('rejects a wide flat region touching the bottom edge (the floor)', () => {
    const a = blank(); rect(a, 4, 44, 76, 60);
    expect(reasons(a)).toContain('floor-like');
    expect(accepted(a)).toBe(0);
    const b = blank(); rect(b, 30, 20, 46, 40);
    expect(accepted(b)).toBe(1);
  });
  it('handles empty / tiny input without throwing', () => {
    expect(() => extractObjects(new Float32Array(0), 0, 0, CLOSENESS_OBJECT_OPTS)).not.toThrow();
    expect(accepted(blank())).toBe(0);
  });
});
