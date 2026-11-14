import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCvNode } from './cvNode';
import { ExpansionApproachEstimator } from '../src/motion/expansionEstimator';
import { SyntheticScene, type SceneKind } from '../src/synthetic/scenes';
import type { ApproachMap } from '../src/motion/types';
import { measureApproach, type Metrics } from '../src/synthetic/metrics';

let cv: any;
const record: Record<string, unknown> = {};
afterAll(() => { mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/pipeline-metrics.json', JSON.stringify(record, null, 2)); });
beforeAll(async () => { cv = (await loadCvNode()).cv; });

const measure = measureApproach;

function run(kind: SceneKind, fps = 30, dropEvery = 0) {
  const sc = new SyntheticScene(kind);
  const est = new ExpansionApproachEstimator(cv);
  const out: { t: number; m: Metrics; map: ApproachMap }[] = [];
  const frames = Math.floor(sc.duration * fps);
  let ms = 0;
  for (let i = 0; i < frames; i++) {
    if (dropEvery && i % dropEvery === dropEvery - 1) continue; // irregular frame intervals
    const t = i / fps;
    const f = sc.render(t);
    const map = est.process({ data: f.gray, width: f.width, height: f.height, t: 1000 + t * 1000 });
    out.push({ t, m: measure(map, f.fgMask, f.width, f.height), map });
    ms += map.stats.procMs;
  }
  est.dispose();
  return { out, avgMs: ms / out.length };
}

const late = (r: ReturnType<typeof run>, from = 0.7) => r.out.filter((o) => o.t >= from);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('actual tracking pipeline on synthetic video', () => {
  it('OpenCV exposes the functions used', () => {
    for (const k of ['calcOpticalFlowPyrLK', 'goodFeaturesToTrack']) expect(typeof cv[k]).toBe('function');
  });

  for (const kind of ['approach', 'recession', 'sideways', 'static', 'rotation', 'waving', 'exposure', 'plain'] as SceneKind[]) {
    it(`scene: ${kind}`, () => {
      const r = run(kind);
      const L = late(r, kind === 'approach' ? 0.95 : 0.7);
      const fgMean = avg(L.map((o) => o.m.fgMean));
      const fgCov = avg(L.map((o) => o.m.fgCov));
      const bgBright = avg(L.map((o) => o.m.bgBright));
      const bgMean = avg(L.map((o) => o.m.bgMeanAll));
      const allMean = avg(L.map((o) => o.m.allMeanAll));
      const maxAll = Math.max(...L.map((o) => o.m.allMeanAll));
      record[kind] = { fgMean: +fgMean.toFixed(3), fgCov: +fgCov.toFixed(2), bgBright: +bgBright.toFixed(3), bgMean: +bgMean.toFixed(3), allMean: +allMean.toFixed(3), maxAll: +maxAll.toFixed(3), avgMs: +r.avgMs.toFixed(1), fits: L[L.length - 1]?.map.stats.fits, tracks: L[L.length - 1]?.map.stats.tracks };
      if (process.env.TRACE) console.log(kind, r.out.filter((_, i) => i % 3 === 0).map((o) => `${o.t.toFixed(2)}:${o.m.fgMean.toFixed(2)}/${o.m.fgCov.toFixed(2)}/${o.map.stats.fits}/${o.map.stats.supportedTracks}`).join(' '));
      if (kind === 'approach') {
        expect(fgMean).toBeGreaterThan(0.3);
        expect(fgCov).toBeGreaterThan(0.5);
        expect(bgBright).toBeLessThan(0.05);
        expect(bgMean).toBeLessThan(0.08);
      } else {
        expect(fgMean).toBeLessThan(0.1);
        expect(bgBright).toBeLessThan(0.05);
        expect(maxAll).toBeLessThan(0.12);
      }
    });
  }
});

describe('camera moving forward (scene-wide expansion)', () => {
  it('whole-scene expansion stays dark', () => {
    const r = run('forward');
    const L = late(r, 0.6);
    const mx = Math.max(...L.map((o) => o.m.allMeanAll));
    record['forward'] = { maxAll: +mx.toFixed(3) };
    expect(mx).toBeLessThan(0.08);
  });
  it('an object approaching faster than the scene still lights up', () => {
    const r = run('forwardobj');
    const L = late(r, 0.7);
    const fg = avg(L.map((o) => o.m.fgMean)), bg = avg(L.map((o) => o.m.bgBright));
    record['forwardobj'] = { fgMean: +fg.toFixed(3), bgBright: +bg.toFixed(3) };
    expect(fg).toBeGreaterThan(0.2);
    expect(bg).toBeLessThan(0.05);
  });
});

describe('fast punch', () => {
  for (const fps of [30, 15]) {
    it(`punch is detected at ${fps} fps (peak foreground evidence) while the background stays dark`, () => {
      const sc = new SyntheticScene('punch');
      const est = new ExpansionApproachEstimator(cv);
      let peak = 0, bgBright = 0;
      const frames = Math.floor(sc.duration * 1.6 * fps);
      for (let i = 0; i < frames; i++) {
        const t = i / fps;
        const f = sc.render(t);
        const map = est.process({ data: f.gray, width: 320, height: 240, t: 1000 + t * 1000 });
        const m = measure(map, f.fgMask, 320, 240);
        if (t > 1.0 && t % 1.6 < 0.6) { peak = Math.max(peak, m.maxFg); }
        if (t > 1.0) bgBright = Math.max(bgBright, m.bgBright);
      }
      record['punch@' + fps] = { peakFg: +peak.toFixed(3), maxBgBright: +bgBright.toFixed(3) };
      est.dispose();
      expect(peak).toBeGreaterThan(0.3);
      expect(bgBright).toBeLessThan(0.05);
    });
  }
});

describe('robustness of the actual pipeline', () => {
  it('survives covering the camera, timestamp problems and reacquires afterwards', () => {
    const sc = new SyntheticScene('approach');
    const est = new ExpansionApproachEstimator(cv);
    const blank = new Uint8Array(320 * 240).fill(20);
    let tms = 1000;
    let last: ApproachMap | null = null;
    const feed = (gray: Uint8Array, t: number) => (last = est.process({ data: gray, width: 320, height: 240, t }));
    for (let i = 0; i < 20; i++) { feed(sc.render(i / 30).gray, tms); tms += 33.3; }
    // covered
    for (let i = 0; i < 10; i++) { const m = feed(blank, tms); tms += 33.3; expect(m.stats.blank).toBe(true); expect(Math.max(...m.support)).toBe(0); }
    // duplicate timestamp, backwards timestamp, NaN timestamp, huge gap: never throws, never bright
    for (const t of [tms, tms - 500, NaN, tms + 60000]) {
      const m = feed(sc.render(0.5).gray, t);
      expect(Math.max(...m.score.map((v, i) => (m.support[i] > 0.2 ? v : 0)))).toBeLessThan(0.05);
    }
    // reacquisition: approach again, bright foreground returns
    let t = tms + 100000;
    let fg = 0;
    for (let i = 0; i < 40; i++) {
      const f = sc.render(Math.min(1.3, i / 30));
      const m = feed(f.gray, t); t += 33.3;
      if (i === 39) fg = measure(m, f.fgMask, 320, 240).fgMean;
    }
    expect(last!.stats.tracks).toBeGreaterThan(50);
    expect(fg).toBeGreaterThan(0.2);
    est.dispose();
  });
  it('irregular frame intervals (dropped frames) still give consistent results', () => {
    const r = run('approach', 30, 3);
    const L = late(r, 0.8);
    expect(avg(L.map((o) => o.m.fgMean))).toBeGreaterThan(0.3);
    expect(avg(L.map((o) => o.m.bgBright))).toBeLessThan(0.03);
  });
  it('moving frame-rate (15 fps) keeps approach bright and the rest dark', () => {
    const r = run('approach', 15);
    const L = late(r, 0.8);
    expect(avg(L.map((o) => o.m.fgMean))).toBeGreaterThan(0.3);
    expect(avg(L.map((o) => o.m.bgBright))).toBeLessThan(0.03);
  });
});
