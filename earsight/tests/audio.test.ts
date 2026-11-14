import { describe, it, expect } from 'vitest';
import { computeStereoLevels } from '../src/audio/levels';

const W = 40, H = 30;
const blob = (x0: number, x1: number) => {
  const a = new Float32Array(W * H);
  for (let y = 8; y < 22; y++) for (let x = x0; x < x1; x++) a[y * W + x] = 1;
  return a;
};
const base = { threshold: 0.25, reference: 0.03, mirror: false, flip: false };

describe('stereo levels from bright spots', () => {
  it('bright on the left half -> left ear louder', () => {
    const r = computeStereoLevels(blob(3, 12), W, H, base);
    expect(r.left).toBeGreaterThan(0.5); expect(r.right).toBe(0);
  });
  it('bright on the right half -> right ear louder', () => {
    const r = computeStereoLevels(blob(28, 37), W, H, base);
    expect(r.right).toBeGreaterThan(0.5); expect(r.left).toBe(0);
  });
  it('mirror display swaps sides (left as displayed)', () => {
    const r = computeStereoLevels(blob(3, 12), W, H, { ...base, mirror: true });
    expect(r.right).toBeGreaterThan(0.5); expect(r.left).toBe(0);
  });
  it('flip toggle swaps ears', () => {
    const r = computeStereoLevels(blob(3, 12), W, H, { ...base, flip: true });
    expect(r.right).toBeGreaterThan(0.5); expect(r.left).toBe(0);
    const both = computeStereoLevels(blob(3, 12), W, H, { ...base, flip: true, mirror: true });
    expect(both.left).toBeGreaterThan(0.5);
  });
  it('nothing bright or bad input -> silence', () => {
    expect(computeStereoLevels(new Float32Array(W * H), W, H, base)).toEqual({ left: 0, right: 0 });
    expect(computeStereoLevels(new Float32Array(3), W, H, base)).toEqual({ left: 0, right: 0 });
  });
});

import { weightedCloseness } from '../src/audio/levels';
import { rateFromCloseness, MIN_RATE_HZ, MAX_RATE_HZ } from '../src/audio/sonifier';

describe('beep rate and closeness', () => {
  it('rate rises monotonically with urgency and stays in range', () => {
    let prev = 0;
    for (let c = 0; c <= 1.0001; c += 0.1) { const r = rateFromCloseness(c); expect(r).toBeGreaterThanOrEqual(prev); prev = r; }
    expect(rateFromCloseness(-1)).toBe(MIN_RATE_HZ);
    expect(rateFromCloseness(5)).toBe(MAX_RATE_HZ);
  });
  it('weighted closeness only looks under the bright pixels', () => {
    const w = 10, h = 10;
    const ev = new Float32Array(w * h); const close = new Float32Array(w * h).fill(0.2);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) { ev[y * w + x] = 1; close[y * w + x] = 0.9; }
    expect(weightedCloseness(ev, w, h, 0.25, { data: close, width: w, height: h })).toBeCloseTo(0.9, 5);
    expect(weightedCloseness(new Float32Array(w * h), w, h, 0.25, { data: close, width: w, height: h })).toBeNaN();
  });
  it('threshold keeps a background wall below it out of the beeps', () => {
    const W = 40, H = 30;
    const wall = new Float32Array(W * H).fill(0.5); // uniformly "close-ish" wall
    const lv = computeStereoLevels(wall, W, H, { threshold: 0.6, reference: 0.25, mirror: false, flip: false });
    expect(lv).toEqual({ left: 0, right: 0 });
  });
});

import { earGains, gainFromCloseness, pitchFromHeight } from '../src/audio/sonifier';
import { verticalCentroid } from '../src/audio/levels';

describe('exaggerated stereo, distance loudness, height pitch', () => {
  it('a slight lean to one side already plays mostly in that ear', () => {
    const g = earGains(0.4, 0.6, 3); // balance 0.2 -> x3 = 0.6
    expect(g.r).toBeGreaterThan(g.l * 2);
    const h = earGains(0.3, 0.7, 3); // balance 0.4 -> fully one-sided
    expect(h.l).toBe(0);
    expect(earGains(0.5, 0.5, 3).l).toBeCloseTo(earGains(0.5, 0.5, 3).r, 6);
    expect(earGains(0, 0, 3)).toEqual({ l: 0, r: 0 });
  });
  it('closer is louder, higher up is higher pitched', () => {
    expect(gainFromCloseness(1)).toBeGreaterThan(gainFromCloseness(0.2));
    expect(gainFromCloseness(0)).toBeGreaterThan(0);
    expect(pitchFromHeight(0)).toBeGreaterThan(pitchFromHeight(1) * 4);
  });
  it('vertical centroid of bright pixels', () => {
    const w = 4, h = 4, v = new Float32Array(w * h);
    v[0] = 1; v[1] = 1; // top row
    expect(verticalCentroid(v, w, h, 0.25)).toBeLessThan(0.2);
    expect(verticalCentroid(new Float32Array(w * h), w, h, 0.25)).toBeNaN();
  });
});
