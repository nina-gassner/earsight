/** Evaluation harness (Node): runs the real motion pipeline on rendered Sponza walk-throughs and scores it. */
import { existsSync, readFileSync } from 'node:fs';
import { ExpansionApproachEstimator } from '../src/motion/expansionEstimator';
import { DEFAULT_EXPANSION_PARAMS, type ExpansionParams } from '../src/motion/expansion';
import { DEFAULT_MOTION_SETTINGS, type MotionSettings } from '../src/motion/types';
import { suppressNonObjects, APPROACH_OBJECT_OPTS } from '../src/motion/objects';
import { computeStereoLevels } from '../src/audio/levels';
import { SoundGate } from '../src/audio/gate';

export const EVAL_DIR = 'test-results/eval';
export const SCENARIO_NAMES = ['clear_walk', 'wall_approach', 'side_column', 'head_on_person', 'person_to_static_cam', 'crossing_person', 'pan_in_place'];
/** hazard scenarios (something is on a collision course); the others must stay quiet */
export const HAZARD_SCENARIOS = new Set(['wall_approach', 'side_column', 'head_on_person', 'person_to_static_cam']);

export interface Meta { name: string; width: number; height: number; fps: number; frames: number; distances: number[]; ttc: (number | null)[] }
export interface Loaded { meta: Meta; frames: Uint8Array }

export const haveFrames = () => SCENARIO_NAMES.every((n) => existsSync(`${EVAL_DIR}/${n}.bin`) && existsSync(`${EVAL_DIR}/${n}.json`));

export function loadScenario(name: string): Loaded {
  const meta = JSON.parse(readFileSync(`${EVAL_DIR}/${name}.json`, 'utf-8')) as Meta;
  const b = readFileSync(`${EVAL_DIR}/${name}.bin`);
  return { meta, frames: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
}

export interface Config {
  motion: Partial<MotionSettings>;
  expansion: Partial<ExpansionParams>;
  objectFilter: boolean;
  /** process every n-th rendered frame (the app manages about 10 fps on a 30 fps camera) */
  stride: number;
  /** centre bias of the sound levels (1 = none) */
  edgeWeight: number;
}
export const DEFAULT_CONFIG: Config = { motion: {}, expansion: {}, objectFilter: true, stride: 3, edgeWeight: 1 };

export interface FrameResult { i: number; t: number; alarm: boolean; corridorAlarm: boolean; level: number }
export interface ScenarioScore {
  name: string;
  hazardFrames: number;
  recall: number; // alarm frames among hazard frames
  leadTime: number | null; // seconds between the first sustained alarm and contact (null: never alarmed)
  firstAlarmDistance: number | null;
  quietFrames: number;
  falseAlarmFraction: number; // alarm frames among non-hazard frames
  corridorFalseAlarmFraction: number;
  corridorRecall: number;
  corridorLeadTime: number | null;
  corridorFirstAlarmDistance: number | null;
}

export function runScenario(cv: unknown, data: Loaded, cfg: Config): { results: FrameResult[]; score: ScenarioScore } {
  const { meta, frames } = data;
  const W = meta.width, H = meta.height;
  const est = new ExpansionApproachEstimator(cv, { ...DEFAULT_EXPANSION_PARAMS, ...cfg.expansion });
  est.configure({ ...DEFAULT_MOTION_SETTINGS, ...cfg.motion });
  const gate = new SoundGate(), gateC = new SoundGate();
  const results: FrameResult[] = [];
  let evBuf = new Float32Array(0);
  for (let i = 0; i < meta.frames; i += cfg.stride) {
    const t = 1000 + (i * 1000) / meta.fps;
    const map = est.process({ data: frames.subarray(i * W * H, (i + 1) * W * H), width: W, height: H, t });
    const n = map.width * map.height;
    if (evBuf.length !== n) evBuf = new Float32Array(n);
    for (let k = 0; k < n; k++) { const sp = map.support[k]; evBuf[k] = sp < 0.22 ? 0 : map.score[k] * Math.min(1, (sp - 0.22) / 0.28); }
    const ev = cfg.objectFilter ? suppressNonObjects(evBuf, map.width, map.height, APPROACH_OBJECT_OPTS) : evBuf;
    const opts = { threshold: 0.25, reference: 0.03, mirror: false, flip: false, edgeWeight: cfg.edgeWeight };
    const lv = computeStereoLevels(ev, map.width, map.height, opts);
    gate.step(lv.left, lv.right, t);
    // corridor: centre half of the image width
    const x0 = Math.floor(map.width * 0.25), x1 = Math.floor(map.width * 0.75);
    const cw = x1 - x0;
    const crop = new Float32Array(cw * map.height);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = ev[y * map.width + x0 + x];
    const lc = computeStereoLevels(crop, cw, map.height, opts);
    gateC.step(lc.left, lc.right, t);
    results.push({ i, t, alarm: gate.on, corridorAlarm: gateC.on, level: Math.max(lv.left, lv.right) });
  }
  est.dispose();
  return { results, score: scoreScenario(meta, results) };
}

export function scoreScenario(meta: Meta, results: FrameResult[]): ScenarioScore {
  const pan = meta.name === 'pan_in_place';
  const isHazardScenario = HAZARD_SCENARIOS.has(meta.name);
  const hazard = (i: number) => !pan && meta.ttc[i] !== null && (meta.ttc[i] as number) < 2.5 && meta.distances[i] < 8;
  const quiet = (i: number) => pan || meta.ttc[i] === null || (meta.ttc[i] as number) > 4;
  let hz = 0, hzAlarm = 0, hzCorr = 0, q = 0, qAlarm = 0, qCorr = 0;
  let firstAlarm: FrameResult | null = null, firstCorr: FrameResult | null = null;
  for (const r of results) {
    if (hazard(r.i)) { hz++; if (r.alarm) hzAlarm++; if (r.corridorAlarm) hzCorr++; }
    if (quiet(r.i)) { q++; if (r.alarm) qAlarm++; if (r.corridorAlarm) qCorr++; }
    // first alarm that comes while an obstacle is within 8 m (earlier alarms are not warnings about anything)
    if (isHazardScenario && meta.distances[r.i] < 8) {
      if (!firstAlarm && r.alarm) firstAlarm = r;
      if (!firstCorr && r.corridorAlarm) firstCorr = r;
    }
  }
  // contact = first frame with distance < 0.5 m, otherwise the end of the sequence
  let contactT = (meta.frames * 1000) / meta.fps;
  for (let i = 0; i < meta.frames; i++) if (meta.distances[i] < 0.5) { contactT = (i * 1000) / meta.fps; break; }
  const lead = (f: FrameResult | null) => (f ? Math.max(0, (contactT - (f.i * 1000) / meta.fps) / 1000) : isHazardScenario ? 0 : null);
  return {
    name: meta.name, hazardFrames: hz, recall: hz ? hzAlarm / hz : NaN, leadTime: lead(firstAlarm),
    firstAlarmDistance: firstAlarm ? meta.distances[firstAlarm.i] : null,
    quietFrames: q, falseAlarmFraction: q ? qAlarm / q : 0, corridorFalseAlarmFraction: q ? qCorr / q : 0,
    corridorRecall: hz ? hzCorr / hz : NaN, corridorLeadTime: lead(firstCorr),
    corridorFirstAlarmDistance: firstCorr ? meta.distances[firstCorr.i] : null,
  };
}

/**
 * objective: what the wearer hears. Mean hazard-frame recall of the alarm (did it sound while a collision was imminent?)
 * minus 2 x mean fraction of quiet frames with an alarm (constant noise while nothing threatens).
 */
export function objective(scores: ScenarioScore[], names: Set<string>): { value: number; recall: number; fa: number } {
  const hs = scores.filter((s) => names.has(s.name) && HAZARD_SCENARIOS.has(s.name) && s.hazardFrames > 0);
  const recall = hs.length ? hs.reduce((a, s) => a + s.recall, 0) / hs.length : 0;
  const qs = scores.filter((s) => names.has(s.name));
  const fa = qs.length ? qs.reduce((a, s) => a + s.falseAlarmFraction, 0) / qs.length : 0;
  return { value: recall - 2 * fa, recall, fa };
}
