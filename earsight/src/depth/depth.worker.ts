/// <reference lib="webworker" />
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';
import { DEPTH_MODEL_ID, type DepthInMsg, type DepthOutMsg } from './protocol';

const post = (m: DepthOutMsg, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let model: any = null;
let processor: any = null;
let inputSize = 308;
let failures = 0;

env.allowLocalModels = false;
env.useBrowserCache = true; // model files are kept in the browser Cache Storage after the first download

function toFloat32(t: any): Float32Array {
  const d = t.data;
  if (d instanceof Float32Array) return d;
  if (t.type === 'float16' && d instanceof Uint16Array) {
    // some runtimes expose fp16 as raw Uint16 bits
    const out = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) {
      const h = d[i];
      const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
      out[i] = (s ? -1 : 1) * (e === 0 ? 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : Infinity) : 2 ** (e - 15) * (1 + f / 1024));
    }
    return out;
  }
  return Float32Array.from(d as ArrayLike<number>);
}

function applySize() {
  // DPTImageProcessor honours keep_aspect_ratio + ensure_multiple_of=14 itself; we only choose the target size
  // (a multiple of 14) instead of resizing tensors ourselves.
  if (processor?.image_processor) processor.image_processor.size = { width: inputSize, height: inputSize };
}

async function localModelAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${self.location.origin}/models/${DEPTH_MODEL_ID}/onnx/model_fp16.onnx`, { method: 'HEAD' });
    const ct = r.headers.get('content-type') ?? '';
    return r.ok && !ct.includes('text/html'); // a dev-server SPA fallback answers 200 with html for missing files
  } catch { return false; }
}

async function init(backend: 'webgpu' | 'wasm', size: number) {
  inputSize = size;
  if (backend === 'webgpu') {
    const gpu = (navigator as any).gpu;
    if (!gpu) throw new Error('WebGPU is not available (navigator.gpu is missing) in this browser/worker.');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter request returned null (no compatible GPU/driver, or WebGPU is disabled).');
  }
  const dtype = backend === 'webgpu' ? 'fp16' : 'q8';
  post({ type: 'status', text: `Loading ${DEPTH_MODEL_ID} (${dtype}, ${backend})…` });
  const progress_callback = (p: any) => {
    if (p?.status === 'progress' || p?.status === 'download' || p?.status === 'initiate' || p?.status === 'done') {
      post({ type: 'progress', file: p.file ?? '', loaded: p.loaded ?? 0, total: p.total ?? 0, status: p.status });
    }
  };
  // prefer a copy of the model served by this server (npm run fetch-model): far faster and more reliable on a phone than
  // huggingface.co; falls back to the normal download if it is not there
  if (backend === 'webgpu' && await localModelAvailable()) {
    env.allowLocalModels = true;
    env.localModelPath = self.location.origin + '/models/';
    post({ type: 'status', text: `Loading ${DEPTH_MODEL_ID} from this server (${dtype}, ${backend})…` });
  }
  processor = await AutoProcessor.from_pretrained(DEPTH_MODEL_ID, { progress_callback });
  model = await AutoModel.from_pretrained(DEPTH_MODEL_ID, { device: backend, dtype, progress_callback });
  applySize();
  post({ type: 'status', text: 'Warming up model…' });
  // warm up at the size of a real frame (640x480): GPU buffers and shaders are allocated now, inside init (where a
  // failure is reported cleanly), not on the first live frame
  const warm = new RawImage(new Uint8ClampedArray(640 * 480 * 4).fill(128), 640, 480, 4);
  const inputs = await processor(warm);
  const o = await model(inputs);
  o.predicted_depth?.dispose?.();
  inputs.pixel_values?.dispose?.();
  post({ type: 'ready', backend, dtype });
}

async function infer(msg: Extract<DepthInMsg, { type: 'infer' }>) {
  const t0 = performance.now();
  const img = new RawImage(new Uint8ClampedArray(msg.rgba), msg.width, msg.height, 4);
  const inputs = await processor(img);
  let out: any;
  try { out = await model(inputs); } finally { inputs.pixel_values?.dispose?.(); } // free the input every frame (GPU memory otherwise grows until the tab dies)
  const pd = out.predicted_depth;
  const dims: number[] = pd.dims;
  const h = dims[dims.length - 2], w = dims[dims.length - 1];
  const f32 = toFloat32(pd);
  const copy = f32.slice(); // never hand out a buffer owned by the runtime
  pd.dispose?.();
  post({ type: 'result', id: msg.id, raw: copy, width: w, height: h, tCapture: msg.tCapture, inferMs: performance.now() - t0 }, [copy.buffer]);
}

self.onmessage = async (e: MessageEvent<DepthInMsg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m.backend, m.inputSize);
    else if (m.type === 'setSize') { inputSize = m.inputSize; applySize(); }
    else if (m.type === 'infer') { await infer(m); failures = 0; }
  } catch (err: any) {
    if (m.type === 'infer') failures++;
    // an inference that keeps failing (GPU device lost, out of memory) is fatal: stop instead of retrying every frame
    post({ type: 'error', message: String(err?.message ?? err), fatal: m.type === 'init' || failures >= 3 });
  }
};
