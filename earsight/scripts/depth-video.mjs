// Runs the depth model (onnx-community/depth-anything-v2-small, the same one the app uses) on every frame of a video and
// writes a depth video (closer = brighter, like the app's "Light perception" view) plus a side-by-side with the original.
//   FFMPEG=<path to ffmpeg> node scripts/depth-video.mjs <input.mp4> <outDir> [fps]
import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [input, outDir, fpsArg] = process.argv.slice(2);
if (!input || !outDir) { console.error('usage: node scripts/depth-video.mjs <input.mp4> <outDir> [fps]'); process.exit(1); }
const FF = process.env.FFMPEG ?? 'ffmpeg';
const fps = Number(fpsArg ?? 30);
const MODEL = 'onnx-community/depth-anything-v2-small';
const SIZE = Number(process.env.SIZE ?? 308);

function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function png(gray, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray[y * w + x]; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const work = join(tmpdir(), 'earsight-depth-video-' + Date.now());
const framesIn = join(work, 'in'), framesOut = join(work, 'out');
mkdirSync(framesIn, { recursive: true }); mkdirSync(framesOut, { recursive: true }); mkdirSync(outDir, { recursive: true });
console.log('extracting frames at', fps, 'fps');
execFileSync(FF, ['-v', 'error', '-i', input, '-vf', `fps=${fps}`, join(framesIn, 'f%04d.png')]);
const files = readdirSync(framesIn).filter((f) => f.endsWith('.png')).sort();
console.log(files.length, 'frames');

const model = await AutoModel.from_pretrained(MODEL, { dtype: process.env.DTYPE ?? 'q8', device: 'cpu' });
const processor = await AutoProcessor.from_pretrained(MODEL);
processor.image_processor.size = { width: SIZE, height: SIZE };

const pct = (arr, p) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
let lo = null, hi = null, outW = 0, outH = 0;
const t0 = performance.now();
for (let i = 0; i < files.length; i++) {
  const img = await RawImage.read(join(framesIn, files[i]));
  const { predicted_depth: pd } = await model(await processor(img));
  const d = pd.data, h = pd.dims[pd.dims.length - 2], w = pd.dims[pd.dims.length - 1];
  outW = w; outH = h;
  const l = pct(d, 0.02), u = pct(d, 0.98);
  lo = lo === null ? l : lo + 0.15 * (l - lo); hi = hi === null ? u : hi + 0.15 * (u - hi); // smoothed bounds: no flicker
  const g = new Uint8Array(w * h), span = Math.max(1e-6, hi - lo);
  for (let k = 0; k < g.length; k++) g[k] = Math.max(0, Math.min(255, Math.round((255 * (d[k] - lo)) / span)));
  writeFileSync(join(framesOut, files[i]), png(g, w, h));
  if (i % 15 === 0) console.log(`frame ${i + 1}/${files.length}  ${((performance.now() - t0) / (i + 1)).toFixed(0)} ms/frame`);
}
const base = input.replaceAll('\\', '/').split('/').pop().replace(/\.[^.]+$/, '');
const depthMp4 = join(outDir, base + '-depth.mp4'), sbs = join(outDir, base + '-depth-side-by-side.mp4');
console.log('encoding videos');
const vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
execFileSync(FF, ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(framesOut, 'f%04d.png'), '-i', input, '-map', '0:v', '-vf', 'scale=1368:630:flags=bicubic,format=yuv420p', '-c:v', 'libx264', '-crf', '18', depthMp4]);
execFileSync(FF, ['-v', 'error', '-y', '-i', input, '-framerate', String(fps), '-i', join(framesOut, 'f%04d.png'), '-filter_complex', `[0:v]fps=${fps},scale=1368:630[a];[1:v]scale=1368:630:flags=bicubic,format=yuv420p[b];[a][b]hstack,${vf}`, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', sbs]);
for (const k of [0, Math.floor(files.length / 3), Math.floor((2 * files.length) / 3), files.length - 1]) {
  execFileSync(FF, ['-v', 'error', '-y', '-i', join(framesOut, files[k]), '-vf', 'scale=1368:630:flags=bicubic', join(outDir, `${base}-depth-frame${String(k + 1).padStart(3, '0')}.png`)]);
}
rmSync(work, { recursive: true, force: true });
console.log('done:', outDir, `(model output ${outW}x${outH}, input size ${SIZE})`);
