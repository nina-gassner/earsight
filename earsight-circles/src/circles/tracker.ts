/**
 * Circle tracker + "approaching" decision (pure, no OpenCV).
 *
 * The specification for a circle to count as approaching (all must hold):
 *  1. it is detected as a circle (shape gates in detect.ts) in >= 70 % of the frames of the window,
 *  2. it is tracked for at least `minSpanMs` with at least `minHits` detections (persistence: no single-frame flukes),
 *  3. ln(radius) grows steadily (mean of the first/middle/last third of the window strictly increasing — rejects oscillation)
 *     and linearly in time: slope (expansion rate) >= rateMin [1/s], significant (slope / stderr >= zMin)
 *     and well explained by the line (R^2 >= minR2) — so jitter, one-off size jumps and wobble do not count,
 *  4. the radius is above the minimum and the circle is not touching/larger than the frame limits.
 * Once approaching, the state is kept (hysteresis) until the rate stays below half the threshold for `holdMs`.
 * Receding, constant-size or sideways-moving circles give rate <= 0 and are never approaching.
 */
import type { CircleDet } from './detect';

export interface CircleSettings {
  /** regression window in ms */
  windowMs: number;
  /** multiplies the allowed sensitivity: >1 lowers the rate threshold */
  sensitivity: number;
  rateMin: number;
  zMin: number;
  minR2: number;
  minHits: number;
  minSpanMs: number;
  minHitFrac: number;
  holdMs: number;
  /** a track is dropped after this long without a matching detection */
  maxMissMs: number;
}

export const DEFAULT_CIRCLE_SETTINGS: CircleSettings = {
  windowMs: 700, sensitivity: 1, rateMin: 0.25, zMin: 3, minR2: 0.5, minHits: 4, minSpanMs: 250, minHitFrac: 0.6, holdMs: 250, maxMissMs: 300,
};

export interface TrackSample { t: number; x: number; y: number; r: number }

export interface CircleTrack {
  id: number;
  samples: TrackSample[];
  /** frames processed while this track existed inside the window (hits + misses), for hit-fraction */
  frameTimes: number[];
  lastSeen: number;
  approaching: boolean;
  lastApproachT: number;
  rate: number;
  z: number;
  r2: number;
  strength: number;
}

export interface TrackReport {
  id: number;
  x: number; y: number; r: number;
  rate: number; z: number; r2: number;
  /** time to contact estimate in s (1 / rate), Infinity if not expanding */
  ttc: number;
  strength: number;
  approaching: boolean;
  hits: number;
}

/** mean ln(r) of first / middle / last third of the samples must increase by at least `minRate` (1/s) between thirds */
export function steady(smp: TrackSample[], minRate: number): boolean {
  const n = smp.length;
  if (n < 3) return false;
  const k = Math.floor(n / 3);
  const mean = (a: number, b: number) => { let m = 0; for (let i = a; i < b; i++) m += Math.log(smp[i].r); return m / (b - a); };
  const tm = (a: number, b: number) => { let m = 0; for (let i = a; i < b; i++) m += smp[i].t; return m / (b - a); };
  const a = [0, k], b = [Math.floor((n - k) / 2), Math.floor((n - k) / 2) + k], c = [n - k, n];
  const seg = [a, b, c].map(([x, y]) => ({ l: mean(x, Math.max(y, x + 1)), t: tm(x, Math.max(y, x + 1)) }));
  for (let i = 1; i < 3; i++) {
    const dt = (seg[i].t - seg[i - 1].t) / 1000;
    if (dt <= 0 || (seg[i].l - seg[i - 1].l) / dt < minRate) return false;
  }
  return true;
}

/** OLS slope of y on t with standard error and R^2. */
export function regress(t: number[], y: number[]): { slope: number; se: number; r2: number } | null {
  const n = t.length;
  if (n < 3) return null;
  let mt = 0, my = 0;
  for (let i = 0; i < n; i++) { mt += t[i]; my += y[i]; }
  mt /= n; my /= n;
  let stt = 0, sty = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = t[i] - mt, b = y[i] - my; stt += a * a; sty += a * b; syy += b * b; }
  if (!(stt > 1e-9)) return null;
  const slope = sty / stt;
  const sse = Math.max(0, syy - slope * sty);
  const se = Math.sqrt(sse / Math.max(1, n - 2) / stt);
  const r2 = syy > 1e-12 ? 1 - sse / syy : 0;
  return { slope, se: Math.max(se, 1e-4), r2 };
}

export class CircleTracker {
  tracks: CircleTrack[] = [];
  private nextId = 1;
  private lastT = -Infinity;
  constructor(public s: CircleSettings = { ...DEFAULT_CIRCLE_SETTINGS }) {}

  configure(p: Partial<CircleSettings>) { Object.assign(this.s, p); }
  reset() { this.tracks = []; this.lastT = -Infinity; }

  /** feed detections of one frame (t in ms). Returns reports of all live tracks. */
  update(dets: CircleDet[], tMs: number, imgW: number): TrackReport[] {
    if (!Number.isFinite(tMs) || tMs <= this.lastT || tMs - this.lastT > 1000) {
      // bad timestamp or long gap: history would give wrong rates
      if (!Number.isFinite(tMs)) return [];
      this.tracks = [];
    }
    this.lastT = tMs;

    // greedy association, best pairs first
    const pairs: { ti: number; di: number; cost: number }[] = [];
    this.tracks.forEach((tr, ti) => {
      const last = tr.samples[tr.samples.length - 1];
      dets.forEach((d, di) => {
        const dist = Math.hypot(d.x - last.x, d.y - last.y);
        const dr = Math.abs(Math.log(d.r / last.r));
        if (dist > 0.9 * last.r + 5 || dr > 0.3) return;
        pairs.push({ ti, di, cost: dist / last.r + 2 * dr });
      });
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const usedT = new Set<number>(), usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti); usedD.add(p.di);
      const tr = this.tracks[p.ti], d = dets[p.di];
      tr.samples.push({ t: tMs, x: d.x, y: d.y, r: d.r });
      tr.lastSeen = tMs;
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      this.tracks.push({ id: this.nextId++, samples: [{ t: tMs, x: d.x, y: d.y, r: d.r }], frameTimes: [], lastSeen: tMs, approaching: false, lastApproachT: -Infinity, rate: 0, z: 0, r2: 0, strength: 0 });
    });

    const reports: TrackReport[] = [];
    const keep: CircleTrack[] = [];
    for (const tr of this.tracks) {
      tr.frameTimes.push(tMs);
      const t0 = tMs - this.s.windowMs;
      while (tr.samples.length && tr.samples[0].t < t0) tr.samples.shift();
      while (tr.frameTimes.length && tr.frameTimes[0] < t0) tr.frameTimes.shift();
      if (tMs - tr.lastSeen > this.s.maxMissMs || tr.samples.length === 0) continue;
      keep.push(tr);
      this.evaluate(tr, tMs, imgW);
      const last = tr.samples[tr.samples.length - 1];
      reports.push({ id: tr.id, x: last.x, y: last.y, r: last.r, rate: tr.rate, z: tr.z, r2: tr.r2, ttc: tr.rate > 1e-3 ? 1 / tr.rate : Infinity, strength: tr.strength, approaching: tr.approaching, hits: tr.samples.length });
    }
    this.tracks = keep;
    return reports;
  }

  private evaluate(tr: CircleTrack, tMs: number, imgW: number) {
    const s = this.s;
    const rateMin = s.rateMin / Math.max(0.2, s.sensitivity);
    const smp = tr.samples;
    const span = smp.length > 1 ? smp[smp.length - 1].t - smp[0].t : 0;
    let rate = 0, z = 0, r2 = 0, ok = false;
    const hitFrac = tr.frameTimes.length ? smp.length / tr.frameTimes.length : 0;
    if (smp.length >= s.minHits && span >= s.minSpanMs && hitFrac >= s.minHitFrac) {
      const reg = regress(smp.map((p) => (p.t - smp[0].t) / 1000), smp.map((p) => Math.log(p.r)));
      if (reg) { rate = reg.slope; z = reg.slope / reg.se; r2 = reg.r2; ok = true; }
    }
    tr.rate = rate; tr.z = z; tr.r2 = r2;
    const last = smp[smp.length - 1];
    const sizeOk = last.r >= 0.018 * imgW && last.r <= 0.45 * imgW;
    const strict = ok && sizeOk && rate >= rateMin && z >= s.zMin && r2 >= s.minR2 && steady(smp, 0.15 * rateMin);
    if (strict) { tr.approaching = true; tr.lastApproachT = tMs; }
    else if (tr.approaching) {
      const stillOk = ok && sizeOk && rate >= 0.5 * rateMin && z >= 0.5 * s.zMin;
      if (stillOk) tr.lastApproachT = tMs;
      else if (tMs - tr.lastApproachT > s.holdMs) tr.approaching = false;
    }
    // strength: 0 at the threshold rate, 1 at 4x the threshold rate; faded by the shape/track quality
    tr.strength = tr.approaching ? Math.min(1, Math.max(0.15, (rate - rateMin) / (3 * rateMin) + 0.15)) * Math.min(1, 0.5 + 0.5 * r2) : 0;
  }
}

/** how close the circle is, 0..1: the larger of "looks big" and "will arrive soon" (time-to-contact) */
export function circleCloseness(r: number, imgW: number, ttc: number): number {
  const size = Math.min(1, r / (0.25 * imgW));
  const soon = Number.isFinite(ttc) ? Math.min(1, Math.max(0, 1 - ttc / 3)) : 0;
  return Math.min(1, Math.max(size, soon));
}
