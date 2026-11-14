import cvModule from '@techstark/opencv-js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type CV = any;

const REQUIRED = [
  'Mat', 'matFromArray', 'calcOpticalFlowPyrLK', 'goodFeaturesToTrack', 'TermCriteria', 'Size', 'Rect', 'circle', 'Scalar', 'meanStdDev',
  'CV_8UC1', 'CV_32FC2',
];

let cached: Promise<{ cv: CV }> | null = null;

/**
 * Initialise the bundled OpenCV.js WASM build (@techstark/opencv-js, OpenCV 4.12 — WASM is embedded in the JS file,
 * so there is no extra network fetch).
 * NOTE: the module object is itself "thenable", so it must never be passed to resolve()/await directly.
 */
export function loadOpenCV(): Promise<{ cv: CV }> {
  if (!cached) {
    cached = new Promise<{ cv: CV }>((resolve, reject) => {
      const cv: any = cvModule as any;
      const timer = setTimeout(() => reject(new Error('OpenCV.js initialisation timed out')), 60000);
      const done = () => { clearTimeout(timer); resolve({ cv }); };
      if (cv.Mat) done();
      else cv.onRuntimeInitialized = done;
    });
  }
  return cached.then(({ cv }) => {
    const missing = REQUIRED.filter((k) => cv[k] === undefined);
    if (missing.length) throw new Error('OpenCV.js build lacks required API: ' + missing.join(', '));
    return { cv: cv as CV }; // wrapped: returning the thenable module itself would hang the promise chain
  });
}
