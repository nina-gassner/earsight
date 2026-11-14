import { createRequire } from 'node:module';

/** Node-only OpenCV loader (bypasses vite-node's module interop, which hangs on the thenable Emscripten module). */
export function loadCvNode(): Promise<{ cv: any }> {
  const require = createRequire(import.meta.url);
  const cv = require('@techstark/opencv-js');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('opencv init timeout')), 60000);
    const done = () => { clearTimeout(timer); resolve({ cv }); };
    if (cv.Mat) done(); else cv.onRuntimeInitialized = done;
  });
}
