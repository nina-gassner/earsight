import { describe, it, beforeAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCvNode } from './cvNode';
import { DEFAULT_CONFIG, SCENARIO_NAMES, haveFrames, loadScenario, runScenario, type Config } from './evalHarness';

/** Baseline: current app defaults on the rendered Sponza walk-throughs. Skipped when the frames have not been rendered. */
let cv: unknown;
beforeAll(async () => { cv = (await loadCvNode()).cv; });

const variants: Record<string, Config> = {
  'path gate ON (new defaults)': DEFAULT_CONFIG,
  'path gate OFF': { ...DEFAULT_CONFIG, motion: { pathGate: false } },
  'path gate ON, sens 1.6': { ...DEFAULT_CONFIG, motion: { sensitivity: 1.6 } },
  'path gate ON, sens 1.6, speed 1.0': { ...DEFAULT_CONFIG, motion: { sensitivity: 1.6, walkSpeed: 1.0 } },
};
const REPORT = `test-results/eval-baseline-${process.env.EVAL_TAG ?? 'all'}.json`;
const report: Record<string, unknown> = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf-8')) : {}; // merge across separate runs

describe.skipIf(!haveFrames())('Sponza walk-through baseline', () => {
  for (const [label, cfg] of Object.entries(variants)) {
    it(label, () => {
      report[label] = SCENARIO_NAMES.map((n) => runScenario(cv, loadScenario(n), cfg).score);
      mkdirSync('test-results', { recursive: true });
      writeFileSync(REPORT, JSON.stringify(report, null, 1)); // incremental
    }, 600_000);
  }
});
