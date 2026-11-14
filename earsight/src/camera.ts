/** Camera capture: permission, device enumeration, switching, error messages, frame timestamps. */

export interface FrameInfo {
  /** capture timestamp in ms on the performance.now() clock (camera-provided captureTime if available, else callback time) */
  tCapture: number;
  /** time the callback ran */
  tCallback: number;
  /** whether tCapture came from the browser's video-frame metadata rather than the callback time */
  fromMetadata: boolean;
}

export function describeCameraError(e: unknown): string {
  const name = (e as any)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was denied. In Edge click the camera/lock icon in the address bar (or open edge://settings/content/camera), allow the camera for localhost, then press “Start camera” again. Also check Windows Settings → Privacy & security → Camera.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera could not be opened — it is probably in use by another app (Teams, Zoom, the Windows Camera app, another browser tab) or blocked by Windows privacy settings. Close the other app and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found. Plug in or enable a webcam, or pick a different device in the list. (You can still try the “Synthetic” test scenes.)';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'The selected camera cannot deliver the requested resolution/device. Try a lower capture resolution or another camera.';
    case 'SecurityError':
      return 'The browser blocked camera access for security reasons. Use http://localhost (not a LAN IP) or HTTPS.';
    case 'AbortError':
      return 'Camera start was aborted by the browser or driver. Try again.';
    default:
      return `Camera error: ${(e as any)?.message ?? String(e)}`;
  }
}

export class CameraController {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;
  private rvfcHandle = 0;
  private running = false;
  /** actual settings reported by the track */
  settings: MediaTrackSettings | null = null;
  /** notes about optional camera effects we could / could not disable */
  effectsNote = '';

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  /** Stop and release every track of the current stream. */
  stop() {
    this.running = false;
    if (this.rvfcHandle && 'cancelVideoFrameCallback' in this.video) (this.video as any).cancelVideoFrameCallback(this.rvfcHandle);
    this.rvfcHandle = 0;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.settings = null;
  }

  async start(deviceId: string | undefined, width: number, height: number): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'SecurityError' });
    this.stop(); // stop old tracks BEFORE opening the new device
    const build = (relaxed: boolean): MediaStreamConstraints => ({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
        ...(relaxed ? {} : { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } }),
      },
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(build(false));
    } catch (e: any) {
      if (e?.name === 'OverconstrainedError' || e?.name === 'ConstraintNotSatisfiedError') stream = await navigator.mediaDevices.getUserMedia(build(true));
      else throw e;
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    await this.disableEffects(track);
    this.settings = track.getSettings();
    this.video.srcObject = stream;
    await this.video.play();
    await this.waitForUsableFrame();
    this.running = true;
  }

  /** Try to switch off zoom / framing / blur effects that would change image geometry. Best effort. */
  private async disableEffects(track: MediaStreamTrack) {
    const notes: string[] = [];
    const caps: any = (track as any).getCapabilities?.() ?? {};
    const adv: any[] = [];
    if ('zoom' in caps) adv.push({ zoom: caps.zoom?.min ?? 1 });
    if ('backgroundBlur' in caps) adv.push({ backgroundBlur: false });
    if ('faceFraming' in caps) adv.push({ faceFraming: false });
    if ('eyeGazeCorrection' in caps) adv.push({ eyeGazeCorrection: false });
    for (const a of adv) {
      try { await track.applyConstraints({ advanced: [a] } as any); notes.push(`${Object.keys(a)[0]} disabled`); }
      catch { notes.push(`${Object.keys(a)[0]} could not be set`); }
    }
    this.effectsNote = notes.length ? notes.join(', ') : 'No zoom/framing controls exposed by this camera — disable any “auto framing” in the Windows camera settings / driver app yourself.';
  }

  private waitForUsableFrame(): Promise<void> {
    return new Promise((resolve, reject) => {
      const v = this.video;
      const t0 = performance.now();
      const check = () => {
        if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2 && v.currentTime >= 0) return resolve();
        if (performance.now() - t0 > 8000) return reject(Object.assign(new Error('Camera produced no usable frame within 8 s'), { name: 'NotReadableError' }));
        setTimeout(check, 50);
      };
      check();
    });
  }

  get width() { return this.video.videoWidth; }
  get height() { return this.video.videoHeight; }

  /** Calls cb once per new video frame (requestVideoFrameCallback where available, else rAF). */
  onFrames(cb: (info: FrameInfo) => void) {
    const v: any = this.video;
    const loop = (_now: number, meta?: any) => {
      if (!this.running) return;
      const tCallback = performance.now();
      const mt = meta?.captureTime ?? meta?.presentationTime;
      cb({ tCapture: typeof mt === 'number' && mt > 0 && mt <= tCallback + 5 ? mt : tCallback, tCallback, fromMetadata: typeof mt === 'number' && mt > 0 });
      this.rvfcHandle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop as any);
    };
    this.rvfcHandle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop as any);
  }

  /** mark running (used by synthetic source that shares the same pipeline) */
  get isRunning() { return this.running; }
}
