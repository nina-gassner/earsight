/**
 * Roles. On opening the site you choose:
 *   alone     – use this device on its own (all settings, the vision modes full screen).
 *   supplier  – this device (e.g. the phone) provides the camera. You type the code shown on the viewer; from then on the
 *               phone decides what the viewer plays and shows (the mode bar on this page chooses the view).
 *   viewer    – this device (e.g. the Meta glasses) shows a code first. Once a supplier is connected it only plays the
 *               sound and shows the picture; nothing can be changed on the viewer, all decisions are made on the supplier.
 */
import { Sonifier } from '../audio/sonifier';
import { LinkSupplier, LinkViewer, normalizeCode, type LinkConfig, type ViewKind } from '../link';
import { drawVisionFrame, say, type ViewMode } from './visionMode';

export type Role = 'select' | 'alone' | 'supplier' | 'viewer';

export interface RoleHooks {
  vision: { getMode(): ViewMode; setMode(m: ViewMode, fromGesture: boolean): void; begin(initial: string | null): void };
  sonifier: Sonifier;
  /** the canvas that holds the picture for a view kind (camera, or depth brightness) */
  pictureFor(mode: ViewKind): HTMLCanvasElement;
  mirror(): boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initRoles(h: RoleHooks) {
  const state = { current: 'select' as Role };
  const body = document.body;

  function setRole(r: Role) {
    state.current = r;
    body.classList.remove('role-select', 'role-alone', 'role-supplier', 'role-viewer');
    body.classList.add('role-' + r);
  }
  setRole('select');

  document.querySelectorAll<HTMLButtonElement>('#roleScreen button[data-role]').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.role as Role;
    if (r === 'alone') { setRole('alone'); h.vision.begin(null); }
    else if (r === 'supplier') startSupplier();
    else if (r === 'viewer') startViewer();
  }));

  // ------------------------------------------------------------------ supplier
  let link: LinkSupplier | null = null;
  function startSupplier() {
    setRole('supplier');
    h.sonifier.muted = true; // the viewer plays the sound, not this phone
    h.vision.setMode('peripheral', false);
    const input = $<HTMLInputElement>('supCode');
    const connect = $<HTMLButtonElement>('supConnect');
    const status = $<HTMLElement>('supStatus');
    const params = new URLSearchParams(location.search);
    if (params.get('code')) input.value = params.get('code')!;
    const doConnect = () => {
      const code = normalizeCode(input.value);
      if (!code) { status.textContent = 'The code has 6 letters and numbers, as shown on the viewer.'; return; }
      link?.close();
      link = new LinkSupplier(code);
      status.textContent = 'Connecting…';
      link.onChange = () => {
        status.textContent = link!.status === 'connected' ? 'Connected to the viewer. Choose the view below, then press Start.'
          : link!.status === 'error' ? link!.detail
          : link!.status === 'closed' ? 'The viewer disconnected. Enter the code again.'
          : 'Connecting…';
        status.classList.toggle('ok', link!.status === 'connected');
        status.classList.toggle('err', link!.status === 'error' || link!.status === 'closed');
      };
      h.sonifier.onUpdate = (l, r, rate, c, hh) => link?.sendAudio(l, r, rate, c, hh);
      link.startStreaming(
        (): LinkConfig => { const m = h.vision.getMode(); return { mode: m === 'light' ? 'light' : 'peripheral', mirror: h.mirror(), pan: h.sonifier.panStrength }; },
        () => h.pictureFor(h.vision.getMode() === 'light' ? 'light' : 'peripheral'),
      );
    };
    connect.onclick = doConnect;
    input.onkeydown = (e) => { if (e.key === 'Enter') doConnect(); };
    input.focus();
  }

  // ------------------------------------------------------------------ viewer
  function startViewer() {
    setRole('viewer');
    const canvas = $<HTMLCanvasElement>('viewerCanvas');
    const ctx = canvas.getContext('2d')!;
    const info = $<HTMLElement>('viewerInfo');
    const codeEl = $<HTMLElement>('viewerCode');
    const stateEl = $<HTMLElement>('viewerState');
    const son = new Sonifier();
    // started from the button tap (a user gesture); never wait for it, the code must appear regardless
    void son.enable().then(() => son.setVolume(1)).catch(() => { stateEl.textContent = 'Sound could not start. Reload and tap again.'; });
    const viewer = new LinkViewer();
    let cfg: LinkConfig = { mode: 'peripheral', mirror: false, pan: 2.5 };
    let picture: ImageBitmap | null = null;
    let lastPicture = 0;
    let decoding = false;
    let lastAudioSeq = 0, lastPicSeq = 0;
    let spoken = '';

    viewer.onChange = () => {
      const connected = viewer.status === 'connected';
      info.hidden = connected; // once connected the viewer only shows the picture
      codeEl.textContent = viewer.code;
      stateEl.textContent = viewer.status === 'error' ? viewer.detail
        : viewer.status === 'waiting' ? 'Enter this code on the supplier device (your phone).'
        : viewer.status === 'connected' ? '' : 'Getting a code…';
      if (viewer.status === 'waiting' && spoken !== viewer.code) { spoken = viewer.code; say('Your code is ' + viewer.code.split('').join(' ') + '.'); }
      if (!connected) { son.silence(); picture = null; }
      else say('Connected.');
    };
    viewer.onMessage = async (m) => {
      if (m.t === 'a') { if (m.n <= lastAudioSeq) return; lastAudioSeq = m.n; son.update(m.l, m.r, m.rate, m.c, m.h); }
      else if (m.t === 'cfg') { cfg = { mode: m.mode, mirror: m.mirror, pan: m.pan }; son.panStrength = m.pan; }
      else if (m.t === 'pic' && !decoding && m.n > lastPicSeq) {
        lastPicSeq = m.n;
        decoding = true;
        try {
          const bmp = await createImageBitmap(new Blob([m.d as BlobPart], { type: 'image/jpeg' }));
          picture?.close();
          picture = bmp;
          lastPicture = performance.now();
        } catch { /* bad frame */ } finally { decoding = false; }
      }
    };
    viewer.start();

    const draw = () => {
      requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      if (picture && performance.now() - lastPicture < 1500) drawVisionFrame(ctx, W, H, picture, cfg.mirror);
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    };
    requestAnimationFrame(draw);
    // no requestFullscreen here: glasses browsers can leave a black screen (the stage already covers the whole viewport)

    // controls on the viewer: tap = say the code again, hold for five seconds = start over
    let hold = 0;
    const stage = $<HTMLElement>('viewerStage');
    let downAt = 0;
    stage.addEventListener('pointerdown', () => { downAt = performance.now(); clearTimeout(hold); hold = window.setTimeout(() => location.reload(), 5000); });
    // a short tap says the code (or the state) again
    stage.addEventListener('pointerup', () => {
      if (downAt && performance.now() - downAt < 400) say(viewer.status === 'connected' ? 'Connected.' : 'Your code is ' + viewer.code.split('').join(' ') + '.');
      downAt = 0;
    });
    window.addEventListener('error', (e) => { stateEl.textContent = 'Error: ' + e.message; info.hidden = false; });
    window.addEventListener('unhandledrejection', (e) => { stateEl.textContent = 'Error: ' + ((e.reason as Error)?.message ?? String(e.reason)); info.hidden = false; });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) stage.addEventListener(t, () => clearTimeout(hold));
  }

  return state;
}
