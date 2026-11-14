/** Pure helper: turn a grayscale-like evidence map into left/right loudness (0..1). */

export interface LevelOptions {
  /** values below this (0..1) are ignored; only "bright" pixels contribute */
  threshold: number;
  /** fraction of a half-image that must be bright for full loudness (smaller = more sensitive) */
  reference: number;
  /** the picture is shown mirrored, so displayed-left = image-right */
  mirror: boolean;
  /** user toggle: swap left and right ears */
  flip: boolean;
}

export function computeStereoLevels(values: ArrayLike<number>, width: number, height: number, o: LevelOptions): { left: number; right: number } {
  if (!(width > 1) || !(height > 0) || values.length < width * height) return { left: 0, right: 0 };
  const half = Math.floor(width / 2);
  let sL = 0, sR = 0;
  const span = Math.max(1e-6, 1 - o.threshold);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = values[row + x];
      if (!(v > o.threshold)) continue;
      const e = (v - o.threshold) / span;
      if (x < half) sL += e; else sR += e;
    }
  }
  const area = half * height;
  const lvl = (s: number) => Math.min(1, Math.sqrt(s / area / Math.max(1e-6, o.reference)));
  let imgL = lvl(sL), imgR = lvl(sR);
  // image-left -> displayed-left unless mirrored
  let left = o.mirror ? imgR : imgL;
  let right = o.mirror ? imgL : imgR;
  if (o.flip) [left, right] = [right, left];
  return { left, right };
}

/**
 * Mean closeness (0..1) under the bright pixels of `values` (weighted by how far above the threshold they are).
 * `closeness` may have a different resolution than `values` (nearest-neighbour lookup). NaN if nothing is bright.
 */
export function weightedCloseness(
  values: ArrayLike<number>, w: number, h: number, threshold: number,
  closeness: { data: ArrayLike<number>; width: number; height: number },
): number {
  let sw = 0, sc = 0;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(closeness.height - 1, Math.floor((y / h) * closeness.height));
    for (let x = 0; x < w; x++) {
      const v = values[y * w + x];
      if (!(v > threshold)) continue;
      const cx = Math.min(closeness.width - 1, Math.floor((x / w) * closeness.width));
      const wt = v - threshold;
      sw += wt; sc += wt * closeness.data[cy * closeness.width + cx];
    }
  }
  return sw > 0 ? sc / sw : NaN;
}
