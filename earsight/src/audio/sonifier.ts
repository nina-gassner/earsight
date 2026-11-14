/**
 * Beep sonifier. Short beeps in the left/right ear (loudness per ear follows where the bright regions are).
 * Beep repetition rate and loudness rise as the object gets closer; pitch follows the height of the object (up = high). Needs a user gesture to start.
 */
export const MIN_RATE_HZ = 2;
export const MAX_RATE_HZ = 36;

/** urgency 0..1 (closeness or approach strength, whichever is larger) -> beeps per second; steep so approach sounds urgent */
export function rateFromCloseness(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return MIN_RATE_HZ + (MAX_RATE_HZ - MIN_RATE_HZ) * x ** 0.9; // nearly linear: a clear step in rate for every step in closeness
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** how much louder than the old default the master output is (a limiter after the master gain prevents clipping) */
export const MASTER_BOOST = 4;

/** loudness 0.04..1 from closeness 0..1, squared: far things are barely audible, close things are at full level */
export function gainFromCloseness(c: number): number {
  const x = clamp01(Number.isFinite(c) ? c : 0);
  return 0.04 + 0.96 * x * x;
}

/** pitch in Hz from the vertical position of the object (0 = top of the image, 1 = bottom): high up = high tone, 2.5 octaves */
export function pitchFromHeight(y: number): number {
  const up = 1 - clamp01(Number.isFinite(y) ? y : 0.5);
  return 300 * 2 ** (2.5 * up);
}

/**
 * Exaggerated left/right with a smooth transition. The balance |right-left|/(right+left) is scaled by `strength` (full one-sided
 * play once the balance reaches 1/strength), then shaped by a smoothstep S-curve: nearly centred sounds stay nearly centred
 * (someone ahead and only slightly to the left is NOT heard fully on the left), the middle range moves quickly, and the
 * sides saturate gently without a hard corner. The far ear fades along a quarter-circle (-3 dB at half way) instead of a
 * straight line. Returns per-ear gains 0..1.
 */
export function earGains(left: number, right: number, strength: number): { l: number; r: number } {
  const L = Math.max(left, right);
  if (!(L > 0)) return { l: 0, r: 0 };
  const u = clamp01((Math.abs(right - left) / (right + left)) * strength);
  const pan = u * u * (3 - 2 * u); // smoothstep: slope 0 at both ends
  const far = Math.cos(pan * Math.PI / 2);
  const s = 0.6 + 0.4 * clamp01(L); // overall strength of the evidence still matters a little
  return right > left ? { l: s * far, r: s } : { l: s, r: s * far };
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
  private height = 0.5;
  volume = 1;
  /** called with every update (used to share the audio data with another device) */
  /** no sound is played (the audio data is still produced and reported through onUpdate) */
  muted = false;
  onUpdate: ((left: number, right: number, rate: number, closeness: number, height: number) => void) | null = null;
  /** left/right exaggeration: fully one-sided once the left/right balance reaches 1/panStrength (1 = only at the extreme) */
  panStrength = 2.5;

  /** call from a click/change handler (autoplay policy) */
  async enable() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const merger = ctx.createChannelMerger(2);
      const master = ctx.createGain();
      master.gain.value = this.volume * MASTER_BOOST;
      const limiter = ctx.createDynamicsCompressor(); // loud but without clipping: fast, hard limiting near full scale
      limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.05;
      merger.connect(master); master.connect(limiter); limiter.connect(ctx.destination);
      this.ctx = ctx; this.merger = merger; this.master = master;
      this.timer = window.setInterval(() => this.tick(), 15);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v * MASTER_BOOST, this.ctx.currentTime, 0.05);
  }

  /** rate in Hz (0 = silent), left/right 0..1 loudness per ear, closeness 0..1 sets loudness, height 0 (top)..1 (bottom) sets pitch */
  update(left: number, right: number, rate: number, closeness: number, height = 0.5) {
    this.onUpdate?.(left, right, rate, closeness, height);
    this.left = left; this.right = right; this.rate = rate; this.closeness = closeness; this.height = height;
    this.lastUpdate = performance.now();
  }

  silence() { this.left = this.right = 0; this.rate = 0; }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || !this.merger) return;
    const now = ctx.currentTime;
    const stale = performance.now() - this.lastUpdate > 400; // stalled pipeline / stopped source -> silence
    if (this.muted || stale || this.rate <= 0 || Math.max(this.left, this.right) < 0.05) { this.wasSilent = true; return; }
    if (this.wasSilent) { this.wasSilent = false; this.nextBeep = now; } // onset: beep immediately
    if (now < this.nextBeep) return;
    this.beep(now, Math.min(0.07, 0.6 / this.rate));
    this.nextBeep = now + 1 / this.rate;
  }

  private beep(t: number, dur: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = pitchFromHeight(this.height);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const gl = ctx.createGain(), gr = ctx.createGain();
    const g = earGains(this.left, this.right, this.panStrength), d = gainFromCloseness(this.closeness);
    gl.gain.value = g.l * d; gr.gain.value = g.r * d;
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
