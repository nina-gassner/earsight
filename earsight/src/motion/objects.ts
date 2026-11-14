/**
 * "Separable object" filter.
 * Things we care about are compact, solid, sharp-edged regions. Smooth gradients (flickering background, exposure
 * or depth-normalisation drift), regions that fill much of the frame, thin streaks and speckle are rejected.
 */

export interface ObjectFilterOptions {
  /** pixels above this value are candidate foreground */
  threshold: number;
  /** area limits as fractions of the whole map */
  minAreaFrac: number;
  maxAreaFrac: number;
  /** minimum (component area / bounding-box area): rejects streaks and diagonal bands */
  minFill: number;
  /** minimum bounding-box side as a fraction of the map width (rejects 1-pixel-thin lines) */
  minSideFrac: number;
  /** minimum mean contrast across the region boundary (inside value minus value 2 px outside): rejects gradients */
  minEdgeContrast: number;
  /** reject wide, flat regions touching the bottom edge (the floor) */
  rejectFloor: boolean;
}

export const APPROACH_OBJECT_OPTS: ObjectFilterOptions = {
  threshold: 0.2, minAreaFrac: 0.003, maxAreaFrac: 0.35, minFill: 0.3, minSideFrac: 0.03, minEdgeContrast: 0.04, rejectFloor: true,
};
export const CLOSENESS_OBJECT_OPTS: ObjectFilterOptions = {
  threshold: 0.6, minAreaFrac: 0.004, maxAreaFrac: 0.5, minFill: 0.3, minSideFrac: 0.04, minEdgeContrast: 0.12, rejectFloor: true,
};

export interface ObjectInfo {
  area: number;
  x0: number; y0: number; x1: number; y1: number;
  cx: number; cy: number;
  fill: number;
  edge: number;
  accepted: boolean;
  reason: string;
}

export interface ObjectResult {
  /** 1 where a pixel belongs to an accepted object */
  keep: Uint8Array;
  objects: ObjectInfo[];
}

export function extractObjects(v: ArrayLike<number>, w: number, h: number, o: ObjectFilterOptions): ObjectResult {
  const n = w * h;
  const keep = new Uint8Array(n);
  const objects: ObjectInfo[] = [];
  if (w < 4 || h < 4 || v.length < n) return { keep, objects };
  const label = new Int32Array(n); // 0 = unvisited / background
  const stack = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] !== 0 || !(v[s] > o.threshold)) continue;
    next++;
    let sp = 0;
    stack[sp++] = s; label[s] = next;
    const pix: number[] = [];
    let x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      pix.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      sx += x; sy += y;
      if (x > 0 && label[p - 1] === 0 && v[p - 1] > o.threshold) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && label[p + 1] === 0 && v[p + 1] > o.threshold) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && label[p - w] === 0 && v[p - w] > o.threshold) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && label[p + w] === 0 && v[p + w] > o.threshold) { label[p + w] = next; stack[sp++] = p + w; }
    }
    const area = pix.length;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const fill = area / (bw * bh);
    // boundary contrast: for each boundary pixel compare with the pixel 2 steps outward across the boundary
    let eSum = 0, eN = 0;
    for (const p of pix) {
      const x = p % w, y = (p / w) | 0;
      const dirs: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dx, dy] of dirs) {
        const ax = x + dx, ay = y + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue; // image border is not an edge
        if (label[ay * w + ax] === next) continue;
        const ox = Math.min(w - 1, Math.max(0, x + 2 * dx)), oy = Math.min(h - 1, Math.max(0, y + 2 * dy));
        eSum += v[p] - v[oy * w + ox]; eN++;
        break;
      }
    }
    const edge = eN > 0 ? eSum / eN : 1; // region touching only the border: no measurable edge, treat as sharp
    let reason = '';
    if (area / n < o.minAreaFrac) reason = 'too-small';
    else if (area / n > o.maxAreaFrac) reason = 'too-large';
    else if (fill < o.minFill) reason = 'not-compact';
    else if (Math.min(bw, bh) / w < o.minSideFrac) reason = 'too-thin';
    else if (edge < o.minEdgeContrast) reason = 'soft-edge';
    else if (o.rejectFloor && y1 >= h - 3 && bw / w >= 0.35 && bw / bh >= 1.4) reason = 'floor-like';
    const accepted = reason === '';
    if (accepted) for (const p of pix) keep[p] = 1;
    objects.push({ area, x0, y0, x1, y1, cx: sx / area, cy: sy / area, fill, edge, accepted, reason });
  }
  return { keep, objects };
}

/** zero out candidate pixels (value > threshold) that do not belong to an accepted object; returns a new array */
export function suppressNonObjects(v: ArrayLike<number>, w: number, h: number, o: ObjectFilterOptions): Float32Array {
  const { keep } = extractObjects(v, w, h, o);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = keep[i] || !(v[i] > o.threshold) ? v[i] : 0;
  return out;
}
