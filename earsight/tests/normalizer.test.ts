import { describe, it, expect } from 'vitest';
import { DepthNormalizer, percentileBounds } from '../src/depth/normalizer';

describe('depth display normalisation', () => {
  it('percentile bounds ignore outliers', () => {
    const a = new Float32Array(1000).map((_, i) => i / 10);
    a[0] = -1e6; a[999] = 1e6;
    const [lo, hi] = percentileBounds(a, 2, 98);
    expect(lo).toBeGreaterThan(0); expect(hi).toBeLessThan(100);
  });
  it('larger raw value maps to whiter (closer)', () => {
    const n = new DepthNormalizer({ boundsSmoothingMs: 0 });
    const raw = new Float32Array([0, 5, 10]);
    n.update(raw, 0);
    const c = n.closeness(raw);
    expect(c[2]).toBeGreaterThan(c[1]); expect(c[1]).toBeGreaterThan(c[0]);
    expect(n.closeness(new Float32Array([1000]))[0]).toBe(1);
  });
  it('bounds are smoothed over time but the spatial map is not averaged', () => {
    const n = new DepthNormalizer({ boundsSmoothingMs: 1000 });
    n.update(new Float32Array([0, 10]), 0);
    n.update(new Float32Array([0, 20]), 100);
    expect(n.hi).toBeGreaterThan(10); expect(n.hi).toBeLessThan(20);
    const c = n.closeness(new Float32Array([0, 20]));
    expect(c[0]).toBe(0);
  });
  it('handles empty / constant / NaN input', () => {
    const n = new DepthNormalizer();
    expect(() => n.update(new Float32Array(0), 0)).not.toThrow();
    expect(() => n.update(new Float32Array([3, 3, 3]), 10)).not.toThrow();
    expect(() => n.update(new Float32Array([NaN, NaN]), 20)).not.toThrow();
    expect(Number.isFinite(n.closeness(new Float32Array([3]))[0])).toBe(true);
  });
});
