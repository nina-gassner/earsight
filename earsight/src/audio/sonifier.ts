/**
 * Beep sonifier. Short beeps in the left/right ear (loudness per ear follows where the bright regions are).
 * Beep repetition rate rises as the object gets closer (and pitch rises slightly). Needs a user gesture to start.
 */
export const MIN_RATE_HZ = 4;
export const MAX_RATE_HZ = 30;

/** urgency 0..1 (closeness or approach strength, whichever is larger) -> beeps per second; steep so approach sounds urgent */
export function rateFromCloseness(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return MIN_RATE_HZ + (MAX_RATE_HZ - MIN_RATE_HZ) * Math.sqrt(x);
}

export class Sonifier {
  private ctx: AudioContext | null = null;
  private merger: ChannelMergerNode | null = null;
  private master: GainNode | null = null;
  private timer = 0;
  private nextBeep = 0;
  private left = 0;
  private right = 0;
  private rate = 0;
  private closeness = 0;
  private lastUpdate = 0;
  private wasSilent = true;
  volume = 0.5;

  /** call from a click/change handler (autoplay policy) */
  async enable() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const merger = ctx.createChannelMerger(2);
      const master = ctx.createGain();
      master.gain.value = this.volume * 0.5;
      merger.connect(master); master.connect(ctx.destination);
      this.ctx = ctx; this.merger = merger; this.master = master;
      this.timer = window.setInterval(() => this.tick(), 15);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.05);
  }

  /** rate in Hz (0 = silent), left/right 0..1 loudness per ear, closeness 0..1 sets pitch */
  update(left: number, right: number, rate: number, closeness: number) {
    this.left = left; this.right = right; this.rate = rate; this.closeness = closeness;
    this.lastUpdate = performance.now();
  }

  silence() { this.left = this.right = 0; this.rate = 0; }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || !this.merger) return;
    const now = ctx.currentTime;
    const stale = performance.now() - this.lastUpdate > 400; // stalled pipeline / stopped source -> silence
    if (stale || this.rate <= 0 || Math.max(this.left, this.right) < 0.05) { this.wasSilent = true; return; }
    if (this.wasSilent) { this.wasSilent = false; this.nextBeep = now; } // onset: beep immediately
    if (now < this.nextBeep) return;
    this.beep(now, Math.min(0.07, 0.6 / this.rate));
    this.nextBeep = now + 1 / this.rate;
  }

  private beep(t: number, dur: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 600 + 500 * this.closeness;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const gl = ctx.createGain(), gr = ctx.createGain();
    gl.gain.value = this.left; gr.gain.value = this.right;
    osc.connect(env); env.connect(gl); env.connect(gr);
    gl.connect(this.merger!, 0, 0); gr.connect(this.merger!, 0, 1);
    osc.start(t); osc.stop(t + dur + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); gl.disconnect(); gr.disconnect(); };
  }

  async disable() {
    clearInterval(this.timer);
    this.silence();
    await this.ctx?.close();
    this.ctx = this.merger = this.master = null;
  }

  get active() { return this.ctx !== null; }
}
