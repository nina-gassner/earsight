// Runs onnx-community/depth-anything-v2-small on one image (CPU, onnxruntime-node) and reports the raw output
// representation, so "larger = closer?" is established empirically rather than assumed.
//   node scripts/inspect-depth.mjs [imageUrlOrPath] [outPrefix]
import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const MODEL = 'onnx-community/depth-anything-v2-small';
const src = process.argv[2] ?? 'http://images.cocodataset.org/val2017/000000039769.jpg';
const out = process.argv[3] ?? 'test-results/depth-inspect';

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function png(gray, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray[y * w + x]; }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dtype = process.env.DTYPE ?? 'q8';
console.log('loading', MODEL, 'dtype', dtype);
const model = await AutoModel.from_pretrained(MODEL, { dtype, device: 'cpu' });
const processor = await AutoProcessor.from_pretrained(MODEL);
console.log('processor config size:', JSON.stringify(processor.image_processor.size), 'keep_aspect_ratio:', processor.image_processor.config.keep_aspect_ratio, 'ensure_multiple_of:', processor.image_processor.config.ensure_multiple_of);
const size = Number(process.env.SIZE ?? 308);
processor.image_processor.size = { width: size, height: size };
const image = await RawImage.read(src);
console.log('input image', image.width, 'x', image.height);
const inputs = await processor(image);
console.log('pixel_values dims', inputs.pixel_values.dims, inputs.pixel_values.type);
const t0 = performance.now();
const { predicted_depth } = await model(inputs);
console.log('inference ms', (performance.now() - t0).toFixed(0));
console.log('predicted_depth dims', predicted_depth.dims, 'type', predicted_depth.type);
const d = predicted_depth.data;
const [, h, w] = predicted_depth.dims.length === 3 ? predicted_depth.dims : [1, ...predicted_depth.dims];
let mn = Infinity, mx = -Infinity, sum = 0;
for (const v of d) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
console.log('raw min', mn.toFixed(3), 'max', mx.toFixed(3), 'mean', (sum / d.length).toFixed(3));
const g = new Uint8Array(w * h);
for (let i = 0; i < g.length; i++) g[i] = Math.round(255 * (d[i] - mn) / (mx - mn));
writeFileSync(out + '-raw-normalised.png', png(g, w, h));
// also save the input image resized for comparison
const small = (await image.resize(w, h)).grayscale();
writeFileSync(out + '-input.png', png(small.data, w, h));
console.log('wrote', out + '-raw-normalised.png', '(white = LARGER raw value)');
