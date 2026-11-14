/**
 * Vision modes: the page can be used as a visual aid itself.
 *  - settings:   the normal page with all controls.
 *  - peripheral: tunnel-vision layout. The camera picture is shown at the scale of the full screen but only through a
 *                small round window in the centre (size = "field" setting, set beforehand in the settings view). The
 *                rest stays black: nothing is scaled down, only the centre of what the camera sees is used.
 *  - light:      for people with light perception only. The display shows the depth model output (closer = brighter),
 *                full screen, so brightness itself carries the depth information.
 * In both vision modes no setting is visible. Leave with Escape or by holding the screen for two seconds.
 */
export type ViewMode = 'settings' | 'peripheral' | 'light';

export interface VisionApi {
  /** canvas holding the latest camera frame */
  camCanvas(): HTMLCanvasElement;
  /** canvas holding the latest depth (closeness) image */
  depthCanvas(): HTMLCanvasElement;
  /** true once real depth frames are being produced */
  depthReady(): boolean;
  depthFailed(): boolean;
  mirror(): boolean;
  /** size of the visible round window as a percentage of the shorter screen side */
  fieldPercent(): number;
  setDepth(on: boolean): void;
  setSound(on: boolean): void;
  start(): void;
  stop(): void;
}

const KEY = 'earsight.mode';
const HOLD_MS = 2000;

export function say(text: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    s.speak(new SpeechSynthesisUtterance(text));
  } catch { /* speech is optional */ }
}

/**
 * Draws one frame of a vision mode onto a canvas of size W x H (used by this page and by the remote viewer page).
 * peripheral: `src` is the camera picture; light: `src` is the depth (closeness) picture. Returns false if nothing was drawn.
 */
export function drawVisionFrame(ctx: CanvasRenderingContext2D, W: number, H: number, mode: 'peripheral' | 'light', src: CanvasImageSource & { width: number; height: number }, mirror: boolean, fieldPercent: number): boolean {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!(src.width > 0 && src.height > 0)) return false;
  ctx.imageSmoothingEnabled = true;
  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  const s = Math.max(W / src.width, H / src.height); // at this scale the full picture covers the whole screen
  if (mode === 'peripheral') {
    const R = (Math.min(100, Math.max(10, fieldPercent)) / 100) * Math.min(W, H) / 2;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
    ctx.clip(); // only the centre of the picture is used, at full-screen scale
  }
  ctx.drawImage(src, (W - src.width * s) / 2, (H - src.height * s) / 2, src.width * s, src.height * s);
  ctx.restore();
  return true;
}

export function initVisionModes(api: VisionApi) {
  const stage = document.getElementById('visionStage')!;
  const canvas = document.getElementById('visionCanvas') as HTMLCanvasElement;
  const go = document.getElementById('visionGo') as HTMLButtonElement;
  const ctx = canvas.getContext('2d')!;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#modeBar button[data-mode]'));
  let mode: ViewMode = 'settings';
  let raf = 0;
  let announcedReady = false, announcedFail = false;
  let holdTimer = 0;

  function frame() {
    if (mode === 'settings') return;
    raf = requestAnimationFrame(frame);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    if (mode === 'peripheral') {
      drawVisionFrame(ctx, W, H, 'peripheral', api.camCanvas(), api.mirror(), api.fieldPercent());
    } else if (api.depthReady()) {
      if (!announcedReady) { announcedReady = true; say('Light view ready.'); }
      drawVisionFrame(ctx, W, H, 'light', api.depthCanvas(), api.mirror(), 100);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (api.depthFailed() && !announcedFail) {
        announcedFail = true;
        say('Depth is not available on this device. Light view cannot work here.');
      }
    }
  }

  function fullscreen() {
    try { void document.documentElement.requestFullscreen?.(); } catch { /* not available (e.g. iPhone) */ }
  }

  function setMode(m: ViewMode, fromGesture: boolean) {
    mode = m;
    try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
    buttons.forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    cancelAnimationFrame(raf);
    announcedReady = announcedFail = false;
    if (m === 'settings') {
      document.body.classList.remove('vision');
      stage.hidden = true;
      try { if (document.fullscreenElement) void document.exitFullscreen(); } catch { /* ignore */ }
      return;
    }
    document.body.classList.add('vision');
    stage.hidden = false;
    api.setSound(true);
    api.setDepth(m === 'light');
    say((m === 'light' ? 'Light view.' : 'Peripheral view.') + ' Hold the screen for two seconds to leave.');
    raf = requestAnimationFrame(frame);
    if (fromGesture) { go.hidden = true; fullscreen(); api.start(); }
    else { go.hidden = false; go.focus(); } // browsers only start the camera after a tap
  }

  function leave() {
    api.stop();
    setMode('settings', false);
    say('Settings.');
  }

  buttons.forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mode as ViewMode;
    if (m === mode) return;
    if (mode !== 'settings') api.stop();
    setMode(m, true);
  }));
  go.addEventListener('click', () => { go.hidden = true; fullscreen(); api.start(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode !== 'settings') leave(); });
  stage.addEventListener('pointerdown', () => { clearTimeout(holdTimer); holdTimer = window.setTimeout(leave, HOLD_MS); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) stage.addEventListener(t, () => clearTimeout(holdTimer));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // start in the remembered / requested mode (?mode=peripheral or ?mode=light makes a bookmarkable shortcut)
  let initial: string = 'settings';
  const q = new URLSearchParams(location.search).get('mode');
  try { initial = q ?? localStorage.getItem(KEY) ?? 'settings'; } catch { if (q) initial = q; }
  if (initial === 'peripheral' || initial === 'light') setMode(initial, false);
  else setMode('settings', false);
  return { getMode: () => mode };
}
