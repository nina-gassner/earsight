/**
 * Labelled synthetic video: a textured foreground square over a static textured background.
 * Deterministic. Used by the vitest pipeline tests and by the in-app "Synthetic" test mode.
 */
import { mulberry32 } from '../motion/expansion';

export type SceneKind = 'ballsoft' | 'ballapproach' | 'ballfast' | 'ballrecede' | 'ballside' | 'ballstatic' | 'ballwobble' | 'approach' | 'recession' | 'sideways' | 'static' | 'rotation' | 'plain' | 'waving' | 'exposure' | 'punch' | 'forward' | 'forwardobj';

export interface SceneInfo {
  kind: SceneKind;
  label: string;
  /** true: foreground should be bright and background dark; false: everything should stay dark */
  expectApproach: boolean;
}

export const SCENES: SceneInfo[] = [
  { kind: 'ballsoft', label: 'Ball approaching, blurry + low contrast, no outline (hard case)', expectApproach: true },
  { kind: 'ballapproach', label: 'Ball approaching (radius grows)', expectApproach: true },
  { kind: 'ballfast', label: 'Ball approaching fast (thrown at us)', expectApproach: true },
  { kind: 'ballrecede', label: 'Ball receding (must stay dark)', expectApproach: false },
  { kind: 'ballside', label: 'Ball moving sideways (must stay dark)', expectApproach: false },
  { kind: 'ballstatic', label: 'Ball standing still (must stay dark)', expectApproach: false },
  { kind: 'ballwobble', label: 'Ball wobbling in size, no net approach (must stay dark)', expectApproach: false },
  { kind: 'approach', label: 'Square/patch scene — Foreground patch approaching (expanding) (not a circle: must stay dark)', expectApproach: false },
  { kind: 'recession', label: 'Square/patch scene — Foreground patch receding (contracting) (not a circle: must stay dark)', expectApproach: false },
  { kind: 'sideways', label: 'Square/patch scene — Foreground patch translating sideways (not a circle: must stay dark)', expectApproach: false },
  { kind: 'static', label: 'Square/patch scene — Static scene (not a circle: must stay dark)', expectApproach: false },
  { kind: 'rotation', label: 'Square/patch scene — Foreground patch rotating in-plane (not a circle: must stay dark)', expectApproach: false },
  { kind: 'waving', label: 'Square/patch scene — Waving patch (oscillating motion, scale wobble, rotation wobble) (not a circle: must stay dark)', expectApproach: false },
  { kind: 'exposure', label: 'Square/patch scene — Static scene with auto-exposure brightness changes (not a circle: must stay dark)', expectApproach: false },
  { kind: 'punch', label: 'Square/patch scene — Fast punch: small patch expands about 2.7x in 0.25 s (not a circle: must stay dark)', expectApproach: false },
  { kind: 'forward', label: 'Square/patch scene — Camera moving forward: whole scene expands (ignored) (not a circle: must stay dark)', expectApproach: false },
  { kind: 'forwardobj', label: 'Square/patch scene — Camera moving forward + one object approaching faster (not a circle: must stay dark)', expectApproach: false },
  { kind: 'plain', label: 'Square/patch scene — Plain surface (no texture) (not a circle: must stay dark)', expectApproach: false },
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
    this.bg = makeTexture(seed, kind === 'plain' ? 0 : kind === 'ballsoft' ? 0.3 : 1);
    this.fg = makeTexture(seed + 1000, kind === 'plain' ? 0 : 1.2);
    this.noise = mulberry32(seed + 5);
    this.duration = kind === 'ballsoft' ? 2.0 : kind === 'ballapproach' || kind === 'ballrecede' ? 1.4 : kind === 'ballfast' ? 1.0 : kind === 'ballwobble' ? 3.0 : kind === 'approach' || kind === 'recession' ? 1.4 : kind === 'waving' || kind === 'exposure' ? 3.0 : kind === 'forward' || kind === 'forwardobj' ? 1.3 : 2.0;
  }

  /** foreground transform at time t (seconds): centre, uniform scale, rotation, base half-size in px */
  pose(t: number): { cx: number; cy: number; s: number; th: number; half: number } {
    const w = this.width, h = this.height;
    switch (this.kind) {
      case 'ballsoft': return { cx: w * 0.45, cy: h * 0.5, s: Math.exp(0.6 * t), th: 0, half: h * 0.1 };
      case 'ballapproach': return { cx: w * 0.5, cy: h * 0.5, s: Math.exp(0.8 * t), th: 0, half: h * 0.12 };
      case 'ballfast': return { cx: w * 0.5, cy: h * 0.5, s: Math.exp(2.0 * t), th: 0, half: h * 0.06 };
      case 'ballrecede': return { cx: w * 0.5, cy: h * 0.5, s: Math.exp(-0.8 * t), th: 0, half: h * 0.3 };
      case 'ballside': return { cx: w * 0.2 + 75 * t, cy: h * 0.5, s: 1, th: 0, half: h * 0.14 };
      case 'ballstatic': return { cx: w * 0.5, cy: h * 0.5, s: 1, th: 0, half: h * 0.14 };
      case 'ballwobble': return { cx: w * 0.5, cy: h * 0.5, s: 1 + 0.12 * Math.sin(2 * Math.PI * 2 * t), th: 0, half: h * 0.14 };
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
    const ball = this.kind.startsWith('ball');
    const gain = 1 + 0.25 * Math.sin(2 * Math.PI * 0.8 * t);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // inverse map into patch coordinates
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const ux = (c * dx + sn * dy) / s, uy = (-sn * dx + c * dy) / s;
        let v: number;
        if (ball && ux * ux + uy * uy < half * half) {
          const rho2 = (ux * ux + uy * uy) / (half * half);
          v = this.kind === 'ballsoft' ? 0.75 - 0.15 * rho2 : rho2 > 0.85 ? 0.12 : 0.95 - 0.3 * rho2 + (sample(this.fg, ux + half + 10, uy + half + 10) - 0.5) * 0.08; // shaded disc with a dark rim (limb / outline)
          fgMask[y * w + x] = 1;
        } else if (!ball && Math.abs(ux) < half && Math.abs(uy) < half) {
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
    if (this.kind === 'ballsoft') { // optics / motion blur: two 3x3 box passes
      for (let pass = 0; pass < 2; pass++) {
        const src = gray.slice();
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let a = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) a += src[(y + j) * w + x + i]; gray[y * w + x] = a / 9; }
      }
    }
    return { gray, fgMask, width: w, height: h };
  }
}
