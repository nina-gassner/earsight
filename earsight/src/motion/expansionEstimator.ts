/**
 * Baseline approach estimator: tracked features -> local robust affine fits -> optical expansion rate
 * -> per-track evidence (with temporal persistence bound to the track) -> sparse-to-map splatting.
 *
 * It does not use depth to *derive* approach. Depth (if present) only limits how far evidence is
 * propagated across the map (optional, stale-tolerant gating).
 */
import type { CV } from './opencv';
import { derotate, focalFromHfov } from './derotate';
import { pathFactor, DEFAULT_PATH_GATE } from './pathGate';
import {
  DEFAULT_EXPANSION_PARAMS, fitLocalExpansion, smoothstep, clamp01, validateFrameInterval,
  type Correspondence, type ExpansionParams,
} from './expansion';
import {
  DEFAULT_MOTION_SETTINGS,
  type ApproachEstimator, type ApproachMap, type DebugFit, type DebugPoint, type DepthHint, type GrayFrame, type MotionSettings,
} from './types';

interface Track {
  id: number;
  x: number;
  y: number;
  /** position history keyed by frame number */
  hist: { f: number; x: number; y: number }[];
  /** temporally filtered SIGNED expansion rate (1/s) and significance; oscillation (waving) cancels, contraction subtracts */
  rate: number;
  /** filtered 1-sigma uncertainty of the rate (1/s) */
  sig: number;
  /** fast-attack path: strong, sustained, high-confidence evidence shows immediately, then decays quickly */
  fastEv: number;
  strongT: number;
  conf: number;
  lastSupportT: number;
  supportedNow: boolean;
}

const TARGET_PER_CELL = 7;
const CELLS_X = 8;
const CELLS_Y = 6;
const MIN_FEATURE_DIST = 6;
const BORDER = 8;
const MAX_GAP_MS = 600;
const HOLD_MS = 250;

export class ExpansionApproachEstimator implements ApproachEstimator {
  private cv: CV;
  private s: MotionSettings = { ...DEFAULT_MOTION_SETTINGS };
  readonly baseParams: ExpansionParams;
  private W = 0;
  private H = 0;
  private prev: any = null;
  private cur: any = null;
  private mask: any = null;
  private tracks: Track[] = [];
  private frames: { n: number; t: number }[] = [];
  private frameNo = 0;
  private nextId = 1;
  private lastT = NaN;
  private depth: DepthHint | null = null;
  private lastMapW = 0;
  private pendingResetNote = '';
  private framesSinceDetect = 0;
  private refMean = NaN;
  private lastProcMs = 0;
  private baselineNow = 0;
  /** camera rotation speed (deg/s) estimated this frame from the short windows; 0 if unknown */
  private turnDegPerSec = 0;

  constructor(cv: CV, baseParams: ExpansionParams = DEFAULT_EXPANSION_PARAMS) {
    this.cv = cv;
    this.baseParams = baseParams;
  }

  async init(): Promise<void> { /* cv already initialised by loader */ }

  configure(s: Partial<MotionSettings>): void {
    const changedW = s.procWidth !== undefined && s.procWidth !== this.s.procWidth;
    this.s = { ...this.s, ...s };
    if (changedW) this.reset('processing resolution changed');
  }

  setDepth(d: DepthHint | null): void { this.depth = d; }

  reset(note = 'manual reset'): void {
    this.tracks = [];
    this.frames = [];
    this.lastT = NaN;
    this.refMean = NaN;
    this.pendingResetNote = note;
  }

  dispose(): void {
    for (const m of [this.prev, this.cur, this.mask]) m?.delete();
    this.prev = this.cur = this.mask = null;
    this.W = this.H = 0;
  }

  private alloc(w: number, h: number) {
    const cv = this.cv;
    for (const m of [this.prev, this.cur, this.mask]) m?.delete();
    this.prev = new cv.Mat(h, w, cv.CV_8UC1);
    this.cur = new cv.Mat(h, w, cv.CV_8UC1);
    this.mask = new cv.Mat(h, w, cv.CV_8UC1);
    this.W = w; this.H = h;
    this.tracks = []; this.frames = []; this.lastT = NaN;
  }

  private params(): ExpansionParams {
    const k = this.s.procWidth / 320;
    const p = this.baseParams;
    const sens = Math.max(0.2, this.s.sensitivity);
    return {
      ...p,
      inlierThresholdPx: p.inlierThresholdPx * k,
      maxRmsPx: p.maxRmsPx * k,
      noiseFloorPx: p.noiseFloorPx * k,
      rateLow: p.rateLow / sens,
      rateHigh: p.rateHigh / sens,
    };
  }

  private static isBlank(f: GrayFrame): boolean {
    const d = f.data;
    const step = Math.max(1, Math.floor(d.length / 4000));
    let n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < d.length; i += step) { const v = d[i]; sum += v; sum2 += v * v; n++; }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    return sd < 3.0; // covered lens / uniformly lit blank frame
  }

  private emptyMap(f: GrayFrame, note: string, blank: boolean, reset: boolean, t0: number): ApproachMap {
    const mw = Math.max(8, Math.round(f.width / 2)), mh = Math.max(6, Math.round(f.height / 2));
    return {
      width: mw, height: mh, score: new Float32Array(mw * mh), support: new Float32Array(mw * mh), t: f.t,
      debugPoints: [], debugFits: [],
      stats: { tracks: 0, fits: 0, supportedTracks: 0, windowSeconds: 0, procMs: performance.now() - t0, blank, reset, note, failReasons: {} },
    };
  }

  process(frame: GrayFrame): ApproachMap {
    const t0 = performance.now();
    const cv = this.cv;
    const { width: w, height: h } = frame;
    if (!(w >= 32 && h >= 24) || frame.data.length !== w * h) return this.emptyMap(frame, 'invalid frame', false, true, t0);

    let note = this.pendingResetNote;
    let didReset = !!note;
    this.pendingResetNote = '';

    if (w !== this.W || h !== this.H) { this.alloc(w, h); didReset = true; note = note || 'size change'; }

    if (ExpansionApproachEstimator.isBlank(frame)) {
      // covered / blank: drop all tracks (they are meaningless) and keep the baseline time so reacquisition is clean
      this.tracks = []; this.frames = []; this.lastT = NaN;
      return this.emptyMap(frame, 'blank frame — tracking suspended', true, true, t0);
    }

    let dt = NaN;
    if (!Number.isNaN(this.lastT)) {
      const v = validateFrameInterval(this.lastT, frame.t, MAX_GAP_MS);
      if (v === null) { this.tracks = []; this.frames = []; didReset = true; note = note || 'bad timestamp or long gap — tracking reset'; }
      else dt = v;
    }

    // load current frame
    this.cur.data.set(frame.data);
    this.compensateExposure(this.cur.data as Uint8Array);

    const n = ++this.frameNo;
    if (this.tracks.length > 0 && this.frames.length > 0) this.trackStep(n, frame.t);
    this.frames.push({ n, t: frame.t });
    while (this.frames.length > 60) this.frames.shift();

    // replenish (also immediately when support drops)
    this.framesSinceDetect++;
    const target = CELLS_X * CELLS_Y * TARGET_PER_CELL;
    if (this.tracks.length < 0.75 * target || this.framesSinceDetect >= 3) this.detect(n, frame.t);

    // swap buffers: cur becomes prev
    const tmp = this.prev; this.prev = this.cur; this.cur = tmp;
    this.lastT = frame.t;

    const map = this.estimate(frame, n, dt, t0);
    this.lastProcMs = map.stats.procMs;
    if (didReset) { map.stats.reset = true; map.stats.note = note; }
    return map;
  }

  /** Global gain compensation so auto-exposure / a hand shadowing the lens does not violate brightness constancy. */
  private compensateExposure(d: Uint8Array) {
    const step = Math.max(1, Math.floor(d.length / 4000));
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += step) { sum += d[i]; n++; }
    const mean = sum / Math.max(1, n);
    if (!(mean > 8)) return;
    if (!Number.isFinite(this.refMean)) { this.refMean = mean; return; }
    const gain = this.refMean / mean;
    if (gain < 0.6 || gain > 1.6) { this.refMean = mean; return; }
    if (Math.abs(gain - 1) < 0.02) return;
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round(v * gain));
    for (let i = 0; i < d.length; i++) d[i] = lut[d[i]];
  }

  /** forward LK + backward validation; updates track histories, drops unreliable tracks */
  private trackStep(n: number, t: number) {
    const cv = this.cv;
    const tr = this.tracks;
    const N = tr.length;
    if (N === 0) return;
    const p0 = new cv.Mat(N, 1, cv.CV_32FC2);
    for (let i = 0; i < N; i++) { p0.data32F[2 * i] = tr[i].x; p0.data32F[2 * i + 1] = tr[i].y; }
    const p1 = new cv.Mat(), st = new cv.Mat(), err = new cv.Mat();
    const pb = new cv.Mat(), stb = new cv.Mat(), errb = new cv.Mat();
    const win = new cv.Size(21, 21);
    const crit = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 20, 0.03);
    try {
      cv.calcOpticalFlowPyrLK(this.prev, this.cur, p0, p1, st, err, win, 3, crit, 0, 1e-4);
      cv.calcOpticalFlowPyrLK(this.cur, this.prev, p1, pb, stb, errb, win, 3, crit, 0, 1e-4);
      const keep: Track[] = [];
      const fbMax = 0.8 * (this.s.procWidth / 320);
      const maxMove = 0.25 * this.W;
      for (let i = 0; i < N; i++) {
        const x1 = p1.data32F[2 * i], y1 = p1.data32F[2 * i + 1];
        const bx = pb.data32F[2 * i], by = pb.data32F[2 * i + 1];
        const ok =
          st.data[i] === 1 && stb.data[i] === 1 &&
          Number.isFinite(x1 + y1 + bx + by) &&
          Math.hypot(bx - tr[i].x, by - tr[i].y) <= fbMax &&
          Math.hypot(x1 - tr[i].x, y1 - tr[i].y) <= maxMove &&
          x1 >= BORDER / 2 && y1 >= BORDER / 2 && x1 < this.W - BORDER / 2 && y1 < this.H - BORDER / 2 &&
          err.data32F[i] < 30;
        if (ok) {
          const T = tr[i];
          T.x = x1; T.y = y1;
          T.hist.push({ f: n, x: x1, y: y1 });
          if (T.hist.length > 40) T.hist.shift();
          keep.push(T);
        }
      }
      this.tracks = keep;
    } finally {
      for (const m of [p0, p1, st, err, pb, stb, errb]) m.delete();
      // Size/TermCriteria are plain embind objects; delete if available
      (win as any).delete?.(); (crit as any).delete?.();
    }
  }

  /** Shi-Tomasi detection per grid cell, excluding areas already covered by tracks */
  private detect(n: number, t: number) {
    const cv = this.cv;
    this.framesSinceDetect = 0;
    const W = this.W, H = this.H;
    this.mask.setTo(new cv.Scalar(255));
    const md = this.mask.data as Uint8Array;
    // border exclusion
    for (let y = 0; y < H; y++) {
      const edgeRow = y < BORDER || y >= H - BORDER;
      for (let x = 0; x < W; x++) if (edgeRow || x < BORDER || x >= W - BORDER) md[y * W + x] = 0;
    }
    const counts = new Int32Array(CELLS_X * CELLS_Y);
    const cw = W / CELLS_X, ch = H / CELLS_Y;
    const col = new cv.Scalar(0);
    for (const T of this.tracks) {
      cv.circle(this.mask, new cv.Point(Math.round(T.x), Math.round(T.y)), MIN_FEATURE_DIST, col, -1);
      const cx = Math.min(CELLS_X - 1, Math.max(0, Math.floor(T.x / cw)));
      const cy = Math.min(CELLS_Y - 1, Math.max(0, Math.floor(T.y / ch)));
      counts[cy * CELLS_X + cx]++;
    }
    for (let cy = 0; cy < CELLS_Y; cy++) {
      for (let cx = 0; cx < CELLS_X; cx++) {
        const deficit = TARGET_PER_CELL - counts[cy * CELLS_X + cx];
        if (deficit < 2) continue;
        const x0 = Math.floor(cx * cw), y0 = Math.floor(cy * ch);
        const x1 = Math.min(W, Math.floor((cx + 1) * cw)), y1 = Math.min(H, Math.floor((cy + 1) * ch));
        const rect = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
        const roi = this.cur.roi(rect), mroi = this.mask.roi(rect);
        const corners = new cv.Mat();
        try {
          cv.goodFeaturesToTrack(roi, corners, deficit, 0.008, MIN_FEATURE_DIST, mroi, 5, false, 0.04);
          for (let i = 0; i < corners.rows; i++) {
            const x = corners.data32F[2 * i] + x0, y = corners.data32F[2 * i + 1] + y0;
            if (!Number.isFinite(x + y)) continue;
            this.tracks.push({
              id: this.nextId++, x, y, hist: [{ f: n, x, y }], rate: 0, sig: 0, fastEv: 0, strongT: 0, conf: 0, lastSupportT: -1e9, supportedNow: false,
            });
          }
        } finally { roi.delete(); mroi.delete(); corners.delete(); (rect as any).delete?.(); }
      }
    }
  }

  private estimate(frame: GrayFrame, n: number, dt: number, t0: number): ApproachMap {
    const W = this.W, H = this.H;
    const params = this.params();
    const tNow = frame.t;
    const mw = Math.round(W / 2), mh = Math.round(H / 2);
    const score = new Float32Array(mw * mh), support = new Float32Array(mw * mh);
    const debugFits: DebugFit[] = [];
    let nFits = 0;

    for (const T of this.tracks) T.supportedNow = false;
    this.turnDegPerSec = 0;
    // per-track evidence over all (window, radius) scales: max, so a short window can catch a punch and a long one a slow approach
    const acc = new Map<Track, { w: number; wr: number; ws: number; conf: number }>(); // ws = weighted sum of sigmaRate
    const failReasons: Record<string, number> = {};
    const NONCOHERENT = new Set(['high-residual', 'anisotropic', 'reflection', 'low-inlier-fraction', 'implausible-scale']);
    let winSec = 0;
    const slow = this.lastProcMs > 60 && n % 4 !== 0; // adaptive cost: long windows only every 4th frame when frames get slow
    const windows = Array.from(new Set([50, 100, this.s.windowMs, ...(slow ? [] : [500, 1000])])).sort((x, y) => x - y);
    for (const wMs of windows) {
      let ref: { n: number; t: number } | null = null;
      const want = tNow - wMs;
      for (const fr of this.frames) {
        if (fr.n === n || tNow - fr.t < 0.6 * wMs) continue;
        if (!ref || Math.abs(fr.t - want) < Math.abs(ref.t - want)) ref = fr;
      }
      if (!ref) continue;
      const dtw = (tNow - ref.t) / 1000;
      if (wMs === this.s.windowMs) winSec = dtw;
      const corr: Correspondence[] = [];
      const owners: Track[] = [];
      for (const T of this.tracks) {
        let hs: { f: number; x: number; y: number } | undefined;
        for (let i = T.hist.length - 1; i >= 0; i--) if (T.hist[i].f === ref.n) { hs = T.hist[i]; break; }
        if (!hs) continue;
        corr.push({ id: owners.length, px: hs.x, py: hs.y, qx: T.x, qy: T.y });
        owners.push(T);
      }
      if (corr.length < params.minPoints) continue;
      if (this.s.derotate) {
        const dr = derotate(corr, W, H, focalFromHfov(W, this.s.hfovDeg), 1.5 * (this.s.procWidth / 320));
        if (dr.n >= 12 && dtw > 0 && dtw <= 0.35) {
          const rate = (Math.hypot(dr.omega[0], dr.omega[1], dr.omega[2]) / dtw) * (180 / Math.PI);
          if (Number.isFinite(rate)) this.turnDegPerSec = Math.max(this.turnDegPerSec, rate);
        }
      }
      for (const radFrac of wMs >= 500 ? [0.11] : [0.06, 0.11]) {
        const R = radFrac * W;
        const spacing = 0.7 * R;
        const bs = R;
        const bw = Math.ceil(W / bs), bh = Math.ceil(H / bs);
        const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
        corr.forEach((c, i) => {
          const bx = Math.min(bw - 1, Math.max(0, Math.floor(c.qx / bs)));
          const by = Math.min(bh - 1, Math.max(0, Math.floor(c.qy / bs)));
          buckets[by * bw + bx].push(i);
        });
        for (let cy = spacing / 2; cy < H; cy += spacing) {
          for (let cx = spacing / 2; cx < W; cx += spacing) {
            const pts: Correspondence[] = [];
            const b0x = Math.max(0, Math.floor((cx - R) / bs)), b1x = Math.min(bw - 1, Math.floor((cx + R) / bs));
            const b0y = Math.max(0, Math.floor((cy - R) / bs)), b1y = Math.min(bh - 1, Math.floor((cy + R) / bs));
            for (let by = b0y; by <= b1y; by++) for (let bx = b0x; bx <= b1x; bx++) {
              for (const i of buckets[by * bw + bx]) {
                const c = corr[i];
                if ((c.qx - cx) ** 2 + (c.qy - cy) ** 2 <= R * R) pts.push(c);
              }
            }
            let rest = pts;
            for (let layer = 0; layer < 2 && rest.length >= params.minPoints; layer++) {
              const fit = fitLocalExpansion(rest, R, dtw, params, 1000 + layer);
              if (fit.status !== 'ok') {
                failReasons[fit.reason] = (failReasons[fit.reason] ?? 0) + 1;
                // tracking was fine but motion is not coherent expansion (e.g. waving, deforming hand): valid, dark
                if (layer === 0 && NONCOHERENT.has(fit.reason)) {
                  for (const c of rest) {
                    const T = owners[c.id];
                    const a = acc.get(T);
                    if (!a) acc.set(T, { w: 0.4, wr: 0, ws: 0, conf: 0.4 });
                    else { a.w += 0.4; }
                  }
                }
                break;
              }
              nFits++;
              debugFits.push({ x: fit.cx / W, y: fit.cy / H, r: R / W, rate: fit.rate, confidence: fit.confidence, evidence: fit.evidence });
              if (fit.confidence >= 0.12) {
                for (const id of fit.inlierIds) {
                  const T = owners[id];
                  // confidence-weighted MEAN of the signed rate over all scales (not a maximum: no multiple-testing bias)
                  const r = Math.max(-8, Math.min(8, fit.rate));
                  const a = acc.get(T) ?? { w: 0, wr: 0, ws: 0, conf: 0 };
                  a.w += fit.confidence; a.wr += fit.confidence * r; a.ws += fit.confidence * fit.sigmaRate; a.conf = Math.max(a.conf, fit.confidence);
                  acc.set(T, a);
                }
              }
              const inl = new Set(fit.inlierIds);
              rest = rest.filter((c) => !inl.has(c.id));
            }
          }
        }
      }
    }
    // temporal filtering bound to individual tracks (dies with the track)
    const alpha = 1 - Math.exp(-(Number.isFinite(dt) ? dt * 1000 : 33) / Math.max(20, this.s.smoothingMs));
    const dts = Number.isFinite(dt) ? dt : 0.033;
    // scene-wide expansion (camera moving forward, floor, walls): weighted median of per-track observed rates
    let baseline = 0;
    if (this.s.egoComp) {
      const rs: { r: number; w: number }[] = [];
      for (const [, a] of acc) if (a.w > 0.3) rs.push({ r: a.wr / a.w, w: a.w });
      if (rs.length >= 15) {
        rs.sort((x, y) => x.r - y.r);
        const tot = rs.reduce((q, x) => q + x.w, 0);
        let c = 0;
        for (const x of rs) { c += x.w; if (c >= tot / 2) { baseline = Math.max(0, x.r); break; } }
      }
    }
    this.baselineNow = baseline;
    const neff = Math.max(1, (2 - alpha) / Math.max(alpha, 1e-3)); // effective number of independent samples in the EMA
    const seen = new Set<Track>();
    for (const [T, a] of acc) {
      if (a.w <= 0) continue;
      seen.add(T);
      const rateObs = a.wr / a.w - baseline, sigObs = a.ws / a.w;
      const inst = smoothstep(params.rateLow, params.rateHigh, rateObs) * smoothstep(params.zLow, params.zHigh, rateObs / Math.max(1e-6, sigObs)) * smoothstep(0.1, 0.55, a.conf);
      T.rate += alpha * (rateObs - T.rate);
      // fast attack only if strong evidence is sustained AND the slower filtered rate agrees in sign/magnitude (kills oscillation)
      if (inst > 0.6 && T.rate >= 1.5 * params.rateLow) T.strongT += dts; else T.strongT = 0;
      if (T.strongT >= 0.14) T.fastEv = Math.max(T.fastEv, inst); else T.fastEv *= Math.exp(-dts / 0.15);
      T.sig = T.sig === 0 ? a.ws / a.w : T.sig + alpha * (a.ws / a.w - T.sig);
      T.lastSupportT = tNow;
      T.conf = clamp01(a.conf);
      T.supportedNow = true;
    }
    for (const T of this.tracks) {
      if (!seen.has(T)) { T.fastEv *= Math.exp(-dts / 0.15); T.strongT = 0; }
      if (!seen.has(T) && tNow - T.lastSupportT <= HOLD_MS) T.supportedNow = true; // brief hold through fit dropouts
    }

    // splat supported tracks to map
    const sigma = (0.075 * W / 2) * 0.55; // in map px
    const rad = Math.ceil(2.2 * sigma);
    const sw = new Float32Array(mw * mh), sv = new Float32Array(mw * mh);
    const depth = this.s.useDepthGate ? this.depth : null;
    const debugPoints: DebugPoint[] = [];
    let supportedTracks = 0;
    const sampleDepthPre = (nx: number, ny: number): number => {
      const d = this.depth;
      if (!d) return 1;
      const dx = Math.min(d.width - 1, Math.max(0, Math.floor(nx * d.width)));
      const dy = Math.min(d.height - 1, Math.max(0, Math.floor(ny * d.height)));
      return d.data[dy * d.width + dx];
    };
    const sampleDepth = (nx: number, ny: number): number => {
      if (!depth) return 0;
      const dx = Math.min(depth.width - 1, Math.max(0, Math.floor(nx * depth.width)));
      const dy = Math.min(depth.height - 1, Math.max(0, Math.floor(ny * depth.height)));
      return depth.data[dy * depth.width + dx];
    };
    for (const T of this.tracks) {
      const nearT = this.depth && this.s.useDepthGate && this.s.nearThreshold > 0 ? sampleDepthPre(T.x / W, T.y / H) : 1;
      let shown = nearT < this.s.nearThreshold ? 0 : Math.max(T.fastEv, smoothstep(params.rateLow, params.rateHigh, T.rate) * smoothstep(params.zLow, params.zHigh, T.rate / Math.max(1e-6, T.sig / Math.sqrt(neff))) * smoothstep(0.1, 0.55, T.conf));
      if (this.s.maxTurnDegPerSec > 0 && shown > 0) {
        // while the camera turns fast, parallax / blur / residual rotation fake expansion: fade evidence out
        shown *= 1 - smoothstep(this.s.maxTurnDegPerSec, this.s.maxTurnDegPerSec * 1.6, this.turnDegPerSec);
      }
      if (this.s.pathGate && shown > 0) {
        // geometry uses the full (not baseline-subtracted) rate: that is what sets the distance
        const pf = pathFactor(T.x - W / 2, T.y - H / 2, Math.max(1e-3, T.rate + this.baselineNow), focalFromHfov(W, this.s.hfovDeg), { ...DEFAULT_PATH_GATE, speed: this.s.walkSpeed, halfWidthStart: this.s.pathHalfWidth, halfWidthEnd: this.s.pathHalfWidth + 0.5 });
        shown *= pf;
      }
      debugPoints.push({ x: T.x / W, y: T.y / H, supported: T.supportedNow, score: shown });
      if (!T.supportedNow) continue;
      supportedTracks++;
      const tx = T.x / 2, ty = T.y / 2;
      const dT = depth ? sampleDepth(T.x / W, T.y / H) : 0;
      const x0 = Math.max(0, Math.floor(tx - rad)), x1 = Math.min(mw - 1, Math.ceil(tx + rad));
      const y0 = Math.max(0, Math.floor(ty - rad)), y1 = Math.min(mh - 1, Math.ceil(ty + rad));
      const age = tNow - T.lastSupportT;
      const hold = age <= 0 ? 1 : 1 - age / (HOLD_MS * 1.5);
      const base = Math.max(0.25, T.conf) * hold;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = (x + 0.5 - tx) ** 2 + (y + 0.5 - ty) ** 2;
        let wgt = Math.exp(-d2 / (2 * sigma * sigma)) * base;
        if (depth) {
          const dp = sampleDepth((x + 0.5) / mw, (y + 0.5) / mh) - dT;
          wgt *= Math.exp(-(dp * dp) / (2 * 0.18 * 0.18));
        }
        const i = y * mw + x;
        sw[i] += wgt; sv[i] += wgt * shown;
      }
    }
    for (let i = 0; i < sw.length; i++) {
      if (sw[i] > 1e-3) { score[i] = sv[i] / sw[i]; support[i] = clamp01(sw[i] / 0.6); }
    }

    return {
      width: mw, height: mh, score, support, t: tNow, debugPoints, debugFits,
      stats: {
        tracks: this.tracks.length, fits: nFits, supportedTracks, windowSeconds: winSec,
        procMs: performance.now() - t0, blank: false, reset: false, note: this.frames.length > 2 ? (this.baselineNow > 0.08 ? `scene-wide expansion ${this.baselineNow.toFixed(2)}/s removed` : '') : 'warming up', failReasons,
      },
    };
  }
}
