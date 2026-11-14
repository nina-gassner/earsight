/**
 * Flicker protection for the sound: debounce (evidence must be present in `onCount` consecutive updates), hysteresis
 * (on above onLevel, stays on above offLevel), hold-off (short dropouts are bridged) and smoothing of the levels.
 */
export interface GateOptions { onCount: number; holdMs: number; onLevel: number; offLevel: number; alpha: number }
export const DEFAULT_GATE: GateOptions = { onCount: 2, holdMs: 300, onLevel: 0.12, offLevel: 0.05, alpha: 0.5 };

export class SoundGate {
  on = false;
  private count = 0;
  private lastActive = 0;
  private l = 0;
  private r = 0;
  private extra = new Map<string, number>();
  constructor(private o: GateOptions = DEFAULT_GATE) {}

  reset() { this.on = false; this.count = 0; this.l = this.r = 0; this.extra.clear(); }

  /** call once per fresh evidence update; returns the stabilised per-ear levels (0 while the gate is closed) */
  step(left: number, right: number, nowMs: number): { left: number; right: number } {
    const lvl = Math.max(left, right);
    if (!this.on) {
      this.count = lvl >= this.o.onLevel ? this.count + 1 : 0;
      if (this.count >= this.o.onCount) { this.on = true; this.lastActive = nowMs; }
    } else if (lvl >= this.o.offLevel) {
      this.lastActive = nowMs;
    } else if (nowMs - this.lastActive > this.o.holdMs) {
      this.on = false; this.count = 0;
    }
    if (!this.on) { this.l = this.r = 0; return { left: 0, right: 0 }; }
    // while bridging a short dropout keep decaying toward the (low) input instead of cutting abruptly
    this.l += this.o.alpha * (left - this.l);
    this.r += this.o.alpha * (right - this.r);
    return { left: this.l, right: this.r };
  }

  /** exponential smoothing of an auxiliary value (e.g. closeness used for the beep rate) */
  smoothValue(key: string, v: number): number {
    const prev = this.extra.get(key);
    const out = prev === undefined ? v : prev + this.o.alpha * (v - prev);
    this.extra.set(key, out);
    return out;
  }
}
