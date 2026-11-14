export const DEPTH_MODEL_ID = 'onnx-community/depth-anything-v2-small';

export type DepthBackend = 'webgpu' | 'wasm';

export type DepthInMsg =
  | { type: 'init'; backend: DepthBackend; inputSize: number }
  | { type: 'setSize'; inputSize: number }
  | { type: 'infer'; id: number; rgba: ArrayBuffer; width: number; height: number; tCapture: number };

export type DepthOutMsg =
  | { type: 'progress'; file: string; loaded: number; total: number; status: string }
  | { type: 'status'; text: string }
  | { type: 'ready'; backend: DepthBackend; dtype: string }
  | { type: 'error'; message: string; fatal: boolean }
  | {
      type: 'result';
      id: number;
      raw: Float32Array;
      width: number;
      height: number;
      tCapture: number;
      /** model inference duration incl. pre/post-processing, ms (worker side) */
      inferMs: number;
    };
