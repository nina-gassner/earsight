/** Phone sender: captures the camera and streams JPEG frames to the laptop page via the dev-server relay. */
import { describeCameraError } from './camera';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('v');
const status = $('status'), err = $('err');
const go = $<HTMLButtonElement>('go'), flip = $<HTMLButtonElement>('flip'), stop = $<HTMLButtonElement>('stop');

const room = new URLSearchParams(location.search).get('room') ?? '';
let facing: 'environment' | 'user' = 'environment';
let stream: MediaStream | null = null;
let ws: WebSocket | null = null;
let timer = 0;
let wake: any = null;
let sent = 0;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d')!;

async function begin() {
  err.textContent = '';
  if (!room) { err.textContent = 'No room token in the URL. Scan the QR code shown on the laptop page.'; return; }
  end();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    });
  } catch (e) { err.textContent = describeCameraError(e); return; }
  video.srcObject = stream;
  await video.play();
  try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { /* optional */ }
  ws = new WebSocket(`wss://${location.host}/relay?room=${encodeURIComponent(room)}&role=phone`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { status.textContent = 'connected — sending'; schedule(); };
  ws.onclose = () => { status.textContent = 'disconnected from laptop'; clearTimeout(timer); };
  ws.onerror = () => { err.textContent = 'Could not reach the laptop relay. Phone and laptop must be on the same Wi-Fi; allow Node.js through the Windows firewall (private networks).'; };
  go.disabled = true; stop.disabled = false;
}

function end() {
  clearTimeout(timer);
  ws?.close(); ws = null;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  video.srcObject = null;
  wake?.release?.(); wake = null;
  go.disabled = false; stop.disabled = true;
}

function schedule() {
  const tick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !stream) return;
    // backpressure: skip this frame if the socket is still busy
    if (ws.bufferedAmount < 150_000 && video.videoWidth > 0) {
      const w = Math.min(640, video.videoWidth), h = Math.round((w * video.videoHeight) / video.videoWidth);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      const tCap = performance.now();
      canvas.toBlob(async (blob) => {
        if (!blob || !ws || ws.readyState !== WebSocket.OPEN) return;
        const jpeg = await blob.arrayBuffer();
        const buf = new ArrayBuffer(8 + jpeg.byteLength);
        new DataView(buf).setFloat64(0, tCap); // phone-side capture time (ms) for jitter-free timestamps on the laptop
        new Uint8Array(buf, 8).set(new Uint8Array(jpeg));
        ws.send(buf);
        sent++;
        if (sent % 15 === 0) status.textContent = `connected — sent ${sent} frames (${w}×${h})`;
      }, 'image/jpeg', 0.7);
    }
    timer = window.setTimeout(tick, 1000 / 25);
  };
  tick();
}

go.addEventListener('click', () => void begin());
stop.addEventListener('click', () => { end(); status.textContent = 'stopped'; });
flip.addEventListener('click', () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  flip.textContent = facing === 'environment' ? 'Use front camera' : 'Use back camera';
  if (stream) void begin();
});
