import { SyntheticScene, type SceneKind } from './scenes';
import type { FrameInfo } from '../camera';

/** Plays a labelled synthetic scene on a canvas so it can be fed through the exact same pipeline as the webcam. */
export class SyntheticSource {
  readonly canvas = document.createElement('canvas');
  readonly scene: SyntheticScene;
  private ctx: CanvasRenderingContext2D;
  private timer = 0;
  private t0 = 0;
  /** foreground mask of the most recently drawn frame (for the live self-check) */
  fgMask: Uint8Array | null = null;
  width = 320;
  height = 240;

  constructor(kind: SceneKind) {
    this.scene = new SyntheticScene(kind, 320, 240);
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  private draw(tSec: number) {
    const f = this.scene.render(tSec);
    const img = this.ctx.createImageData(this.width, this.height);
    for (let i = 0; i < f.gray.length; i++) { const g = f.gray[i]; img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = g; img.data[4 * i + 3] = 255; }
    this.ctx.putImageData(img, 0, 0);
    this.fgMask = f.fgMask;
  }

  start(cb: (info: FrameInfo) => void) {
    this.t0 = performance.now();
    this.draw(0);
    this.timer = window.setInterval(() => {
      const now = performance.now();
      // loop the scene; the discontinuity at the loop point is a bad-gap/reset test of the pipeline
      const t = ((now - this.t0) / 1000) % (this.scene.duration + 0.5);
      this.draw(Math.min(t, this.scene.duration));
      cb({ tCapture: now, tCallback: now, fromMetadata: false });
    }, 1000 / 30);
  }

  stop() { clearInterval(this.timer); this.timer = 0; }
}
