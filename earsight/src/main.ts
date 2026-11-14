import { CameraController, describeCameraError, type FrameInfo } from './camera';
import { DepthClient, type DepthFrame } from './depth/depthClient';
import type { DepthBackend } from './depth/protocol';
import { MotionClient } from './motion/motionClient';
import { DEFAULT_MOTION_SETTINGS, type ApproachMap, type MotionSettings } from './motion/types';
import { renderApproach, renderCloseness, renderDebug } from './render/panels';
import { SyntheticSource } from './synthetic/source';
import { SCENES, type SceneKind } from './synthetic/scenes';
import { measureApproach } from './synthetic/metrics';
import { Sonifier } from './audio/sonifier';
import { initVisionModes } from './ui/visionMode';
import { initRoles } from './ui/roles';
import { suppressNonObjects, extractObjects, APPROACH_OBJECT_OPTS, CLOSENESS_OBJECT_OPTS } from './motion/objects';
import { computeStereoLevels, weightedCloseness, verticalCentroid } from './audio/levels';
import { rateFromCloseness } from './audio/sonifier';
import { PhoneSource } from './phoneSource';
import { SoundGate } from './audio/gate';
import QRCode from 'qrcode';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- elements
const el = {
  start: $<HTMLButtonElement>('btnStart'), stop: $<HTMLButtonElement>('btnStop'),
  source: $<HTMLSelectElement>('selSource'), mirror: $<HTMLInputElement>('chkMirror'), depthOn: $<HTMLInputElement>('chkDepth'),
  backend: $<HTMLSelectElement>('selBackend'), message: $('message'), progress: $('progress'), progressFill: $('progressFill'), progressText: $('progressText'),
  cap: $<HTMLSelectElement>('selCap'), proc: $<HTMLSelectElement>('selProc'), depthSize: $<HTMLSelectElement>('selDepthSize'),
  win: $<HTMLInputElement>('rWin'), sens: $<HTMLInputElement>('rSens'), sm: $<HTMLInputElement>('rSm'), dsm: $<HTMLInputElement>('rDsm'),
  gate: $<HTMLInputElement>('chkGate'), near: $<HTMLInputElement>('rNear'), unknown: $<HTMLInputElement>('chkUnknown'), points: $<HTMLInputElement>('chkPoints'), fits: $<HTMLInputElement>('chkFits'),
  sound: $<HTMLInputElement>('chkSound'), audioSrc: $<HTMLSelectElement>('selAudioSrc'), flip: $<HTMLInputElement>('chkFlip'),
  objects: $<HTMLInputElement>('chkObjects'), ego: $<HTMLInputElement>('chkEgo'), derot: $<HTMLInputElement>('chkDerot'), path: $<HTMLInputElement>('chkPath'), closeThr: $<HTMLInputElement>('rCloseThr'), gateBeep: $<HTMLInputElement>('chkGateBeep'),
  btnRunOnPhone: $<HTMLButtonElement>('btnRunOnPhone'), qrTitle: $('qrTitle'),
  btnLaptop: $<HTMLButtonElement>('btnCamLaptop'), btnPhone: $<HTMLButtonElement>('btnCamPhone'), qrPanel: $('qrPanel'), qrCanvas: $<HTMLCanvasElement>('qrCanvas'), qrText: $('qrText'), qrStatus: $('qrStatus'),
  pathW: $<HTMLInputElement>('rPathW'), turn: $<HTMLInputElement>('rTurn'), pan: $<HTMLInputElement>('rPan'), speed: $<HTMLInputElement>('rSpeed'), hfov: $<HTMLInputElement>('rHfov'), resetAdv: $<HTMLButtonElement>('btnResetAdv'),
  panels: $('panels'), effects: $('effects'),
  cvLeft: $<HTMLCanvasElement>('cvLeft'), cvMid: $<HTMLCanvasElement>('cvMid'), cvRight: $<HTMLCanvasElement>('cvRight'), hatch: $<HTMLCanvasElement>('hatch'),
  dbgLeft: $<HTMLCanvasElement>('dbgLeft'), dbgRight: $<HTMLCanvasElement>('dbgRight'),
  tsLeft: $('tsLeft'), tsMid: $('tsMid'), tsRight: $('tsRight'), stats: $('statsLine'), synth: $('synthLine'),
};

// ---------------------------------------------------------------- state
const camera = new CameraController();
let synth: SyntheticSource | null = null;
let phone: PhoneSource | null = null;
let running = false;
let startSeq = 0;
let motion: MotionClient | null = null;
let depth: DepthClient | null = null;
let depthState: 'off' | 'loading' | 'ready' | 'unavailable' = 'off';
let depthBackendInfo = '';
let lastFrame: FrameInfo | null = null;
let lastMap: ApproachMap | null = null;
let lastDepth: DepthFrame | null = null;
let srcW = 640, srcH = 480;
const t0 = performance.now();

const procCanvas = document.createElement('canvas');
const procCtx = procCanvas.getContext('2d', { willReadFrequently: true })!;
const depthCanvas = document.createElement('canvas');
const depthCtx = depthCanvas.getContext('2d', { willReadFrequently: true })!;

const fps = { motion: 0, depth: 0, camera: 0 };
let lastMotionT = 0, lastDepthT = 0, lastCamT = 0;
const ema = (prev: number, dt: number) => { const f = dt > 0 ? 1000 / dt : 0; return prev ? prev + 0.2 * (f - prev) : f; };
const stats = { inferMs: 0, motionMs: 0, motionAge: 0, depthAge: 0, tracks: 0, supported: 0, fits: 0, window: 0, note: '', fail: {} as Record<string, number> };
let synthStats = '';

// ---------------------------------------------------------------- sound
const sonifier = new Sonifier();
let evidenceBuf = new Float32Array(0);
const gates = { approach: new SoundGate(), closeness: new SoundGate() };
let approachActiveT = 0; // last time separable approach evidence was present (gates the beeps)
let latestHint: { data: Float32Array; width: number; height: number } | null = null;
function sonify(kind: 'approach' | 'closeness', values: ArrayLike<number>, w: number, h: number) {
  if (!el.sound.checked || !sonifier.active) return;
  const approach = kind === 'approach';
  const opts = { threshold: approach ? 0.25 : Number(el.closeThr.value), reference: approach ? 0.03 : 0.25, mirror: el.mirror.checked, flip: el.flip.checked };
  const raw = computeStereoLevels(values, w, h, opts);
  // flicker protection: evidence must persist over consecutive updates, short dropouts are bridged, levels are smoothed
  const gate = gates[kind];
  const lv = gate.step(raw.left, raw.right, performance.now());
  if (approach && gate.on) approachActiveT = performance.now();
  if (el.audioSrc.value !== kind) return;
  // beeps only while an object is approaching (can be switched off for the closeness view)
  if (el.gateBeep.checked && performance.now() - approachActiveT > 400) { sonifier.update(0, 0, 0, 0); return; }
  const ref = approach ? latestHint : { data: values as Float32Array, width: w, height: h };
  const c = ref ? weightedCloseness(values, w, h, opts.threshold, ref) : NaN;
  const closeness = gate.smoothValue('c', Number.isFinite(c) ? c : Math.max(lv.left, lv.right)); // no depth yet: use evidence strength
  // urgency = the larger of how close the object is and how strongly/widely it is approaching
  const urgency = approach ? Math.max(closeness, Math.max(lv.left, lv.right)) : closeness;
  const yc = verticalCentroid(values, w, h, opts.threshold);
  const height = gate.smoothValue('y', Number.isFinite(yc) ? yc : 0.5);
  sonifier.update(lv.left, lv.right, rateFromCloseness(urgency), closeness, height);
}
el.sound.addEventListener('change', async () => {
  if (el.sound.checked) { try { await sonifier.enable(); sonifier.setVolume(1); } catch (e) { el.sound.checked = false; msg('Audio could not start: ' + (e as Error).message, 'err'); } }
  else await sonifier.disable();
});
const closeOut = $('oCloseThr');
el.closeThr.addEventListener('input', () => { closeOut.textContent = Number(el.closeThr.value).toFixed(2); });
const setPan = () => { sonifier.panStrength = Number(el.pan.value); };
bindRange(el.pan, 'oPan', (v) => v.toFixed(1), setPan);
el.audioSrc.addEventListener('change', () => { sonifier.silence(); gates.approach.reset(); gates.closeness.reset(); });

// ---------------------------------------------------------------- UI helpers
function msg(text: string, kind: '' | 'err' | 'ok' = '') {
  el.message.hidden = !text;
  el.message.className = kind;
  el.message.textContent = text;
}
function progress(pct: number, text: string) {
  if (depthState === 'ready') return;
  el.progress.hidden = false;
  if (pct >= 0) el.progressFill.style.width = pct.toFixed(0) + '%';
  el.progressText.textContent = text;
}
const sec = (t: number) => ((t - t0) / 1000).toFixed(2) + ' s';

function setRunning(r: boolean) {
  running = r;
  el.start.disabled = r; el.stop.disabled = !r;
}

function populateSources(devices: MediaDeviceInfo[] = []) {
  const cur = el.source.value;
  el.source.innerHTML = '';
  const g1 = document.createElement('optgroup'); g1.label = 'Webcam';
  if (devices.length === 0) g1.append(new Option('Default camera (list fills in after permission)', 'cam:'));
  devices.forEach((d, i) => g1.append(new Option(d.label || `Camera ${i + 1}`, 'cam:' + d.deviceId)));
  const gp = document.createElement('optgroup'); gp.label = 'Phone';
  gp.append(new Option('Phone camera (scan QR code)', 'phone:'));
  const g2 = document.createElement('optgroup'); g2.label = 'Synthetic test scenes (no camera needed)';
  for (const s of SCENES) g2.append(new Option('Synthetic — ' + s.label, 'synth:' + s.kind));
  el.source.append(g1, gp, g2);
  if ([...el.source.options].some((o) => o.value === cur)) el.source.value = cur;
}

function setAspect(w: number, h: number) {
  srcW = w; srcH = h;
  el.panels.style.setProperty('--ar', `${w} / ${h}`);
  document.querySelectorAll<HTMLElement>('.stack').forEach((s) => s.style.setProperty('--ar', `${w} / ${h}`));
}

function drawUnavailable(text: string) {
  const c = el.cvMid; c.width = 640; c.height = 480;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#888'; ctx.font = '20px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(text, 320, 240);
}

// ---------------------------------------------------------------- advanced settings: remembered in this browser
const ADV_KEY = 'earsight.advanced.v1';
const ADV_IDS = ['rWin', 'rSens', 'rSm', 'rDsm', 'rNear', 'rPathW', 'rTurn', 'rPan', 'rSpeed', 'rHfov', 'chkObjects', 'chkPath', 'chkDerot', 'chkEgo', 'chkGate', 'chkUnknown', 'chkPoints', 'chkFits', 'selProc', 'selDepthSize', 'selCap'];
const advField = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
function loadAdvanced() {
  try {
    const saved = JSON.parse(localStorage.getItem(ADV_KEY) ?? '{}') as Record<string, string | boolean>;
    for (const id of ADV_IDS) {
      const f = advField(id); if (!f || !(id in saved)) continue;
      if (f instanceof HTMLInputElement && f.type === 'checkbox') f.checked = saved[id] === true; else f.value = String(saved[id]);
    }
  } catch { /* storage unavailable: defaults */ }
}
function saveAdvanced() {
  try {
    const out: Record<string, string | boolean> = {};
    for (const id of ADV_IDS) { const f = advField(id); if (f) out[id] = f instanceof HTMLInputElement && f.type === 'checkbox' ? f.checked : f.value; }
    localStorage.setItem(ADV_KEY, JSON.stringify(out));
  } catch { /* ignore */ }
}
loadAdvanced();
document.getElementById('adv')?.addEventListener('input', saveAdvanced);
document.getElementById('adv')?.addEventListener('change', saveAdvanced);
el.resetAdv.addEventListener('click', () => { try { localStorage.removeItem(ADV_KEY); } catch { /* ignore */ } location.reload(); });

// ---------------------------------------------------------------- settings
function motionSettings(): MotionSettings {
  return {
    ...DEFAULT_MOTION_SETTINGS,
    procWidth: Number(el.proc.value), windowMs: Number(el.win.value), sensitivity: Number(el.sens.value),
    smoothingMs: Number(el.sm.value), useDepthGate: el.gate.checked, nearThreshold: Number(el.near.value), egoComp: el.ego.checked, derotate: el.derot.checked, pathGate: el.path.checked,
    pathHalfWidth: Number(el.pathW.value), maxTurnDegPerSec: Number(el.turn.value), walkSpeed: Number(el.speed.value), hfovDeg: Number(el.hfov.value),
  };
}
function pushMotionSettings() { motion?.configure(motionSettings()); }

function bindRange(input: HTMLInputElement, out: string, fmt: (v: number) => string, apply: () => void) {
  const o = $(out);
  const upd = () => { o.textContent = fmt(Number(input.value)); apply(); };
  input.addEventListener('input', upd); upd();
}
bindRange(el.win, 'oWin', (v) => String(v), pushMotionSettings);
bindRange(el.sens, 'oSens', (v) => v.toFixed(1), pushMotionSettings);
bindRange(el.pathW, 'oPathW', (v) => v.toFixed(1), pushMotionSettings);
bindRange(el.turn, 'oTurn', (v) => String(v), pushMotionSettings);
bindRange(el.speed, 'oSpeed', (v) => v.toFixed(1), pushMotionSettings);
bindRange(el.hfov, 'oHfov', (v) => String(v), pushMotionSettings);
bindRange(el.sm, 'oSm', (v) => String(v), pushMotionSettings);
bindRange(el.dsm, 'oDsm', (v) => String(v), () => { if (depth) depth.normalizer.settings.boundsSmoothingMs = Number(el.dsm.value); });
el.gate.addEventListener('change', pushMotionSettings);
el.ego.addEventListener('change', pushMotionSettings);
el.derot.addEventListener('change', pushMotionSettings);
el.path.addEventListener('change', pushMotionSettings);
bindRange(el.near, 'oNear', (v) => v.toFixed(2), pushMotionSettings);
el.proc.addEventListener('change', pushMotionSettings);
el.mirror.addEventListener('change', () => { el.panels.classList.toggle('mirror', el.mirror.checked); redrawOverlays(); });
el.panels.classList.toggle('mirror', el.mirror.checked);
for (const c of [el.points, el.fits, el.unknown]) c.addEventListener('change', () => { if (lastMap) { renderRight(lastMap); } redrawOverlays(); });
el.depthSize.addEventListener('change', () => depth?.setSize(Number(el.depthSize.value)));
el.cap.addEventListener('change', () => { if (running && el.source.value.startsWith('cam:')) void start(); });
el.source.addEventListener('change', () => { if (running) void start(); });
el.backend.addEventListener('change', () => { if (running && el.depthOn.checked) void startDepth(); });
// the depth (middle) panel is only shown when depth is switched on: the default view is just camera + approach
const syncPanels = () => { $('pMid').hidden = !el.depthOn.checked; el.panels.classList.toggle('two', !el.depthOn.checked); };
el.depthOn.addEventListener('change', syncPanels); syncPanels();
el.depthOn.addEventListener('change', () => { if (el.depthOn.checked) { if (running) void startDepth(); } else stopDepth('off'); });

// ---------------------------------------------------------------- rendering
function renderRight(map: ApproachMap) {
  renderApproach(el.cvRight, el.hatch, map, el.unknown.checked);
}
function redrawOverlays() {
  const o = { points: el.points.checked, fits: el.fits.checked };
  const w = 640, h = Math.round(640 * srcH / srcW);
  renderDebug(el.dbgRight, lastMap, o, w, h, el.mirror.checked);
  renderDebug(el.dbgLeft, lastMap, o, w, h, el.mirror.checked);
}

// ---------------------------------------------------------------- pipeline
function imageSource(): CanvasImageSource | null {
  if (synth) return synth.canvas;
  if (phone) return phone.canvas;
  return camera.video;
}

function onSourceFrame(info: FrameInfo) {
  lastFrame = info;
  if (lastCamT) fps.camera = ema(fps.camera, info.tCallback - lastCamT);
  lastCamT = info.tCallback;
  const img = imageSource();
  if (!img) return;
  const w = synth ? synth.width : phone ? phone.width : camera.width, h = synth ? synth.height : phone ? phone.height : camera.height;
  if (!(w > 0 && h > 0)) return;
  if (el.cvLeft.width !== w || el.cvLeft.height !== h) { el.cvLeft.width = w; el.cvLeft.height = h; setAspect(w, h); }
  el.cvLeft.getContext('2d')!.drawImage(img, 0, 0, w, h);

  // --- motion: newest frame only, dropped if the worker is busy
  if (motion && motion.ready && !motion.busy) {
    const pw = Number(el.proc.value), ph = Math.round((pw * h) / w);
    if (procCanvas.width !== pw || procCanvas.height !== ph) { procCanvas.width = pw; procCanvas.height = ph; }
    procCtx.drawImage(img, 0, 0, pw, ph);
    const rgba = procCtx.getImageData(0, 0, pw, ph).data;
    const gray = new Uint8Array(pw * ph);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    motion.offer(gray, pw, ph, info.tCapture);
  }

  // --- depth: at most one inference in flight; frame is captured only when the worker is free
  if (depth && depth.ready && !depth.busy) {
    const dw = Math.min(w, Math.max(196, Number(el.depthSize.value)) * 1.5 | 0), dh = Math.round((dw * h) / w);
    if (depthCanvas.width !== dw || depthCanvas.height !== dh) { depthCanvas.width = dw; depthCanvas.height = dh; }
    depthCtx.drawImage(img, 0, 0, dw, dh);
    const data = depthCtx.getImageData(0, 0, dw, dh).data;
    depth.offer(data.buffer.slice(0) as ArrayBuffer, dw, dh, info.tCapture);
  }
}

function onMap(map: ApproachMap, workerMs: number, tResult: number) {
  lastMap = map;
  if (lastMotionT) fps.motion = ema(fps.motion, tResult - lastMotionT);
  lastMotionT = tResult;
  stats.motionMs = workerMs; stats.motionAge = tResult - map.t;
  stats.tracks = map.stats.tracks; stats.supported = map.stats.supportedTracks; stats.fits = map.stats.fits; stats.window = map.stats.windowSeconds * 1000;
  stats.note = map.stats.note; stats.fail = map.stats.failReasons;
  {
    const n = map.width * map.height;
    if (evidenceBuf.length !== n) evidenceBuf = new Float32Array(n);
    for (let i = 0; i < n; i++) { const sp = map.support[i]; evidenceBuf[i] = sp < 0.22 ? 0 : map.score[i] * Math.min(1, (sp - 0.22) / 0.28); }
    let ev: ArrayLike<number> = evidenceBuf;
    if (el.objects.checked) {
      // only compact, sharp-edged, plausibly sized regions count as an approaching object; others are painted dark (valid, no evidence)
      const f = suppressNonObjects(evidenceBuf, map.width, map.height, APPROACH_OBJECT_OPTS);
      for (let i = 0; i < n; i++) if (evidenceBuf[i] > APPROACH_OBJECT_OPTS.threshold && f[i] === 0) map.score[i] = 0;
      ev = f;
    }
    renderRight(map);
    redrawOverlays();
    if (el.sound.checked) sonify('approach', ev, map.width, map.height);
  }
  if (synth?.fgMask) {
    const m = measureApproach(map, synth.fgMask, synth.width, synth.height);
    const info = SCENES.find((s) => s.kind === synth!.scene.kind)!;
    synthStats = `Synthetic self-check [${info.kind}] (expected: ${info.expectApproach ? 'foreground bright, background dark' : 'everything dark'}) · ` +
      `foreground mean ${m.fgMean.toFixed(2)} · foreground coverage ${(100 * m.fgCov).toFixed(0)}% · bright background ${(100 * m.bgBright).toFixed(1)}% · whole-image mean ${m.allMeanAll.toFixed(3)} (mask is from the newest frame, approximate)`;
  } else synthStats = '';
}

function onDepthFrame(f: DepthFrame) {
  lastDepth = f;
  if (lastDepthT) fps.depth = ema(fps.depth, f.tResult - lastDepthT);
  lastDepthT = f.tResult;
  stats.inferMs = f.inferMs; stats.depthAge = f.tResult - f.tCapture;
  renderCloseness(el.cvMid, f);
  // coarse hint for the motion worker: used only to limit spatial propagation of approach evidence
  const hw = 64, hh = Math.max(1, Math.round((64 * f.height) / f.width));
  const hint = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) hint[y * hw + x] = f.closeness[Math.floor((y * f.height) / hh) * f.width + Math.floor((x * f.width) / hw)];
  motion?.setDepth({ data: hint, width: hw, height: hh, t: f.tCapture });
  latestHint = { data: hint, width: hw, height: hh };
  if (el.sound.checked && el.audioSrc.value === 'closeness') {
    const h2 = el.objects.checked ? suppressNonObjects(hint, hw, hh, { ...CLOSENESS_OBJECT_OPTS, threshold: Number(el.closeThr.value) }) : hint;
    sonify('closeness', h2, hw, hh);
  }
}

// ---------------------------------------------------------------- depth lifecycle
function stopDepth(state: 'off' | 'unavailable') {
  depth?.dispose(); depth = null; depthState = state; lastDepth = null;
  if (state === 'off') { drawUnavailable('Depth is switched off'); el.progress.hidden = true; }
  motion?.setDepth(null);
}

async function startDepth() {
  stopDepth('off');
  if (!el.depthOn.checked) return;
  depthState = 'loading';
  drawUnavailable('Loading depth model…');
  progress(0, 'Starting depth worker…');
  const backend = el.backend.value as DepthBackend;
  depth = new DepthClient({
    onProgress: (pct, text) => progress(pct, text),
    onReady: (b, dtype) => {
      depthState = 'ready'; depthBackendInfo = `${b}/${dtype}`; el.progress.hidden = true;
      msg(`Depth model ready (${b}, ${dtype}).` + (b === 'wasm' ? ' WASM CPU backend: expect a low depth frame rate.' : ''), 'ok');
      setTimeout(() => { if (el.message.classList.contains('ok')) msg(''); }, 4000);
    },
    onError: (m, fatal) => {
      if (fatal) {
        depthState = 'unavailable'; el.progress.hidden = true;
        drawUnavailable('Depth unavailable');
        const gpuHint = backend === 'webgpu'
          ? ' WebGPU could not be used. Use a current Edge (113+), update the GPU driver, check edge://gpu, or choose “WASM CPU” as a slower fallback. Camera and approach views keep working without depth.'
          : ' Camera and approach views keep working without depth.';
        msg('Depth model failed: ' + m + gpuHint, 'err');
        depth?.dispose(); depth = null;
      } else console.warn('depth error', m);
    },
    onFrame: onDepthFrame,
  });
  depth.normalizer.settings.boundsSmoothingMs = Number(el.dsm.value);
  depth.init(backend, Number(el.depthSize.value));
}

// ---------------------------------------------------------------- phone camera
let cachedRoom = '';
function roomToken(): string {
  if (cachedRoom) return cachedRoom;
  // localStorage (shared by all tabs of this browser) so the QR and the listening laptop page always agree on the room
  const store = (() => { try { return window.localStorage; } catch { return null; } })();
  let t = '';
  try { t = store?.getItem('earsightRoom') ?? ''; } catch { /* blocked */ }
  if (!/^[a-f0-9]{24}$/.test(t)) {
    t = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    try { store?.setItem('earsightRoom', t); } catch { /* ignore */ }
  }
  cachedRoom = t;
  return t;
}
type QrMode = 'stream' | 'app';
let qrMode: QrMode = 'stream';
let manualHost = '';

/** Draws the QR for the current mode. Falls back to a manually typed laptop IP if it cannot be detected. */
async function renderQr() {
  const ipRow = $('qrIpRow');
  let ips: string[] = [];
  let seen = '';
  let serverOld = false;
  try {
    const r = await fetch('/relay-info');
    const j = await r.json(); // an old dev server returns index.html here -> throws
    ips = Array.isArray(j.ips) ? j.ips : [];
    seen = Array.isArray(j.all) ? j.all.join(', ') : '';
  } catch { serverOld = true; }
  const onLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const host = manualHost || (onLocal ? ips[0] : location.hostname);
  el.qrPanel.hidden = false;
  el.qrTitle.innerHTML = qrMode === 'app'
    ? '<b>Open the whole app on your phone</b> — the phone does all computing, camera and sound; this laptop only serves the page'
    : '<b>Scan with your phone</b> — the phone streams its camera to this laptop (same Wi-Fi)';
  ipRow.hidden = !!host && !!ips.length ? true : false;
  if (!host) {
    ipRow.hidden = false;
    el.qrText.textContent = (serverOld ? 'The dev server did not answer /relay-info (restart `npm run dev` with the updated code). ' : `No Wi-Fi address found (interfaces seen: ${seen || 'none'}). `) + 'Type your laptop IP below to get a QR:';
    const c = el.qrCanvas.getContext('2d');
    if (c) { c.fillStyle = '#fff'; c.fillRect(0, 0, el.qrCanvas.width, el.qrCanvas.height); c.fillStyle = '#c00'; c.font = '14px system-ui'; c.textAlign = 'center'; c.fillText('No address found', el.qrCanvas.width / 2, el.qrCanvas.height / 2 - 6); c.fillText('enter laptop IP below', el.qrCanvas.width / 2, el.qrCanvas.height / 2 + 14); }
    el.qrStatus.textContent = '';
    return;
  }
  const origin = `https://${host}:${location.port || 5173}`;
  const url = qrMode === 'app' ? origin + '/' : `${origin}/phone.html?room=${roomToken()}`;
  el.qrText.textContent = url + (ips.length > 1 && !manualHost ? `  (other addresses: ${ips.filter((x) => x !== host).join(', ')})` : '');
  el.qrStatus.textContent = qrMode === 'app'
    ? 'On the phone: accept the certificate warning, tap Start camera, allow the camera, tick Sound. First start downloads the depth model onto the phone.'
    : phone ? '' : 'Scan, accept the certificate warning, press “Start sending”. Then press Start camera here.';
  try { await QRCode.toCanvas(el.qrCanvas, url, { width: 200, margin: 2 }); }
  catch (e) { el.qrText.textContent = 'QR generation failed: ' + (e as Error).message + ' — type this address into the phone: ' + url; }
}
$<HTMLInputElement>('qrIp').addEventListener('input', (e) => {
  const v = (e.target as HTMLInputElement).value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) { manualHost = v; void renderQr(); }
});
el.btnRunOnPhone.addEventListener('click', () => { qrMode = 'app'; renderQr().catch((e) => msg('QR error: ' + (e as Error).message, 'err')); });

function showPhoneStatus(s: string) {
  el.qrStatus.textContent = s === 'connected' ? `Phone connected — ${phone?.frames ?? 0} frames` : s === 'waiting' ? 'Waiting for the phone… (scan the code, press “Start sending”)' : s === 'lost' ? 'Connection to the laptop server lost.' : 'Connecting…';
}
setInterval(() => { if (phone) showPhoneStatus(phone.status); }, 1000);

function syncCamToggle() {
  const isPhone = el.source.value === 'phone:';
  el.btnPhone.classList.toggle('on', isPhone);
  el.btnLaptop.classList.toggle('on', !isPhone);
  el.qrPanel.hidden = !isPhone;
}
el.btnLaptop.addEventListener('click', () => {
  const first = [...el.source.options].find((o) => o.value.startsWith('cam:'));
  if (first) el.source.value = first.value;
  syncCamToggle();
  if (running) void start();
});
el.btnPhone.addEventListener('click', () => {
  el.source.value = 'phone:';
  el.mirror.checked = false; el.panels.classList.remove('mirror'); // a phone's rear camera is not a mirror
  syncCamToggle();
  qrMode = 'stream';
  void start(); // start listening for the phone right away (the QR is drawn by start())
});
el.source.addEventListener('change', syncCamToggle);

// ---------------------------------------------------------------- start / stop
async function start() {
  const seq = ++startSeq;
  try { (navigator as any).wakeLock?.request('screen'); } catch { /* optional */ }
  if (el.sound.checked) void sonifier.enable().then(() => sonifier.setVolume(1)).catch((e) => { el.sound.checked = false; msg('Audio could not start: ' + (e as Error).message, 'err'); });
  msg('');
  stopSource();
  lastMap = null; lastDepth = null; lastMotionT = lastDepthT = lastCamT = 0; synthStats = '';
  const sel = el.source.value;
  try {
    if (sel === 'phone:') {
      const token = roomToken();
      phone = new PhoneSource(token);
      phone.onStatus = showPhoneStatus;
      phone.start(onSourceFrame);
      qrMode = 'stream'; await renderQr();
      showPhoneStatus(phone.status);
      el.effects.textContent = 'Phone camera: JPEG frames over local Wi-Fi (phone capture times are mapped to the laptop clock). Latency includes network + JPEG.';
    } else if (sel.startsWith('synth:')) {
      synth = new SyntheticSource(sel.slice(6) as SceneKind);
      setAspect(synth.width, synth.height);
      synth.start(onSourceFrame);
      el.effects.textContent = 'Synthetic scene: a looping labelled test video generated in the page (320×240).';
    } else {
      const [cw, ch] = el.cap.value.split('x').map(Number);
      const id = sel.slice(4) || undefined;
      await camera.start(id, cw, ch);
      if (seq !== startSeq) { camera.stop(); return; }
      const devs = await camera.listDevices();
      populateSources(devs);
      const actual = camera.settings?.deviceId;
      const usedLabel = devs.find((d) => d.deviceId === actual)?.label || 'unnamed camera';
      if (actual) el.source.value = 'cam:' + actual;
      setAspect(camera.width, camera.height);
      el.effects.textContent = `Analysing: “${usedLabel}” · FOV ${el.hfov.value}° · Camera ${camera.width}×${camera.height}` + (camera.settings?.frameRate ? ` @ ${Math.round(camera.settings.frameRate)} fps requested/reported` : '') + ` · ${camera.effectsNote}`;
      camera.onFrames(onSourceFrame);
    }
    if (!motion) {
      motion = new MotionClient({
        onReady: () => { pushMotionSettings(); },
        onError: (m) => msg('Motion worker error: ' + m, 'err'),
        onMap,
      });
    } else motion.reset();
    pushMotionSettings();
    setRunning(true);
    if (!depth && el.depthOn.checked) void startDepth();
  } catch (e) {
    console.error(e);
    setRunning(false);
    msg(describeCameraError(e), 'err');
  }
}

function stopSource() {
  camera.stop();
  synth?.stop(); synth = null;
  phone?.stop(); phone = null;
  lastFrame = null;
}

el.start.addEventListener('click', () => void start());
el.stop.addEventListener('click', () => { sonifier.silence(); startSeq++; stopSource(); setRunning(false); msg('Stopped. The processing workers stay loaded; press Start to resume.'); });

navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (running) populateSources(await camera.listDevices());
});

// ---------------------------------------------------------------- stats
function tsText() {
  const now = performance.now();
  if (lastFrame) el.tsLeft.textContent = `frame @ ${sec(lastFrame.tCapture)} · age ${(now - lastFrame.tCapture).toFixed(0)} ms${lastFrame.fromMetadata ? '' : ' (callback time)'}`;
  else el.tsLeft.textContent = '—';
  if (lastDepth) el.tsMid.textContent = `from frame @ ${sec(lastDepth.tCapture)} · ${(lastFrame ? lastFrame.tCapture - lastDepth.tCapture : 0).toFixed(0)} ms older than camera view`;
  else el.tsMid.textContent = depthState === 'loading' ? 'loading…' : '—';
  if (lastMap) el.tsRight.textContent = `from frame @ ${sec(lastMap.t)} · ${(lastFrame ? lastFrame.tCapture - lastMap.t : 0).toFixed(0)} ms older than camera view`;
  else el.tsRight.textContent = '—';

  el.stats.textContent =
    `camera ${fps.camera.toFixed(0)} fps · motion ${fps.motion.toFixed(1)} fps (worker ${stats.motionMs.toFixed(0)} ms) · ` +
    `depth ${depthState === 'ready' ? fps.depth.toFixed(1) + ' fps, inference ' + stats.inferMs.toFixed(0) + ' ms (' + depthBackendInfo + ')' : depthState} · ` +
    `capture→result age: motion ${stats.motionAge.toFixed(0)} ms, depth ${stats.depthAge.toFixed(0)} ms (from browser frame timestamp, NOT camera hardware latency) · ` +
    `tracks ${stats.tracks} (supported ${stats.supported}) · fits ${stats.fits} · window ${stats.window.toFixed(0)} ms` + (stats.note ? ` · ${stats.note}` : '') + ' · fit rejections: ' + (Object.entries(stats.fail).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + ' ' + v).join(', ') || 'none') +
    (lastDepth ? ` · depth raw range ${lastDepth.rawMin.toFixed(2)}…${lastDepth.rawMax.toFixed(2)}, display bounds ${lastDepth.lo.toFixed(2)}…${lastDepth.hi.toFixed(2)}` : '');
  el.synth.textContent = synthStats;
}
setInterval(tsText, 250);

// ---------------------------------------------------------------- init
window.addEventListener('error', (e) => msg('Script error: ' + e.message, 'err'));
window.addEventListener('unhandledrejection', (e) => msg('Error: ' + ((e.reason as Error)?.message ?? String(e.reason)), 'err'));
if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  // running on the phone itself: rear camera is not a mirror, and phones need lighter defaults
  el.mirror.checked = false; el.panels.classList.remove('mirror');
  el.proc.value = '160'; el.depthSize.value = '196'; el.cap.value = '320x240'; // all phones: the tab is killed and reloaded when memory runs out, so start light
  document.getElementById('camToggle')!.hidden = true; el.btnRunOnPhone.hidden = true;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    // iOS Safari kills the page ("a problem repeatedly occurred") when it uses too much memory: go as light as possible
    el.proc.value = '160'; el.depthSize.value = '196'; el.cap.value = '320x240';
  }
  if (new URLSearchParams(location.search).get('depth') === '0') el.depthOn.checked = false; // test aid: open the page with ?depth=0
}
populateSources();
setAspect(640, 480);
drawUnavailable('Press “Start camera” (or pick a synthetic scene)');
if (!('gpu' in navigator)) {
  el.backend.value = 'wasm';
  msg('This browser does not expose WebGPU (navigator.gpu). Depth will use the slower WASM CPU backend if you start it; camera and approach views work without depth. Use Microsoft Edge 113+ on Windows for WebGPU.');
}
// warm up OpenCV in the worker immediately (no camera required)
motion = new MotionClient({ onReady: () => pushMotionSettings(), onError: (m) => msg('Motion worker error: ' + m, 'err'), onMap });

(window as any).__earsight = {
  get state() { return { running, depthState, fps, stats, lastMap, synthStats, depthBackendInfo }; },
  start: (src: string) => { el.source.value = src; return start(); },
  motion: () => motion,
};

// ---------------------------------------------------------------- roles + view modes
const visionCtl = initVisionModes({
  camCanvas: () => el.cvLeft,
  depthCanvas: () => el.cvMid,
  depthReady: () => depthState === 'ready' && lastDepth !== null,
  depthFailed: () => depthState === 'unavailable',
  mirror: () => el.mirror.checked,
  setDepth: (on) => { if (el.depthOn.checked !== on) { el.depthOn.checked = on; el.depthOn.dispatchEvent(new Event('change')); } },
  setSound: (on) => { el.sound.checked = on; },
  start: () => { void start(); },
  stop: () => { sonifier.silence(); startSeq++; stopSource(); setRunning(false); },
  isRunning: () => running,
  immersive: () => role.current === 'alone',
});
const role = initRoles({
  vision: visionCtl,
  sonifier,
  pictureFor: (mode) => (mode === 'light' ? el.cvMid : el.cvLeft),
  mirror: () => el.mirror.checked,
});
