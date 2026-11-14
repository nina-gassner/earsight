/**
 * Vision modes: the page can be used as a visual aid itself.
 *  - settings:   the normal page with all controls.
 *  - peripheral: the whole camera picture, shown on the whole display (nothing cropped, nothing hidden).
 *  - light:      for people with light perception only. The display shows the depth model output (closer = brighter),
 *                so brightness itself carries the depth information.
 * Standalone ("use on this device"): in both vision modes no setting is visible. Tap the screen to bring up a bar for
 * switching to another mode; hold the screen for two seconds (or press Escape) to go back to the settings.
 * Supplier: the mode bar stays on the page and only chooses what the viewer device shows (see link.ts).
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
  setDepth(on: boolean): void;
  setSound(on: boolean): void;
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** true: the vision modes take over the whole screen (standalone); false: they only choose what a viewer device shows */
  immersive(): boolean;
  /** called after every mode change */
  onMode?(m: ViewMode): void;
}

const HOLD_MS = 2000;
const TAP_MS = 350;
const BAR_MS = 4000;

export function say(text: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    s.speak(new SpeechSynthesisUtterance(text));
  } catch { /* speech is optional */ }
}

/**
 * Draws one frame of a vision mode onto a canvas of size W x H (used by this page and by the viewer).
 * peripheral: `src` is the camera picture; light: `src` is the depth (closeness) picture.
 * The whole picture is always visible (fitted into the display, black bars if the shapes differ).
 */
export function drawVisionFrame(ctx: CanvasRenderingContext2D, W: number, H: number, src: CanvasImageSource & { width: number; height: number }, mirror: boolean): boolean {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!(src.width > 0 && src.height > 0)) return false;
  ctx.imageSmoothingEnabled = true;
  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  const s = Math.min(W / src.width, H / src.height);
  ctx.drawImage(src, (W - src.width * s) / 2, (H - src.height * s) / 2, src.width * s, src.height * s);
  ctx.restore();
  return true;
}

export function initVisionModes(api: VisionApi) {
  const stage = document.getElementById('visionStage')!;
  const canvas = document.getElementById('visionCanvas') as HTMLCanvasElement;
  const go = document.getElementById('visionGo') as HTMLButtonElement;
  const stageBar = document.getElementById('stageBar')!;
  const ctx = canvas.getContext('2d')!;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#modeBar button[data-mode], #stageBar button[data-mode]'));
  let mode: ViewMode = 'settings';
  let raf = 0;
  let announcedReady = false, announcedFail = false;
  let holdTimer = 0, barTimer = 0, downAt = 0;

  function frame() {
    if (mode === 'settings' || !api.immersive()) return;
    raf = requestAnimationFrame(frame);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    if (mode === 'peripheral') {
      drawVisionFrame(ctx, W, H, api.camCanvas(), api.mirror());
    } else if (api.depthReady()) {
      if (!announcedReady) { announcedReady = true; say('Light view ready.'); }
      drawVisionFrame(ctx, W, H, api.depthCanvas(), api.mirror());
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

  function markButtons(m: ViewMode) {
    buttons.forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function showBar() {
    stageBar.hidden = false;
    clearTimeout(barTimer);
    barTimer = window.setTimeout(() => { stageBar.hidden = true; }, BAR_MS);
  }

  /** `fromGesture`: called from a tap/click, so the camera may be started */
  function setMode(m: ViewMode, fromGesture: boolean) {
    const previous = mode;
    mode = m;
    markButtons(m);
    announcedReady = announcedFail = false;
    if (!api.immersive()) { // supplier: only chooses what the viewer gets
      if (m !== 'settings') api.setDepth(m === 'light');
      api.onMode?.(m);
      return;
    }
    cancelAnimationFrame(raf);
    stageBar.hidden = true;
    if (m === 'settings') {
      document.body.classList.remove('vision');
      stage.hidden = true;
      try { if (document.fullscreenElement) void document.exitFullscreen(); } catch { /* ignore */ }
      api.onMode?.(m);
      return;
    }
    document.body.classList.add('vision');
    stage.hidden = false;
    api.setSound(true);
    api.setDepth(m === 'light');
    say((m === 'light' ? 'Light view.' : 'Peripheral view.') + ' Tap the screen to switch. Hold it for two seconds to leave.');
    raf = requestAnimationFrame(frame);
    if (fromGesture) {
      go.hidden = true;
      if (previous === 'settings') fullscreen();
      if (previous === 'settings' || !api.isRunning()) api.start();
    } else { go.hidden = false; go.focus(); } // browsers only start the camera after a tap
    api.onMode?.(m);
  }

  function leave() {
    api.stop();
    setMode('settings', false);
    say('Settings.');
  }

  buttons.forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mode as ViewMode;
    if (m === mode) return;
    if (m === 'settings' && api.immersive() && mode !== 'settings') { leave(); return; }
    setMode(m, true);
    if (!api.immersive() && m !== 'settings') return;
    if (api.immersive() && b.closest('#stageBar')) showBar();
  }));
  go.addEventListener('click', () => { go.hidden = true; fullscreen(); api.start(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode !== 'settings' && api.immersive()) leave(); });
  stage.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('#stageBar')) return;
    downAt = performance.now();
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(leave, HOLD_MS);
  });
  stage.addEventListener('pointerup', () => {
    clearTimeout(holdTimer);
    if (downAt && performance.now() - downAt < TAP_MS) { if (stageBar.hidden) showBar(); else stageBar.hidden = true; } // a short tap toggles the switch bar
    downAt = 0;
  });
  for (const t of ['pointercancel', 'pointerleave'] as const) stage.addEventListener(t, () => { clearTimeout(holdTimer); downAt = 0; });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // start in the requested mode (?mode=peripheral or ?mode=light makes a bookmarkable shortcut)
  function begin(initialMode: string | null) {
    // a reload always starts at the role selection and then in the settings view; only an explicit ?mode= opens a vision view
    const initial = initialMode ?? new URLSearchParams(location.search).get('mode') ?? 'settings';
    if (initial === 'peripheral' || initial === 'light') setMode(initial, false);
    else setMode('settings', false);
  }
  return { getMode: () => mode, begin, setMode, leave };
}
