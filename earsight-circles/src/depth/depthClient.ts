import { DepthNormalizer } from './normalizer';
import type { DepthBackend, DepthInMsg, DepthOutMsg } from './protocol';

export interface DepthFrame {
  /** relative closeness 0..1 (closer = larger) */
  closeness: Float32Array;
  width: number;
  height: number;
  /** capture timestamp of the source frame (ms, performance.now clock) */
  tCapture: number;
  /** when the result arrived on the main thread */
  tResult: number;
  inferMs: number;
  rawMin: number;
  rawMax: number;
  lo: number;
  hi: number;
}

export interface DepthClientEvents {
  onProgress(pct: number, text: string): void;
  onReady(backend: DepthBackend, dtype: string): void;
  onError(msg: string, fatal: boolean): void;
  onFrame(f: DepthFrame): void;
}

/** Owns the depth worker. At most one inference is in flight; callers simply offer the freshest frame. */
export class DepthClient {
  private worker: Worker;
  private ev: DepthClientEvents;
  readonly normalizer = new DepthNormalizer();
  ready = false;
  private inFlight = false;
  private nextId = 1;
  private files = new Map<string, { loaded: number; total: number }>();

  constructor(ev: DepthClientEvents) {
    this.ev = ev;
    this.worker = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<DepthOutMsg>) => this.onMsg(e.data);
    this.worker.onerror = (e) => ev.onError('Depth worker crashed: ' + (e.message || 'unknown error'), true);
  }

  private send(m: DepthInMsg, transfer: Transferable[] = []) { this.worker.postMessage(m, transfer); }

  init(backend: DepthBackend, inputSize: number) { this.send({ type: 'init', backend, inputSize }); }
  setSize(inputSize: number) { this.send({ type: 'setSize', inputSize }); }
  get busy() { return this.inFlight; }

  /** Returns false (and drops the frame) if an inference is already running or the model is not ready. */
  offer(rgba: ArrayBuffer, width: number, height: number, tCapture: number): boolean {
    if (!this.ready || this.inFlight) return false;
    this.inFlight = true;
    this.send({ type: 'infer', id: this.nextId++, rgba, width, height, tCapture }, [rgba]);
    return true;
  }

  private onMsg(m: DepthOutMsg) {
    switch (m.type) {
      case 'progress': {
        if (m.total > 0) this.files.set(m.file, { loaded: m.loaded, total: m.total });
        let l = 0, t = 0;
        for (const v of this.files.values()) { l += v.loaded; t += v.total; }
        this.ev.onProgress(t ? (100 * l) / t : 0, t ? `Downloading model: ${(l / 1e6).toFixed(1)} / ${(t / 1e6).toFixed(1)} MB` : 'Preparing…');
        break;
      }
      case 'status': this.ev.onProgress(-1, m.text); break;
      case 'ready': this.ready = true; this.ev.onReady(m.backend, m.dtype); break;
      case 'error': this.inFlight = false; this.ev.onError(m.message, m.fatal); break;
      case 'result': {
        this.inFlight = false;
        const tResult = performance.now();
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < m.raw.length; i += 7) { const v = m.raw[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const { lo, hi } = this.normalizer.update(m.raw, m.tCapture);
        const closeness = this.normalizer.closeness(m.raw);
        this.ev.onFrame({ closeness, width: m.width, height: m.height, tCapture: m.tCapture, tResult, inferMs: m.inferMs, rawMin: mn, rawMax: mx, lo, hi });
        break;
      }
    }
  }

  dispose() { this.worker.terminate(); }
}
