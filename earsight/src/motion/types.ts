/** Shared types for the motion (approach) pipeline. Coordinates in debug output are normalised 0..1. */

export interface GrayFrame {
  data: Uint8Array;
  width: number;
  height: number;
  /** capture timestamp in ms (performance.now() clock) */
  t: number;
}

export interface DepthHint {
  /** relative closeness 0..1 (closer = larger), at width x height */
  data: Float32Array;
  width: number;
  height: number;
  /** source timestamp in ms */
  t: number;
}

export interface DebugPoint {
  x: number;
  y: number;
  /** 0 = not part of any valid fit, 1 = supported by a valid fit */
  supported: boolean;
  /** smoothed per-track approach score */
  score: number;
}

export interface DebugFit {
  x: number;
  y: number;
  /** neighbourhood radius, normalised by image width */
  r: number;
  rate: number;
  confidence: number;
  evidence: number;
}

export interface ApproachMap {
  /** map size */
  width: number;
  height: number;
  /** approach score 0..1 (valid only where support > 0) */
  score: Float32Array;
  /** evidence weight 0..1; 0 = unknown / insufficient evidence */
  support: Float32Array;
  /** timestamp (ms) of the frame this map is anchored to */
  t: number;
  debugPoints: DebugPoint[];
  debugFits: DebugFit[];
  stats: ApproachStats;
}

export interface ApproachStats {
  tracks: number;
  fits: number;
  supportedTracks: number;
  windowSeconds: number;
  /** wall-clock processing time of this frame in ms */
  procMs: number;
  /** true if the frame was judged blank / covered */
  blank: boolean;
  /** true if tracking was reset on this frame (bad timestamp, gap, blank) */
  reset: boolean;
  note: string;
  /** counts of why local fits were rejected (diagnostics) */
  failReasons: Record<string, number>;
}

export interface MotionSettings {
  /** processing width in px (height follows aspect) */
  procWidth: number;
  /** tracking window in ms (reference-frame lag used for the expansion fit) */
  windowMs: number;
  /** multiplies rateLow/rateHigh: >1 = more sensitive (lower thresholds) */
  sensitivity: number;
  /** temporal smoothing time constant in ms for per-track scores */
  smoothingMs: number;
  /** limit propagation of approach estimates with the (stale) depth map */
  useDepthGate: boolean;
  /** regions whose relative closeness is below this (0..1) are treated as too far to matter; 0 = off */
  nearThreshold: number;
  /** subtract the scene-wide (median) expansion rate: ignores camera motion / floor, keeps things approaching faster than the scene */
  egoComp: boolean;
  /** remove camera pan/tilt/roll (rotational flow) before fitting expansion */
  derotate: boolean;
  /** keep only evidence on a plausible collision path (constant bearing + growth); suppresses things we merely pass */
  pathGate: boolean;
  /** path gate: lateral miss distance (m) up to which evidence is fully kept; fades out over the following 0.5 m */
  pathHalfWidth: number;
  /** ignore approach evidence while the camera turns faster than this many deg/s (0 = off): turning in place fakes expansion */
  maxTurnDegPerSec: number;
  /** assumed closing speed in m/s used to turn expansion rate into distance */
  walkSpeed: number;
  /** assumed horizontal field of view of the camera in degrees (phones are typically 60-75) */
  hfovDeg: number;
}

export const DEFAULT_MOTION_SETTINGS: MotionSettings = {
  procWidth: 320,
  windowMs: 200,
  sensitivity: 1.4, // calibrated on Sponza walk-throughs together with the path gate (see README)
  smoothingMs: 200,
  useDepthGate: true,
  nearThreshold: 0.45,
  egoComp: true,
  derotate: true,
  pathGate: true, // ignore things we merely pass (tables, columns) but keep near misses: see pathHalfWidth
  pathHalfWidth: 1.5, // kept fully up to 1.5 m lateral miss distance, fades out over the next 0.5 m
  maxTurnDegPerSec: 45,
  walkSpeed: 1.4,
  hfovDeg: 70,
};

/**
 * Interface for anything that produces an approach map from timestamped frames.
 * The optical-expansion baseline implements it; a learned motion-in-depth model could replace it.
 */
export interface ApproachEstimator {
  init(): Promise<void>;
  configure(s: Partial<MotionSettings>): void;
  setDepth(d: DepthHint | null): void;
  process(frame: GrayFrame): ApproachMap;
  reset(): void;
  dispose(): void;
}
