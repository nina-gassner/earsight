/**
 * Labelled synthetic video: a textured foreground square over a static textured background.
 * Deterministic. Used by the vitest pipeline tests and by the in-app "Synthetic" test mode.
 */
import { mulberry32 } from '../motion/expansion';

export type SceneKind = 'approach' | 'recession' | 'sideways' | 'static' | 'rotation' | 'plain' | 'waving' | 'exposure' | 'punch' | 'forward' | 'forwardobj';

export interface SceneInfo {
  kind: SceneKind;
  label: string;
  /** true: foreground should be bright and background dark; false: everything should stay dark */
  expectApproach: boolean;
}

export const SCENES: SceneInfo[] = [
  { kind: 'approach', label: 'Foreground patch approaching (expanding)', expectApproach: true },
  { kind: 'recession', label: 'Foreground patch receding (contracting)', expectApproach: false },
  { kind: 'sideways', label: 'Foreground patch translating sideways', expectApproach: false },
  { kind: 'static', label: 'Static scene', expectApproach: false },
  { kind: 'rotation', label: 'Foreground patch rotating in-plane', expectApproach: false },
  { kind: 'waving', label: 'Waving patch (oscillating motion, scale wobble, rotation wobble)', expectApproach: false },
  { kind: 'exposure', label: 'Static scene with auto-exposure brightness changes', expectApproach: false },
  { kind: 'punch', label: 'Fast punch: small patch expands about 2.7x in 0.25 s', expectApproach: true },
  { kind: 'forward', label: 'Camera moving forward: whole scene expands (ignored)', expectApproach: false },
  { kind: 'forwardobj', label: 'Camera moving forward + one object approaching faster', expectApproach: true },
  { kind: 'plain', label: 'Plain surface (no texture)', expectApproach: false },
];

const TEX = 512;

function makeTexture(seed: number, contrast: number): Float32Array {
  const rnd = mulberry32(seed);
  const t = new Float32Array(TEX * TEX).fill(0.5);
  // coarse value noise
  const octaves = [64, 32, 16, 8];
  octaves.forEach((cell, oi) => {
    const g = Math.ceil(TEX / cell) + 1;
    const grid = Float32Array.from({ length: g * g }, () => rnd());
    const amp = 0.28 / (1 + oi * 0.5);
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
      const gx = x / cell, gy = y / cell;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = gx - x0, fy = gy - y0;
      const a = grid[y0 * g + x0], b = grid[y0 * g + x0 + 1], c = grid[(y0 + 1) * g + x0], d = grid[(y0 + 1) * g + x0 + 1];
      const v = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
      t[y * TEX + x] += (v - 0.5) * amp * 2 * contrast;
    }
  });
  // random rectangles give strong corners for Shi-Tomasi
  for (let k = 0; k < 450; k++) {
    const w = 3 + Math.floor(rnd() * 18), h = 3 + Math.floor(rnd() * 18);
    const x0 = Math.floor(rnd() * TEX), y0 = Math.floor(rnd() * TEX);
    const v = (rnd() - 0.5) * 0.7 * contrast;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) t[(y % TEX) * TEX + (x % TEX)] += v;
  }
  return t;
}

function sample(tex: Float32Array, x: number, y: number): number {
  const xf = ((x % TEX) + TEX) % TEX, yf = ((y % TEX) + TEX) % TEX;
  const x0 = Math.floor(xf), y0 = Math.floor(yf);
  const fx = xf - x0, fy = yf - y0;
  const x1 = (x0 + 1) % TEX, y1 = (y0 + 1) % TEX;
  return tex[y0 * TEX + x0] * (1 - fx) * (1 - fy) + tex[y0 * TEX + x1] * fx * (1 - fy) +
    tex[y1 * TEX + x0] * (1 - fx) * fy + tex[y1 * TEX + x1] * fx * fy;
}

export interface RenderedFrame {
  gray: Uint8Array;
  /** 1 where the foreground patch is visible */
  fgMask: Uint8Array;
  width: number;
  height: number;
}

export class SyntheticScene {
  readonly kind: SceneKind;
  readonly width: number;
  readonly height: number;
  private bg: Float32Array;
  private fg: Float32Array;
  private noise: () => number;
  readonly duration: number;

  constructor(kind: SceneKind, width = 320, height = 240, seed = 7) {
    this.kind = kind;
    this.width = width;
    this.height = height;
    this.bg = makeTexture(seed, kind === 'plain' ? 0 : 1);
    this.fg = makeTexture(seed + 1000, kind === 'plain' ? 0 : 1.2);
    this.noise = mulberry32(seed + 5);
    this.duration = kind === 'approach' || kind === 'recession' ? 1.4 : kind === 'waving' || kind === 'exposure' ? 3.0 : kind === 'forward' || kind === 'forwardobj' ? 1.3 : 2.0;
  }

  /** foreground transform at time t (seconds): centre, uniform scale, rotation, base half-size in px */
  pose(t: number): { cx: number; cy: number; s: number; th: number; half: number } {
    const w = this.width, h = this.height;
    switch (this.kind) {
      case 'approach': return { cx: w * 0.5, cy: h * 0.5, s: Math.exp(0.55 * t), th: 0, half: h * 0.17 };
      case 'recession': return { cx: w * 0.5, cy: h * 0.5, s: Math.exp(-0.55 * t), th: 0, half: h * 0.3 };
      case 'sideways': return { cx: w * 0.25 + 75 * t, cy: h * 0.5, s: 1, th: 0, half: h * 0.22 };
      case 'rotation': return { cx: w * 0.5, cy: h * 0.5, s: 1, th: 0.8 * t, half: h * 0.22 };
      case 'forwardobj': return { cx: w * 0.5, cy: h * 0.5, s: Math.exp(1.3 * t), th: 0, half: h * 0.1 };
      case 'forward': return { cx: w * 0.5, cy: h * 0.5, s: 0.0001, th: 0, half: 1 }; // no foreground
      case 'punch': {
        const tp = t % 1.6;
        const ls = tp < 0.25 ? 4 * tp : tp < 0.6 ? 1 - 1 * ((tp - 0.25) / 0.35) : 0;
        return { cx: w * 0.5 + (tp < 0.25 ? 30 * tp : 0), cy: h * 0.5, s: Math.exp(ls), th: 0, half: h * 0.12 };
      }
      case 'waving': {
        const w2 = 2 * Math.PI;
        return { cx: w * 0.5 + 55 * Math.sin(w2 * 1.5 * t), cy: h * 0.5 + 15 * Math.sin(w2 * 1.1 * t), s: 1 + 0.08 * Math.sin(w2 * 2 * t), th: 0.3 * Math.sin(w2 * 1.5 * t), half: h * 0.22 };
      }
      default: return { cx: w * 0.5, cy: h * 0.5, s: 1, th: 0, half: h * 0.22 };
    }
  }

  render(t: number): RenderedFrame {
    const { width: w, height: h } = this;
    const gray = new Uint8Array(w * h);
    const fgMask = new Uint8Array(w * h);
    const { cx, cy, s, th, half } = this.pose(t);
    const c = Math.cos(th), sn = Math.sin(th);
    const plain = this.kind === 'plain';
    const gain = 1 + 0.25 * Math.sin(2 * Math.PI * 0.8 * t);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // inverse map into patch coordinates
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const ux = (c * dx + sn * dy) / s, uy = (-sn * dx + c * dy) / s;
        let v: number;
        if (Math.abs(ux) < half && Math.abs(uy) < half) {
          v = sample(this.fg, ux + half + 10, uy + half + 10);
          fgMask[y * w + x] = 1;
        } else if (this.kind === 'forward' || this.kind === 'forwardobj') {
          const sb = Math.exp(0.4 * t); // whole background expands about the image centre
          v = sample(this.bg, (x + 0.5 - w / 2) / sb + w / 2, (y + 0.5 - h / 2) / sb + h / 2);
        } else v = sample(this.bg, x, y);
        v = plain ? 0.5 : v;
        if (this.kind === 'exposure') v = 0.5 + (v - 0.5) * gain + (gain - 1) * 0.3;
        v += (this.noise() - 0.5) * 0.012; // sensor noise (about +-1.5 grey levels)
        gray[y * w + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
    }
    return { gray, fgMask, width: w, height: h };
  }
}
