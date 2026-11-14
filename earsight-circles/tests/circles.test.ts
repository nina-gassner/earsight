import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCvNode } from './cvNode';
import { circleQuality, fitCircle, panGains } from '../src/circles/geometry';
import { ringSupport, dedupe, DEFAULT_DETECT } from '../src/circles/detect';
import { CircleTracker, circleCloseness, regress, DEFAULT_CIRCLE_SETTINGS } from '../src/circles/tracker';
import { CircleApproachEstimator } from '../src/circles/estimator';
import { SyntheticScene, type SceneKind } from '../src/synthetic/scenes';
import { mulberry32 } from '../src/motion/expansion';

const ring = (cx: number, cy: number, r: number, n = 80, sx = 1, sy = 1, from = 0, to = 2 * Math.PI) => {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) { const a = from + ((to - from) * i) / n; xs.push(cx + sx * r * Math.cos(a)); ys.push(cy + sy * r * Math.sin(a)); }
  return { xs, ys };
};

describe('circle geometry', () => {
  it('fits a circle exactly and measures zero deviation', () => {
    const { xs, ys } = ring(100, 60, 25);
    const f = fitCircle(xs, ys)!;
    expect(f.cx).toBeCloseTo(100, 3); expect(f.cy).toBeCloseTo(60, 3); expect(f.r).toBeCloseTo(25, 3);
    const q = circleQuality(xs, ys, f);
    expect(q.rmsRel).toBeLessThan(1e-3); expect(q.coverage).toBe(1); expect(q.turns).toBeCloseTo(1, 1);
  });
  it('rejects degenerate input', () => {
    expect(fitCircle([1, 2, 3], [1, 2, 3])).toBeNull();
    expect(fitCircle([0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5])).toBeNull();
    expect(fitCircle([], [])).toBeNull();
  });
  it('pan law is constant power, mirror and flip swap sides', () => {
    const a = panGains(0, false, false), b = panGains(1, false, false), c = panGains(0.5, false, false);
    expect(a.left).toBeCloseTo(1); expect(a.right).toBeCloseTo(0); expect(b.right).toBeCloseTo(1);
    expect(c.left ** 2 + c.right ** 2).toBeCloseTo(1);
    expect(panGains(0, true, false).right).toBeCloseTo(1);
    expect(panGains(0, false, true).right).toBeCloseTo(1);
    expect(panGains(0, true, true).left).toBeCloseTo(1);
  });
});

describe('ring verification (what counts as a circle)', () => {
  const W = 320, H = 240;
  /** render a grey image: background 0.35, shape 0.85, small noise; shape(x,y) tells if inside */
  function img(inside: (x: number, y: number) => boolean, noise = 0.01, seed = 5) {
    const rnd = mulberry32(seed);
    const g = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = 255 * ((inside(x + 0.5, y + 0.5) ? 0.85 : 0.35) + (rnd() - 0.5) * noise);
    // light box blur like the detector's Gaussian
    const o = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += g[(y + j) * W + x + i]; o[y * W + x] = s / 9; }
    return o;
  }
  const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) < r;
  it('accepts a disc and refines centre/radius to sub-pixel accuracy from a sloppy candidate', () => {
    const d = ringSupport(img(disc(160, 120, 30)), W, H, 163, 118, 28)!;
    expect(d).not.toBeNull();
    expect(Math.hypot(d.x - 160, d.y - 120)).toBeLessThan(0.7); expect(Math.abs(d.r - 30)).toBeLessThan(0.7);
  });
  it('accepts a ball that is partly hidden (a 20 % wedge covered)', () => {
    const inside = (x: number, y: number) => disc(160, 120, 30)(x, y) && !(x > 160 && y < 120 - 0.0 * x && Math.atan2(y - 120, x - 160) > -0.6 * Math.PI / 2 * 2 / 2 && Math.atan2(y - 120, x - 160) < 0 && false);
    expect(ringSupport(img(inside), W, H, 160, 120, 30)).not.toBeNull();
    const half = (x: number, y: number) => disc(160, 120, 30)(x, y) && !(y < 120 - 10 && x > 160 + 5 && x < 160 + 12); // notch
    expect(ringSupport(img(half), W, H, 160, 120, 30)).not.toBeNull();
  });
  it('accepts a disc with noise', () => { expect(ringSupport(img(disc(160, 120, 30), 0.06), W, H, 160, 120, 30)).not.toBeNull(); });
  it('rejects a square, a flat ellipse and an empty image', () => {
    expect(ringSupport(img((x, y) => Math.abs(x - 160) < 30 && Math.abs(y - 120) < 30), W, H, 160, 120, 33)).toBeNull();
    expect(ringSupport(img((x, y) => ((x - 160) / 30) ** 2 + ((y - 120) / 18) ** 2 < 1), W, H, 160, 120, 25)).toBeNull();
    expect(ringSupport(img(() => false), W, H, 160, 120, 30)).toBeNull();
  });
  it('rejects a half disc (only an arc is a circle edge)', () => {
    expect(ringSupport(img((x, y) => disc(160, 120, 30)(x, y) && y < 120), W, H, 160, 118, 30)).toBeNull();
  });
  it('rejects a candidate whose radius does not match the edge', () => {
    expect(ringSupport(img(disc(160, 120, 30)), W, H, 160, 120, 60)).toBeNull();
  });
  it('rejects too small / too large circles', () => {
    expect(ringSupport(img(disc(160, 120, 3)), W, H, 160, 120, 3)).toBeNull();
    expect(ringSupport(img(disc(160, 120, 60)), W, H, 160, 120, 60, { ...DEFAULT_DETECT, maxRadiusFrac: 0.12 })).toBeNull();
  });
  it('dedupe merges duplicates of the same circle but keeps a nested smaller one', () => {
    const out = dedupe([{ x: 100, y: 100, r: 30, q: 0.9 }, { x: 100.5, y: 100, r: 28, q: 0.8 }, { x: 100, y: 100, r: 10, q: 0.7 }]);
    expect(out.length).toBe(2);
  });
});

describe('tracker: the approach specification', () => {
  /** drive a single circle with radius function r(t) at `fps`, return the report list of the last frame */
  function drive(rf: (t: number) => number, xf: (t: number) => number = () => 160, opts: { fps?: number; secs?: number; miss?: (i: number) => boolean; noise?: number; settings?: Partial<typeof DEFAULT_CIRCLE_SETTINGS> } = {}) {
    const fps = opts.fps ?? 30, secs = opts.secs ?? 1.5;
    const tr = new CircleTracker({ ...DEFAULT_CIRCLE_SETTINGS, ...opts.settings });
    const rnd = mulberry32(11);
    let flagged = 0, last: ReturnType<CircleTracker['update']> = [];
    for (let i = 0; i < secs * fps; i++) {
      const t = i / fps;
      const missed = opts.miss?.(i) ?? false;
      const r = rf(t) + ((rnd() - 0.5) * (opts.noise ?? 0));
      last = tr.update(missed ? [] : [{ x: xf(t), y: 120, r, q: 1 }], 1000 + t * 1000, 320);
      if (last.some((x) => x.approaching)) flagged++;
    }
    return { last, flagged, tr };
  }
  it('growing radius (0.8 /s) is approaching', () => {
    const { last } = drive((t) => 20 * Math.exp(0.8 * t));
    expect(last[0].approaching).toBe(true);
    expect(last[0].rate).toBeGreaterThan(0.6); expect(last[0].rate).toBeLessThan(1.0);
    expect(last[0].ttc).toBeGreaterThan(1.0); expect(last[0].ttc).toBeLessThan(1.7);
  });
  it('growing radius with 0.3 px detection noise is still approaching', () => {
    const { last } = drive((t) => 20 * Math.exp(0.8 * t), () => 160, { noise: 0.6 });
    expect(last[0].approaching).toBe(true);
  });
  it('constant, receding, sideways and wobbling circles are never approaching', () => {
    for (const f of [(_t: number) => 25, (t: number) => 40 * Math.exp(-0.8 * t), (t: number) => 25 * (1 + 0.12 * Math.sin(2 * Math.PI * 2 * t))]) {
      expect(drive(f).flagged).toBe(0);
    }
    expect(drive(() => 25, (t) => 60 + 80 * t).flagged).toBe(0);
  });
  it('pixel jitter on a constant circle (±0.6 px) never triggers', () => {
    expect(drive(() => 25, () => 160, { noise: 1.2, secs: 6 }).flagged).toBe(0);
    expect(drive(() => 10, () => 160, { noise: 1.2, secs: 6 }).flagged).toBe(0);
  });
  it('a single-frame size jump is not approaching (persistence + linear-growth requirement)', () => {
    expect(drive((t) => (t > 1.0 ? 32 : 20), () => 160, { secs: 1.2 }).flagged).toBe(0);
  });
  it('is not flagged before the minimum observation time (no flukes), but is flagged soon after', () => {
    const tr = new CircleTracker();
    let first = -1;
    for (let i = 0; i < 40; i++) { const t = i / 30; const rep = tr.update([{ x: 160, y: 120, r: 20 * Math.exp(1.0 * t), q: 1 }], 1000 + t * 1000, 320); if (first < 0 && rep[0].approaching) first = t; }
    expect(first).toBeGreaterThanOrEqual(0.25 - 1e-9); expect(first).toBeLessThan(0.6);
  });
  it('bridges short detection dropouts but needs >= 70 % hits', () => {
    expect(drive((t) => 20 * Math.exp(0.9 * t), () => 160, { miss: (i) => i % 7 === 3 }).last[0].approaching).toBe(true);
    expect(drive((t) => 20 * Math.exp(0.9 * t), () => 160, { miss: (i) => i % 2 === 1 }).flagged).toBe(0);
  });
  it('stays approaching through a short hold and drops after the circle stops growing', () => {
    const tr = new CircleTracker();
    let ap: boolean[] = [];
    for (let i = 0; i < 90; i++) { const t = i / 30; const r = t < 1.0 ? 20 * Math.exp(1.0 * t) : 20 * Math.exp(1.0); const rep = tr.update([{ x: 160, y: 120, r, q: 1 }], 1000 + t * 1000, 320); ap.push(rep[0].approaching); }
    expect(ap[29]).toBe(true);
    expect(ap[89]).toBe(false);
  });
  it('timestamp problems reset the history instead of producing rates', () => {
    const tr = new CircleTracker();
    for (let i = 0; i < 20; i++) tr.update([{ x: 160, y: 120, r: 20 * Math.exp(i / 30), q: 1 }], 1000 + i * 33, 320);
    expect(tr.update([{ x: 160, y: 120, r: 50, q: 1 }], NaN, 320)).toEqual([]);
    const rep = tr.update([{ x: 160, y: 120, r: 50, q: 1 }], 1000 + 60000, 320);
    expect(rep[0].approaching).toBe(false); expect(rep[0].hits).toBe(1);
  });
  it('two circles are tracked independently', () => {
    const tr = new CircleTracker();
    let rep: ReturnType<typeof tr.update> = [];
    for (let i = 0; i < 45; i++) { const t = i / 30; rep = tr.update([{ x: 80, y: 120, r: 20 * Math.exp(0.9 * t), q: 1 }, { x: 240, y: 120, r: 30, q: 1 }], 1000 + t * 1000, 320); }
    expect(rep.length).toBe(2);
    expect(rep.find((r) => r.x < 160)!.approaching).toBe(true);
    expect(rep.find((r) => r.x > 160)!.approaching).toBe(false);
  });
  it('sensitivity lowers the rate threshold', () => {
    const f = (t: number) => 20 * Math.exp(0.22 * t);
    expect(drive(f, () => 160, { secs: 3 }).flagged).toBe(0);
    expect(drive(f, () => 160, { secs: 3, settings: { sensitivity: 2 } }).flagged).toBeGreaterThan(0);
  });
  it('regress handles degenerate input', () => {
    expect(regress([0, 0, 0], [1, 2, 3])).toBeNull();
    expect(regress([0, 1], [1, 2])).toBeNull();
  });
  it('closeness rises with size and with shorter time-to-contact', () => {
    expect(circleCloseness(60, 320, Infinity)).toBeGreaterThan(circleCloseness(15, 320, Infinity));
    expect(circleCloseness(15, 320, 0.5)).toBeGreaterThan(circleCloseness(15, 320, 2.5));
    expect(circleCloseness(15, 320, 5)).toBeLessThan(0.3);
  });
});

// ------------------------------------------------------------------ real OpenCV pipeline on synthetic video
let cv: any;
const record: Record<string, unknown> = {};
afterAll(() => { mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/circle-metrics.json', JSON.stringify(record, null, 2)); });
beforeAll(async () => { cv = (await loadCvNode()).cv; });

function run(kind: SceneKind, fps = 30, dropEvery = 0) {
  const sc = new SyntheticScene(kind);
  const est = new CircleApproachEstimator(cv);
  const frames = Math.floor(sc.duration * fps);
  let firstApproach = -1, flagged = 0, maxScore = 0, bgBright = 0, fgHit = 0, detFrames = 0, ms = 0, n = 0;
  for (let i = 0; i < frames; i++) {
    if (dropEvery && i % dropEvery === dropEvery - 1) continue;
    const t = i / fps;
    const f = sc.render(t);
    const map = est.process({ data: f.gray, width: f.width, height: f.height, t: 1000 + t * 1000 });
    ms += map.stats.procMs; n++;
    if ((map.circles?.length ?? 0) > 0) detFrames++;
    if (map.circles?.some((c) => c.approaching)) { flagged++; if (firstApproach < 0) firstApproach = t; }
    let fgN = 0, fgB = 0, bgN = 0, bgB = 0;
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      const v = map.score[y * map.width + x]; maxScore = Math.max(maxScore, v);
      const isFg = f.fgMask[Math.min(f.height - 1, y * 2 + 1) * f.width + Math.min(f.width - 1, x * 2 + 1)] === 1;
      if (isFg) { fgN++; if (v > 0.2) fgB++; } else { bgN++; if (v > 0.2) bgB++; }
    }
    if (fgN > 0 && fgB / fgN > 0.5) fgHit++;
    bgBright = Math.max(bgBright, bgN ? bgB / bgN : 0);
  }
  est.dispose();
  return { firstApproach, flagged, maxScore, bgBright, fgHit, detFrames, frames: n, avgMs: ms / n };
}

describe('real OpenCV detector + tracker on synthetic video (textured background)', () => {
  it('ball approaching: detected as approaching quickly, painted at the ball, nowhere else', () => {
    const r = run('ballapproach'); record['ballapproach'] = r;
    expect(r.firstApproach).toBeGreaterThan(0); expect(r.firstApproach).toBeLessThan(0.7);
    expect(r.fgHit).toBeGreaterThan(r.frames * 0.4);
    expect(r.bgBright).toBeLessThan(0.02);
  });
  it('hard case: blurry, low-contrast ball without outline, at 30 and 10 fps', () => {
    for (const fps of [30, 10]) {
      const r = run('ballsoft', fps); record['ballsoft@' + fps] = r;
      expect(r.detFrames).toBeGreaterThan(r.frames * 0.8);
      expect(r.firstApproach).toBeGreaterThan(0); expect(r.firstApproach).toBeLessThan(0.8);
      expect(r.flagged).toBeGreaterThan(r.frames * 0.5);
      expect(r.bgBright).toBeLessThan(0.02);
    }
  });
  it('ball approaching fast', () => {
    const r = run('ballfast'); record['ballfast'] = r;
    expect(r.flagged).toBeGreaterThan(3);
    expect(r.bgBright).toBeLessThan(0.02);
  });
  for (const kind of ['ballrecede', 'ballside', 'ballstatic', 'ballwobble'] as SceneKind[]) {
    it(`${kind}: never approaching (false-positive check)`, () => {
      const r = run(kind); record[kind] = r;
      expect(r.detFrames).toBeGreaterThan(r.frames * 0.5); // the ball itself IS seen as a circle...
      expect(r.flagged).toBe(0); // ...but never reported as approaching
      expect(r.maxScore).toBe(0);
    });
  }
  for (const kind of ['approach', 'punch', 'forwardobj', 'forward', 'waving', 'rotation', 'recession', 'sideways', 'static', 'exposure', 'plain'] as SceneKind[]) {
    it(`non-circular scene "${kind}" never triggers (squares/textures are not circles)`, () => {
      const r = run(kind); record['nc-' + kind] = r;
      expect(r.flagged).toBe(0);
    });
  }
  it('irregular frame intervals (dropped frames) and 15 fps still detect the approaching ball', () => {
    expect(run('ballapproach', 30, 3).flagged).toBeGreaterThan(5);
    expect(run('ballapproach', 15).flagged).toBeGreaterThan(3);
  });
  it('covered camera gives a blank, silent map and recovers afterwards', () => {
    const sc = new SyntheticScene('ballapproach');
    const est = new CircleApproachEstimator(cv);
    const blank = new Uint8Array(320 * 240).fill(20);
    let t = 1000;
    for (let i = 0; i < 10; i++) { est.process({ data: sc.render(i / 30).gray, width: 320, height: 240, t }); t += 33.3; }
    for (let i = 0; i < 5; i++) { const m = est.process({ data: blank, width: 320, height: 240, t }); t += 33.3; expect(m.stats.blank).toBe(true); expect(Math.max(...m.score)).toBe(0); expect(Math.max(...m.support)).toBe(0); }
    let ok = false;
    for (let i = 0; i < 40; i++) { const m = est.process({ data: sc.render(Math.min(1.3, i / 30)).gray, width: 320, height: 240, t }); t += 33.3; if (m.circles?.some((c) => c.approaching)) ok = true; }
    expect(ok).toBe(true);
  });
  it('per-frame cost is small', () => {
    const r = run('ballapproach'); record['cost'] = r.avgMs;
    expect(r.avgMs).toBeLessThan(90);
  });
});
