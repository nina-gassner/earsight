import { describe, it, beforeAll } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadCvNode } from './cvNode';
import { DEFAULT_CONFIG, SCENARIO_NAMES, haveFrames, loadScenario, runScenario, objective, type Config, type Loaded } from './evalHarness';

/**
 * Calibration of the hand-set thresholds on rendered Sponza walk-throughs (the motion model is not a trained network).
 * Train / validation split is by SCENARIO, so the chosen setting is also checked on walks it was not tuned on.
 * Run on demand:  EVAL_CALIBRATE=1 npx vitest run tests/evalCalibrate.test.ts   (appends to test-results/eval-calibration.jsonl)
 */
const TRAIN = new Set(['clear_walk', 'wall_approach', 'head_on_person', 'pan_in_place']);
const VALID = new Set(['side_column', 'person_to_static_cam', 'crossing_person']);
const SLICE = process.env.EVAL_SLICE ?? ''; // e.g. "0-3": run only these grid indices (lets several processes share the grid)
const OUT = `test-results/eval-calibration${SLICE ? '-' + SLICE : ''}.jsonl`;

let cv: unknown;
const data: Record<string, Loaded> = {};
beforeAll(async () => { cv = (await loadCvNode()).cv; mkdirSync('test-results', { recursive: true }); writeFileSync(OUT, ''); });

const GRID: { label: string; cfg: Config }[] = [];
for (const sensitivity of [1, 1.6])
  for (const smoothingMs of [100, 200])
    for (const edgeWeight of [1, 0.4])
      for (const windowMs of [200, 350])
        GRID.push({
          label: `sens=${sensitivity} smooth=${smoothingMs} edge=${edgeWeight} window=${windowMs}`,
          cfg: { ...DEFAULT_CONFIG, edgeWeight, motion: { sensitivity, smoothingMs, windowMs } },
        });

describe.skipIf(!haveFrames() || !process.env.EVAL_CALIBRATE)('Sponza calibration', () => {
  const [lo, hi] = SLICE ? SLICE.split('-').map(Number) : [0, GRID.length - 1];
for (const { label, cfg } of GRID.filter((_, i) => i >= lo && i <= hi)) {
    it(label, () => {
      const scores = SCENARIO_NAMES.map((n) => runScenario(cv, (data[n] ??= loadScenario(n)), cfg).score);
      appendFileSync(OUT, JSON.stringify({ label, train: objective(scores, TRAIN), valid: objective(scores, VALID), all: objective(scores, new Set(SCENARIO_NAMES)), scores }) + '\n');
    }, 900_000);
  }
});
