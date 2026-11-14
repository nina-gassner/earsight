import type { ApproachMap } from '../motion/types';

export interface Metrics {
  /** mean approach score inside the (eroded) foreground patch; unknown counts as 0 */
  fgMean: number;
  /** fraction of the foreground core that has valid support */
  fgCov: number;
  /** fraction of far-background pixels with score > 0.3 and valid support */
  bgBright: number;
  bgMeanAll: number;
  allMeanAll: number;
  maxFg: number;
}

/** Compares an approach map to the known foreground mask of a synthetic frame (map is half the frame resolution). */
export function measureApproach(map: ApproachMap, fgMask: Uint8Array, w: number, h: number): Metrics {
  let fgN = 0, fgSum = 0, fgKnown = 0, bgN = 0, bgBright = 0, bgSum = 0, all = 0, maxFg = 0;
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const i = y * map.width + x;
    const sx = Math.min(w - 1, x * 2 + 1), sy = Math.min(h - 1, y * 2 + 1);
    const m = (dx: number, dy: number) => fgMask[Math.min(h - 1, Math.max(0, sy + dy)) * w + Math.min(w - 1, Math.max(0, sx + dx))];
    const isFgCore = m(0, 0) && m(6, 0) && m(-6, 0) && m(0, 6) && m(0, -6);
    const isBgFar = !m(0, 0) && !m(10, 0) && !m(-10, 0) && !m(0, 10) && !m(0, -10) && !m(10, 10) && !m(-10, -10) && !m(10, -10) && !m(-10, 10);
    const known = map.support[i] > 0.2;
    const v = known ? map.score[i] : 0;
    all += v;
    if (isFgCore) { fgN++; fgSum += v; if (known) fgKnown++; maxFg = Math.max(maxFg, v); }
    if (isBgFar) { bgN++; bgSum += v; if (known && map.score[i] > 0.3) bgBright++; }
  }
  return {
    fgMean: fgN ? fgSum / fgN : 0, fgCov: fgN ? fgKnown / fgN : 0,
    bgBright: bgN ? bgBright / bgN : 0, bgMeanAll: bgN ? bgSum / bgN : 0, allMeanAll: all / (map.width * map.height), maxFg,
  };
}
