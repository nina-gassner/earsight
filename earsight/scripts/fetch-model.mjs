// Downloads the depth model files once to public/models/ so the laptop can serve them to the phone over the local
// Wi-Fi (the phone then does not need to download ~50 MB from huggingface.co). Same model, same files.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ID = 'onnx-community/depth-anything-v2-small';
const FILES = ['config.json', 'preprocessor_config.json', 'onnx/model_fp16.onnx'];
for (const f of FILES) {
  const out = join('public', 'models', ID, f);
  try { if ((await stat(out)).size > 0) { console.log('have', out); continue; } } catch { /* download */ }
  console.log('downloading', f, '…');
  const r = await fetch(`https://huggingface.co/${ID}/resolve/main/${f}`);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
}
console.log('done. Restart the server (npm run phone / npm run dev); the phone will now load the model from the laptop.');
