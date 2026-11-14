import type { CV } from '../motion/opencv';
import type { ApproachEstimator, ApproachMap, CircleInfo, DepthHint, GrayFrame, MotionSettings } from '../motion/types';
import { detectCircles } from './detect';
import { CircleTracker, circleCloseness, type TrackReport } from './tracker';

/** Third model: only circular objects whose apparent radius grows over time count as approaching. */
export class CircleApproachEstimator implements ApproachEstimator {
  private tracker = new CircleTracker();
  private lastW = 0;

  constructor(private cv: CV) {}
  async init() { /* nothing to load */ }
  configure(s: Partial<MotionSettings>) {
    const p: { windowMs?: number; sensitivity?: number } = {};
    if (s.windowMs !== undefined) p.windowMs = s.windowMs;
    if (s.sensitivity !== undefined) p.sensitivity = s.sensitivity;
    this.tracker.configure(p);
  }
  setDepth(_d: DepthHint | null) { /* not used: the circle model is purely geometric */ }
  reset() { this.tracker.reset(); }
  dispose() { /* no native resources held between frames */ }

  private blank(g: Uint8Array): boolean {
    let m = 0, s = 0; const n = g.length, step = 7;
    let c = 0;
    for (let i = 0; i < n; i += step) { m += g[i]; c++; }
    m /= c;
    for (let i = 0; i < n; i += step) { const d = g[i] - m; s += d * d; }
    return Math.sqrt(s / c) < 3;
  }

  process(f: GrayFrame): ApproachMap {
    const t0 = performance.now();
    const mw = Math.max(8, Math.round(f.width / 2)), mh = Math.max(6, Math.round(f.height / 2));
    const score = new Float32Array(mw * mh), support = new Float32Array(mw * mh);
    if (f.width !== this.lastW) { this.tracker.reset(); this.lastW = f.width; }
    const mk = (note: string, blank: boolean, reports: TrackReport[]): ApproachMap => {
      const circles: CircleInfo[] = reports.map((r) => ({
        id: r.id, x: r.x / f.width, y: r.y / f.height, r: r.r / f.width, rate: r.rate, ttc: r.ttc, z: r.z, strength: r.strength,
        closeness: r.approaching ? circleCloseness(r.r, f.width, r.ttc) : 0, approaching: r.approaching, hits: r.hits,
      }));
      return {
        width: mw, height: mh, score, support, t: f.t, debugPoints: [], debugFits: [], circles,
        stats: { tracks: reports.length, fits: reports.filter((r) => r.approaching).length, supportedTracks: reports.length, windowSeconds: this.tracker.s.windowMs / 1000, procMs: performance.now() - t0, blank, reset: blank, note, failReasons: {} },
      };
    };
    if (this.blank(f.data)) { this.tracker.reset(); return mk('blank frame — tracking suspended', true, []); }

    support.fill(1); // every pixel is "valid, no circle approaching" unless a circle says otherwise
    const dets = detectCircles(this.cv, f.data, f.width, f.height);
    const reports = this.tracker.update(dets, f.t, f.width);
    const sx = mw / f.width, sy = mh / f.height;
    for (const r of reports) {
      if (!r.approaching) continue;
      const cx = r.x * sx, cy = r.y * sy, rr = r.r * sx;
      const x0 = Math.max(0, Math.floor(cx - rr - 1)), x1 = Math.min(mw - 1, Math.ceil(cx + rr + 1));
      const y0 = Math.max(0, Math.floor(cy - rr - 1)), y1 = Math.min(mh - 1, Math.ceil(cy + rr + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) * (sx / sy)) <= rr) score[y * mw + x] = Math.max(score[y * mw + x], r.strength);
      }
    }
    const n = reports.filter((r) => r.approaching).length;
    return mk(dets.length === 0 ? 'no circles in view' : `${dets.length} circle(s) detected, ${n} approaching`, false, reports);
  }
}
