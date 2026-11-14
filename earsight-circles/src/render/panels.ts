import type { ApproachMap } from '../motion/types';
import type { DepthFrame } from '../depth/depthClient';

/** Support below this is "unknown"; between this and KNOWN_FULL the grey level is faded in so thin evidence never looks bright. */
export const KNOWN_MIN = 0.22;
const KNOWN_FULL = 0.5;

function ensure(canvas: HTMLCanvasElement, w: number, h: number) {
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

export function renderCloseness(canvas: HTMLCanvasElement, f: DepthFrame) {
  ensure(canvas, f.width, f.height);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(f.width, f.height);
  const d = img.data, c = f.closeness;
  for (let i = 0; i < c.length; i++) {
    const g = (c[i] * 255 + 0.5) | 0; // closer = whiter
    d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = g; d[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Right panel base: grey = approach score where evidence exists, black elsewhere. Fixed scale (never auto-stretched). */
export function renderApproach(canvas: HTMLCanvasElement, hatch: HTMLCanvasElement, map: ApproachMap, showUnknown: boolean) {
  const w = map.width, h = map.height;
  ensure(canvas, w, h);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const s = map.support[i];
    let g = 0;
    if (s >= KNOWN_MIN) {
      const f = Math.min(1, (s - KNOWN_MIN) / (KNOWN_FULL - KNOWN_MIN));
      g = (map.score[i] * f * 255 + 0.5) | 0;
    }
    d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = g; d[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // unknown = subtle blue hatch on a separate overlay (same geometry, mirrored together via CSS)
  const hw = w * 2, hh = h * 2;
  ensure(hatch, hw, hh);
  const hctx = hatch.getContext('2d')!;
  if (!showUnknown) { hctx.clearRect(0, 0, hw, hh); return; }
  const himg = hctx.createImageData(hw, hh);
  const hd = himg.data;
  for (let y = 0; y < hh; y++) {
    const my = y >> 1;
    for (let x = 0; x < hw; x++) {
      const mx = x >> 1;
      if (map.support[my * w + mx] >= KNOWN_MIN) continue;
      if (((x + y) & 7) < 2) { const o = 4 * (y * hw + x); hd[o] = 90; hd[o + 1] = 140; hd[o + 2] = 255; hd[o + 3] = 120; }
    }
  }
  hctx.putImageData(himg, 0, 0);
}

export interface DebugOpts { points: boolean; fits: boolean; circles?: boolean }

export function renderDebug(canvas: HTMLCanvasElement, map: ApproachMap | null, o: DebugOpts, w: number, h: number, mirror: boolean) {
  ensure(canvas, w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  if (!map) return;
  // mirroring is applied to coordinates (not via CSS) so that labels stay readable
  const X = (nx: number) => (mirror ? 1 - nx : nx) * w;
  if (o.points) {
    for (const p of map.debugPoints) {
      ctx.fillStyle = p.supported ? `rgba(${Math.round(255 * p.score)},255,${Math.round(120 * (1 - p.score))},0.95)` : 'rgba(255,70,70,0.8)';
      ctx.fillRect(X(p.x) - 1.5, p.y * h - 1.5, 3, 3);
    }
  }
  if (o.circles && map.circles) {
    ctx.font = '11px ui-monospace, Consolas, monospace';
    for (const c of map.circles) {
      const cx = X(c.x), cy = c.y * h, r = c.r * w;
      ctx.lineWidth = c.approaching ? 3 : 1.5;
      ctx.strokeStyle = c.approaching ? 'rgba(80,255,120,0.95)' : 'rgba(255,200,60,0.75)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillText(c.approaching ? `APPROACHING ${c.rate.toFixed(2)}/s` + (Number.isFinite(c.ttc) ? ` · ${c.ttc.toFixed(1)} s` : '') : `circle ${c.rate >= 0 ? '+' : ''}${c.rate.toFixed(2)}/s`, cx - r, Math.max(11, cy - r - 5));
      ctx.shadowBlur = 0;
    }
  }
  if (o.fits) {
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    const strong = [...map.debugFits].sort((a, b) => b.confidence * Math.abs(b.rate) - a.confidence * Math.abs(a.rate)).slice(0, 14);
    for (const f of map.debugFits) {
      const hue = f.rate > 0 ? 120 : 0;
      ctx.strokeStyle = `hsla(${hue},90%,60%,${0.15 + 0.6 * f.confidence})`;
      ctx.beginPath(); ctx.arc(X(f.x), f.y * h, Math.max(2, f.r * w * 0.18), 0, Math.PI * 2); ctx.stroke();
    }
    for (const f of strong) {
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillText(`${f.rate >= 0 ? '+' : ''}${f.rate.toFixed(2)}/s c${f.confidence.toFixed(1)}`, X(f.x) + 4, f.y * h - 4);
      ctx.shadowBlur = 0;
    }
  }
}
