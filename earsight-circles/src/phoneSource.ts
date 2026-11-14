import type { FrameInfo } from './camera';

/**
 * Laptop-side receiver for the phone camera. Frames arrive as [float64 phone capture time][JPEG].
 * Phone timestamps are mapped to the laptop clock with offset = min(receive - phoneTime) over a sliding window
 * (i.e. assuming the fastest recent frame had the minimum network delay), so network jitter does not corrupt the
 * elapsed-time maths of the approach estimator.
 */
export class PhoneSource {
  readonly canvas = document.createElement('canvas');
  width = 640;
  height = 480;
  status: 'connecting' | 'waiting' | 'connected' | 'lost' = 'connecting';
  frames = 0;
  onStatus: (s: PhoneSource['status']) => void = () => {};
  private ws: WebSocket | null = null;
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private offsets: number[] = [];
  private decoding = false;
  private lastT = 0;

  constructor(readonly room: string) {}

  start(cb: (info: FrameInfo) => void) {
    const ws = new WebSocket(`wss://${location.host}/relay?room=${this.room}&role=laptop`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.set('waiting');
    ws.onclose = () => this.set('lost');
    ws.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        if (e.data === 'phone-connected') this.set('connected');
        else if (e.data === 'phone-left') this.set('waiting');
        return;
      }
      if (this.decoding) return; // drop, never queue
      this.decoding = true;
      try {
        const buf = e.data as ArrayBuffer;
        if (buf.byteLength < 100) return;
        const tPhone = new DataView(buf).getFloat64(0);
        const now = performance.now();
        this.offsets.push(now - tPhone);
        if (this.offsets.length > 150) this.offsets.shift();
        const off = Math.min(...this.offsets);
        let t = tPhone + off;
        if (!(t > this.lastT)) t = this.lastT + 1; // keep strictly increasing
        this.lastT = t;
        const bmp = await createImageBitmap(new Blob([buf.slice(8)], { type: 'image/jpeg' }));
        if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) { this.canvas.width = bmp.width; this.canvas.height = bmp.height; }
        this.width = bmp.width; this.height = bmp.height;
        this.ctx.drawImage(bmp, 0, 0);
        bmp.close();
        this.frames++;
        this.set('connected');
        cb({ tCapture: Math.min(t, now), tCallback: now, fromMetadata: true });
      } catch (err) {
        console.warn('phone frame decode failed', err);
      } finally { this.decoding = false; }
    };
  }

  private set(s: PhoneSource['status']) { if (this.status !== s) { this.status = s; this.onStatus(s); } }

  stop() { this.ws?.close(); this.ws = null; }
}
