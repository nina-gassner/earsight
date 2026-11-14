/**
 * Viewer: a second device (phone, glasses browser, ...) that needs no camera. It receives the audio data and the vision
 * data from the device that sees (see share.ts), plays the beeps and draws the peripheral / light view.
 */
import { Sonifier } from './audio/sonifier';
import { drawVisionFrame, say } from './ui/visionMode';
import { shareUrl, type ShareConfig, type ShareMessage } from './share';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const go = document.getElementById('go') as HTMLButtonElement;
const stateEl = document.getElementById('state')!;
const room = new URLSearchParams(location.search).get('room') ?? '';

const sonifier = new Sonifier();
let cfg: ShareConfig = { mode: 'peripheral', field: 45, mirror: false, pan: 2.5 };
let picture: ImageBitmap | null = null;
let decoding = false;
let senderHere = false;
let lastPicture = 0;
let started = false;

function setState(t: string) { stateEl.textContent = t; }

function connect() {
  if (!/^[a-z0-9]{12,64}$/i.test(room)) { setState('No room in the address. Scan the QR code again.'); return; }
  const ws = new WebSocket(shareUrl(location.protocol, location.host, room, 'viewer'));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setState('Connected. Waiting for the other device…');
  ws.onclose = () => { setState('Connection lost. Reconnecting…'); sonifier.silence(); setTimeout(connect, 1500); };
  ws.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      let m: ShareMessage;
      try { m = JSON.parse(e.data) as ShareMessage; } catch { return; }
      if (m.t === 'a') sonifier.update(m.l, m.r, m.rate, m.c, m.h);
      else if (m.t === 'cfg') { cfg = { mode: m.mode, field: m.field, mirror: m.mirror, pan: m.pan }; sonifier.panStrength = m.pan; }
      else if (m.t === 'status') {
        if (m.sender && !senderHere) say('Connected.');
        senderHere = m.sender;
        if (!m.sender) { sonifier.silence(); setState('Waiting for the other device…'); }
      }
      return;
    }
    if (decoding) return; // drop, never queue
    decoding = true;
    try {
      const bmp = await createImageBitmap(new Blob([e.data as ArrayBuffer], { type: 'image/jpeg' }));
      picture?.close();
      picture = bmp;
      lastPicture = performance.now();
      setState('');
    } catch { /* bad frame */ } finally { decoding = false; }
  };
}

function frame() {
  requestAnimationFrame(frame);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const fresh = picture && performance.now() - lastPicture < 1500;
  if (fresh && picture) drawVisionFrame(ctx, W, H, cfg.mode === 'light' ? 'light' : 'peripheral', picture, cfg.mirror, cfg.field);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
}

go.addEventListener('click', async () => {
  go.hidden = true;
  started = true;
  try { await sonifier.enable(); sonifier.setVolume(1); } catch { setState('Audio could not start.'); }
  try { void document.documentElement.requestFullscreen?.(); } catch { /* not available everywhere */ }
  say('Viewer ready.');
});
window.addEventListener('beforeunload', () => sonifier.silence());
void started;
requestAnimationFrame(frame);
connect();
