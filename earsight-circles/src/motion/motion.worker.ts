/// <reference lib="webworker" />
import { loadOpenCV } from './opencv';
import { CircleApproachEstimator } from '../circles/estimator';
import type { ApproachEstimator, ApproachMap, DepthHint, GrayFrame, MotionSettings } from './types';

export type MotionInMsg =
  | { type: 'init' }
  | { type: 'configure'; settings: Partial<MotionSettings> }
  | { type: 'depth'; depth: DepthHint | null }
  | { type: 'reset' }
  | { type: 'frame'; frame: GrayFrame };

export type MotionOutMsg =
  | { type: 'ready'; opencv: string }
  | { type: 'error'; message: string }
  | { type: 'result'; map: ApproachMap; /** worker-side wall time */ procMs: number };

const post = (m: MotionOutMsg, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let est: ApproachEstimator | null = null;

self.onmessage = async (e: MessageEvent<MotionInMsg>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        const { cv } = await loadOpenCV();
        est = new CircleApproachEstimator(cv);
        await est.init();
        post({ type: 'ready', opencv: String(cv.getBuildInformation ? 'OpenCV.js (WASM) ready' : 'OpenCV.js ready') });
        break;
      }
      case 'configure': est?.configure(m.settings); break;
      case 'depth': est?.setDepth(m.depth); break;
      case 'reset': est?.reset(); break;
      case 'frame': {
        if (!est) break;
        const t0 = performance.now();
        const map = est.process(m.frame);
        post({ type: 'result', map, procMs: performance.now() - t0 }, [map.score.buffer, map.support.buffer]);
        break;
      }
    }
  } catch (err: any) {
    post({ type: 'error', message: String(err?.message ?? err) });
  }
};
