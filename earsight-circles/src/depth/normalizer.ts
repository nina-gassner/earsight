/**
 * Display normalisation of Depth Anything V2 raw output.
 *
 * The network outputs *relative inverse depth* (disparity-like, affine-invariant): larger raw value = closer
 * (confirmed empirically with scripts/inspect-depth.mjs — see README). It is NOT metric distance and its scale/shift
 * changes from frame to frame, so for display we map robust percentile bounds [lo, hi] to [0, 1].
 * Only the *bounds* are smoothed over time (exponential, time-constant based); the spatial map of each frame is
 * never averaged with other frames, so there are no motion trails.
 */
export interface NormalizerSettings {
  pLow: number; // percentile, e.g. 2
  pHigh: number; // percentile, e.g. 98
  /** time constant (ms) for smoothing the bounds; 0 = no smoothing */
  boundsSmoothingMs: number;
  /** if the model output turned out to be farther-is-larger, flip */
  invert: boolean;
}

export const DEFAULT_NORMALIZER: NormalizerSettings = { pLow: 2, pHigh: 98, boundsSmoothingMs: 1500, invert: false };

export function percentileBounds(raw: ArrayLike<number>, pLow: number, pHigh: number, maxSamples = 20000): [number, number] {
  const n = raw.length;
  if (n === 0) return [0, 1];
  const step = Math.max(1, Math.floor(n / maxSamples));
  const s: number[] = [];
  for (let i = 0; i < n; i += step) { const v = raw[i]; if (Number.isFinite(v)) s.push(v); }
  if (s.length === 0) return [0, 1];
  s.sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
  return [at(pLow), at(pHigh)];
}

export class DepthNormalizer {
  settings: NormalizerSettings;
  lo = 0;
  hi = 1;
  private init = false;
  private lastT = 0;

  constructor(settings: Partial<NormalizerSettings> = {}) { this.settings = { ...DEFAULT_NORMALIZER, ...settings }; }

  reset() { this.init = false; }

  /** update smoothed bounds with a new raw map; returns the bounds used */
  update(raw: ArrayLike<number>, tMs: number): { lo: number; hi: number } {
    const [lo, hi] = percentileBounds(raw, this.settings.pLow, this.settings.pHigh);
    const tau = this.settings.boundsSmoothingMs;
    if (!this.init || tau <= 0 || !(tMs > this.lastT) || tMs - this.lastT > 5000) {
      this.lo = lo; this.hi = hi; this.init = true;
    } else {
      const a = 1 - Math.exp(-(tMs - this.lastT) / tau);
      this.lo += a * (lo - this.lo);
      this.hi += a * (hi - this.hi);
    }
    this.lastT = tMs;
    return { lo: this.lo, hi: this.hi };
  }

  /** closeness in 0..1 (1 = closest) */
  closeness(raw: ArrayLike<number>, out: Float32Array = new Float32Array(raw.length)): Float32Array {
    const span = Math.max(1e-6, this.hi - this.lo);
    const inv = this.settings.invert;
    for (let i = 0; i < raw.length; i++) {
      let v = (raw[i] - this.lo) / span;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      out[i] = inv ? 1 - v : v;
    }
    return out;
  }
}
