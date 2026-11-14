/**
 * Share channel: the device that sees (camera + analysis) sends the audio data and the vision data to a second device
 * (a "viewer") over the local relay. The viewer plays the beeps and draws the vision view; it needs no camera.
 *
 * Messages (sender -> viewer):
 *   text   {"t":"a","l":..,"r":..,"rate":..,"c":..,"h":..}     one sound update (left/right level, beeps per second, closeness, height)
 *   text   {"t":"cfg","mode":"settings|peripheral|light","field":45,"mirror":false,"pan":2.5}   how to present the picture
 *   binary JPEG                                                  the picture of the current mode (camera, or depth for "light")
 * Relay -> both sides: {"t":"status","sender":bool,"viewers":n}
 */
export interface ShareConfig {
  mode: 'settings' | 'peripheral' | 'light';
  field: number;
  mirror: boolean;
  pan: number;
}

export type ShareMessage =
  | { t: 'a'; l: number; r: number; rate: number; c: number; h: number }
  | ({ t: 'cfg' } & ShareConfig)
  | { t: 'status'; sender: boolean; viewers: number };

export function shareUrl(protocol: string, host: string, room: string, role: 'sender' | 'viewer'): string {
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/relay?room=${encodeURIComponent(room)}&role=${role}`;
}

export class ShareSender {
  viewers = 0;
  status: 'connecting' | 'open' | 'closed' = 'connecting';
  onChange: () => void = () => {};
  private ws: WebSocket;
  private frameTimer = 0;
  private cfgTimer = 0;
  private encoding = false;
  private small = document.createElement('canvas');

  constructor(room: string, private getConfig: () => ShareConfig, private getPicture: () => HTMLCanvasElement | null) {
    this.ws = new WebSocket(shareUrl(location.protocol, location.host, room, 'sender'));
    this.ws.onopen = () => {
      this.status = 'open';
      this.sendConfig();
      this.cfgTimer = window.setInterval(() => this.sendConfig(), 1000); // late joiners pick the settings up within a second
      this.frameTimer = window.setInterval(() => this.sendPicture(), 120); // ~8 pictures per second
      this.onChange();
    };
    this.ws.onclose = () => { this.status = 'closed'; this.stopTimers(); this.onChange(); };
    this.ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try { const m = JSON.parse(e.data) as ShareMessage; if (m.t === 'status') { this.viewers = m.viewers; this.onChange(); } } catch { /* ignore */ }
    };
  }

  private open() { return this.ws.readyState === WebSocket.OPEN; }

  private sendConfig() {
    if (this.open()) this.ws.send(JSON.stringify({ t: 'cfg', ...this.getConfig() }));
  }

  /** one sound update (called for every Sonifier.update) */
  sendAudio(l: number, r: number, rate: number, c: number, h: number) {
    if (!this.open() || this.ws.bufferedAmount > 200_000) return;
    const q = (x: number) => Math.round(x * 1000) / 1000;
    this.ws.send(JSON.stringify({ t: 'a', l: q(l), r: q(r), rate: q(rate), c: q(c), h: q(h) }));
  }

  private sendPicture() {
    const src = this.getPicture();
    if (!src || !(src.width > 0) || this.encoding || !this.open() || this.viewers === 0 || this.ws.bufferedAmount > 400_000) return;
    this.encoding = true;
    const w = Math.min(320, src.width), h = Math.max(1, Math.round((w * src.height) / src.width));
    if (this.small.width !== w || this.small.height !== h) { this.small.width = w; this.small.height = h; }
    this.small.getContext('2d')!.drawImage(src, 0, 0, w, h);
    this.small.toBlob(async (blob) => {
      try { if (blob && this.open()) this.ws.send(await blob.arrayBuffer()); } finally { this.encoding = false; }
    }, 'image/jpeg', 0.6);
  }

  private stopTimers() { clearInterval(this.frameTimer); clearInterval(this.cfgTimer); }

  close() { this.stopTimers(); this.ws.close(); }
}
