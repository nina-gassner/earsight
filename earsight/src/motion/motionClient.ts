import type { ApproachMap, DepthHint, MotionSettings } from './types';
import type { MotionInMsg, MotionOutMsg } from './motion.worker';

export interface MotionClientEvents {
  onReady(): void;
  onError(msg: string): void;
  onMap(map: ApproachMap, workerMs: number, tResult: number): void;
}

/** Owns the motion worker; one frame in flight at a time, newer frames are dropped (not queued). */
export class MotionClient {
  private worker: Worker;
  ready = false;
  private inFlight = false;
  private lastSent = 0;
  private watchdog = 0;

  constructor(private ev: MotionClientEvents) {
    this.worker = new Worker(new URL('./motion.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<MotionOutMsg>) => {
      const m = e.data;
      if (m.type === 'ready') { this.ready = true; ev.onReady(); }
      else if (m.type === 'error') { this.inFlight = false; ev.onError(m.message); }
      else if (m.type === 'result') { this.inFlight = false; ev.onMap(m.map, m.procMs, performance.now()); }
    };
    this.worker.onerror = (e) => ev.onError('Motion worker crashed: ' + (e.message || 'could not load/start the worker script') + (e.filename ? ` (${e.filename}:${e.lineno})` : '') + ' — try reloading the page; in dev mode a first load can fail while dependencies are optimised.');
    this.worker.onmessageerror = () => ev.onError('Motion worker sent an unreadable message');
    this.send({ type: 'init' });
  }

  private send(m: MotionInMsg, transfer: Transferable[] = []) { this.worker.postMessage(m, transfer); }
  get busy() {
    // safety: if a result never comes back, do not stall forever
    if (this.inFlight && performance.now() - this.lastSent > 5000) this.inFlight = false;
    return this.inFlight;
  }
  configure(settings: Partial<MotionSettings>) { this.send({ type: 'configure', settings }); }
  setDepth(depth: DepthHint | null) { this.send({ type: 'depth', depth }); }
  reset() { this.send({ type: 'reset' }); }
  offer(gray: Uint8Array, width: number, height: number, t: number): boolean {
    if (!this.ready || this.busy) return false;
    this.inFlight = true;
    this.lastSent = performance.now();
    this.send({ type: 'frame', frame: { data: gray, width, height, t } }, [gray.buffer]);
    return true;
  }
  dispose() { clearTimeout(this.watchdog); this.worker.terminate(); }
}
