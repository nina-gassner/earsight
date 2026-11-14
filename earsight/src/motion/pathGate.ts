/**
 * "Is it on my path?" from expansion alone (constant bearing + growth = collision course).
 *
 * For a point at image offset (dx, dy) pixels from the focus of expansion, approaching with expansion rate r (1/s) at
 * closing speed v (m/s): distance Z = v / r, so its lateral / vertical offset in metres is  X = dx / f * Z,  Y = dy / f * Z.
 * A body of half-width ~0.45 m walking forward hits it only if |X| is below that (with a margin) and it is inside
 * the vertical extent of the body (from about 0.3 m above the camera down to the feet, ~1.6 m below).
 * Things we will merely pass (columns, banners, people to the side) have a large |X| and are suppressed.
 */
export interface PathGateParams {
  /** assumed closing speed in m/s (walking ~1.2; a person walking towards you adds to it) */
  speed: number;
  /** half width of the body plus margin in metres where the factor starts to fall / reaches zero */
  halfWidthStart: number;
  halfWidthEnd: number;
  /** vertical extent in metres relative to the camera (negative = above) */
  top: number;
  bottom: number;
}

export const DEFAULT_PATH_GATE: PathGateParams = { speed: 1.4, halfWidthStart: 0.6, halfWidthEnd: 1.1, top: -0.5, bottom: 1.9 };

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 0..1: how plausibly the point is on the collision path */
export function pathFactor(dxPx: number, dyPx: number, rate: number, focalPx: number, p: PathGateParams = DEFAULT_PATH_GATE): number {
  if (!(rate > 1e-3) || !(focalPx > 0)) return 0;
  const Z = p.speed / rate; // metres
  const X = Math.abs(dxPx / focalPx) * Z;
  const Y = (dyPx / focalPx) * Z; // positive = below the optical axis
  const lateral = 1 - smooth(p.halfWidthStart, p.halfWidthEnd, X);
  const vertical = smooth(p.top - 0.5, p.top, Y) * (1 - smooth(p.bottom, p.bottom + 0.8, Y));
  return lateral * vertical;
}
