# Earsight — Approach Explorer

Local webcam research prototype with three equally sized panels:

1. **Camera** – original colour view.
2. **Relative closeness — not metres** – Depth Anything V2 (small), closer = whiter.
3. **Approach evidence** – local optical expansion of tracked features; bright = reliable evidence that a surface is getting closer to the camera (object moving toward the camera *or* camera moving toward the scene). Stationary and receding regions are dark; regions without enough evidence are hatched (“unknown”).

No audio, spoken guidance, object labels or collision alarms. Frames are processed locally (no server, no API keys).

## Setup (Windows, Microsoft Edge)

```
npm install
npm run dev        # http://localhost:5173
```
Open the URL in Edge (113+ for WebGPU), press **Start camera**, allow the camera. Other commands: `npm test`, `npm run typecheck`, `npm run build`, `npm run inspect-depth`.

**Network/caching (accurate as tested):** on first use the browser downloads the model files from `huggingface.co` (fp16 ONNX, tens of MB) and the ONNX-Runtime-Web runtime files from `cdn.jsdelivr.net` (transformers.js default). transformers.js stores them in the browser Cache Storage, so later starts should work without network; *offline operation after caching was not tested*. OpenCV.js (WASM embedded in the JS bundle) needs no extra download.

## Depth model
`onnx-community/depth-anything-v2-small` via `@huggingface/transformers` 4.3.2, `AutoModel`/`AutoProcessor`, WebGPU + fp16. Optional slower **WASM CPU (q8)** backend (selectable; CPU/q8 inference was verified in Node with onnxruntime-node, not in the browser WASM backend). No other model is substituted.

* Preprocessing is the model's own `DPTImageProcessor` (ImageNet mean/std, keep aspect ratio, sizes rounded to multiples of 14). Only the target size is adjustable (196–518).
* **Output representation (inspected, `npm run inspect-depth`, output in `test-results/`)**: float32 tensor `[1,H,W]`, e.g. 308×406 for a 640×480 input at size 308. It is relative inverse depth (disparity-like), **larger raw value = closer**; checked on a real photo (nearest cat head is the brightest, far couch back darkest). Not metric, and its scale changes per frame.
* Display: 2nd/98th percentile bounds, exponentially smoothed over time (configurable); the spatial map of each frame is never averaged with other frames (no trails). A frame-to-frame “approach from depth” is deliberately **not** used.

## Approach estimation (the central part)
Category-independent, `src/motion/`:

1. Grey frames at reduced width (default 320 px) with actual capture timestamps (`requestVideoFrameCallback` `captureTime` when the browser gives it, else callback time).
2. Shi–Tomasi features per grid cell (spatial spread), replenished every 5 frames or immediately when support falls.
3. Pyramidal Lucas–Kanade (OpenCV.js `calcOpticalFlowPyrLK`) with forward/backward validation; no empty matrices are ever passed.
4. Each track keeps a short history; correspondences are taken between the current frame and the frame ≈ *window* (default 200 ms, 100–300) earlier, using real elapsed seconds.
5. Overlapping neighbourhoods (radius ≈ 11 % of width): robust affine `q = A p + b` via RANSAC (MSAC, deterministic seed) + inlier refit, a second layer on the remaining points (object boundaries). Requires ≥ 8 points, ≥ 6 inliers, ≥ 60 % inlier fraction, residual RMS, spatial spread, `det > 0` (no reflections), anisotropy ≤ 1.3, plausible scale. These gates reduce coverage by design.
6. `expansionRate = ln(sqrt(det A)) / Δt` [1/s]. Translation and in-plane rotation do not enter it. No global affine/homography is subtracted, so forward camera motion stays detectable.
7. Evidence = ramp(rate, 0.15 → 0.6 /s, scaled by *sensitivity*) × significance (rate / σ) × confidence gate. These are **fixed physical thresholds**, never per-frame stretched. Persistence is an EMA stored **on each track** (dies with the track; no ghost trails).
8. Sparse track scores are splatted with a small radius (≈ one neighbourhood spacing) into the map; no evidence → unknown. If depth is available it only limits propagation across large closeness differences (optional, stale-tolerant).

`ApproachEstimator` (`src/motion/types.ts`) is the interface a learned motion-in-depth model could implement.

### Limitations (please read)
* A proxy under local geometric assumptions: planar-ish textured patches, fixed zoom. Not a universal 3-D motion measurement.
* Camera pan/tilt with perspective, deformation, rolling shutter, optical/digital zoom, auto-framing and exposure changes can produce false or missing expansion. They are **not solved**. We try to disable zoom/framing/blur via track constraints where the camera exposes them; some drivers ignore this.
* Needs texture: plain walls/surfaces yield “unknown”, not “safe”. Dark ≠ safe; dark means “valid support, no positive approach evidence”.
* Very slow approach (rate < ~0.15 /s) and fast motion (> ~25 % of the frame per step, or blur) are not detected.
* Motion and depth are asynchronous; panels show their own source timestamps. The depth gate can be a few hundred ms stale.
* Latency shown is capture-timestamp → result on the page, **not** camera hardware latency.

## Architecture
```
src/camera.ts            getUserMedia, device list, error messages, frame callbacks
src/main.ts              UI + independent scheduling (camera/render loop, motion, depth)
src/depth/               worker (transformers.js), client (1 inference in flight), percentile normaliser
src/motion/expansion.ts  pure maths: robust local affine fit, expansion rate, confidence, evidence
src/motion/expansionEstimator.ts  OpenCV tracking + neighbourhood fits + per-track persistence + map
src/motion/motion.worker.ts       runs OpenCV.js off the UI thread
src/render/panels.ts     grayscale/hatch/debug rendering (mirror applied consistently)
src/synthetic/           labelled synthetic scenes, source, metrics
tests/                   vitest
```
Newest frame only is processed by each worker; frames are dropped, never queued.

## Validation
`npm test` (28 tests):
* `expansion.test.ts` – identity, translation, scale>1, scale<1 (dark), rotation, equal rate at different Δt, outliers, mixed motions, empty/insufficient/collinear/NaN/reflection input, invalid timestamps and long gaps.
* `pipeline.test.ts` – synthetic video (textured patch over textured background) through the **real OpenCV LK tracking pipeline**: approach, recession, sideways, static, rotation, plain surface; plus camera-cover/reacquisition, bad timestamps, dropped frames, 15 fps.
* `normalizer.test.ts` – depth display normalisation.

Measured (Node, 30 fps, 320×240, `test-results/pipeline-metrics.json`): approach → foreground mean 0.57, foreground coverage 100 %, bright background 0 %; recession/sideways/static/rotation → 0 everywhere with full foreground coverage; plain surface → no tracks, everything unknown. Per-frame estimator time 30–50 ms in Node under vitest.

In-browser smoke test (Chrome, synthetic scene, no camera): motion worker ran ≈ 9–21 fps (dev build, 33–75 ms/frame); depth loaded on WebGPU fp16 and ran ≈ 2.4 fps at 381–403 ms inference on this machine’s GPU. The in-app self-check line reported foreground ≈ 0.3–0.44 and bright background 0 %. **Edge and real webcam were not tested** – no camera was available. Other performance on your hardware is unknown.

### Manual test checklist (needs a camera)
Start camera, enable *Tracked points* and *Local fits*, then: [ ] move a textured book closer → brightens on the book; [ ] move it away → stays dark; [ ] move it sideways → dark; [ ] hold everything still → dark, no flicker; [ ] walk/move the camera forward → textured surfaces brighten; [ ] rotate the camera (roll) → no brightening; pan → check for false brightening (expected ambiguity); [ ] cover the camera → panel goes unknown, reacquires on uncover; [ ] plain surface → hatched/unknown. Synthetic scenes are in the Source list.

## Troubleshooting
* *Permission denied / camera busy / not found* → the page shows an actionable message; check `edge://settings/content/camera` and Windows Privacy → Camera, close Teams/Zoom.
* *Depth unavailable* → check `edge://gpu` for WebGPU, update GPU drivers, or switch to the WASM backend (slow). Camera + approach still work.
* Low motion fps → lower *Motion analysis width*; low depth fps → lower *Depth input size*.

## Licences / attribution
* Depth Anything V2 Small: Apache-2.0 (model card of `onnx-community/depth-anything-v2-small`); only the Small model carries this licence. Paper/code: https://github.com/DepthAnything/Depth-Anything-V2
* `@huggingface/transformers` Apache-2.0; `@techstark/opencv-js` (OpenCV 4.12, Apache-2.0); ONNX Runtime Web MIT.
* References: https://huggingface.co/onnx-community/depth-anything-v2-small · https://huggingface.co/spaces/Xenova/webgpu-realtime-depth-estimation · research context (not used): https://gengshan-y.github.io/expansion/ · https://github.com/HanLingsgjk/TPCV · https://github.com/DepthAnything/Video-Depth-Anything

## Update: tuning after first real-webcam feedback
Reported: almost everything "unknown", waving arm (~0.5 m) flagged unknown instead of dark, punches toward the camera and slow approach not detected.
Changes (all in `src/motion/`):
* **Multi-scale in time and space:** fits run for windows of 100 ms, the slider value, 500 ms and 1 s and neighbourhood radii of 6 % / 11 % of the width (long windows: large radius only). A track keeps the *maximum* evidence over scales: short windows for punches, long windows for slow approach (expansion noise scales with 1/Δt).
* **Valid-but-incoherent = dark, not unknown:** if tracking is reliable but the local fit is rejected as non-coherent (high residual, anisotropy, reflection, low inlier fraction, implausible scale), the tracks are marked "supported, no approach evidence". Waving or deforming limbs therefore stay dark. "Unknown" now means mostly: too few tracks / too little texture.
* **Relaxed gates** (min 6 points / 5 inliers, 50 % inliers, 1.2 px inlier threshold, anisotropy ≤ 1.5, rate ramp 0.12→0.5 /s) with a stricter significance requirement (z 3→6) and a 60–160 ms persistence gate to offset the extra false positives from taking a maximum over scales.
* **Near mask from depth:** regions with relative closeness below the "Ignore far regions" slider (default 0.15; 0 = off) are forced dark. Closeness is relative per frame, so this means "far compared with the rest of the view", not metres.
* Faster re-detection (every 3 frames), looser forward/backward check (0.8 px).
* Diagnostics: the stats line shows the top reasons local fits were rejected.

Synthetic result after the change (approach foreground mean ≈ 0.74–0.83; other scenes' scene-wide mean ≤ 0.07, bright-background pixels ≤ 3 %) – slightly more low-level false evidence than before (previously exactly 0). Cost rose: roughly 60–120 ms per frame in dev-mode Chrome/Node here (≈ 6–10 fps), which is a real limit for fast punches; lower *Motion analysis width* if needed. **Not yet verified on a real webcam**: punches and slow approach need a re-test; if still missed, read the "fit rejections" line and tell me the dominant reasons.

## Update 2: fewer false positives (receding objects, waving, background "approaching")
* **Root cause found in my code:** the right panel never used depth values, but it took the *maximum positive evidence* over many scales/neighbourhoods, so any noisy or oscillating fit could light a region. Now each tracked point keeps a **confidence-weighted mean of the signed expansion rate** over all scales, filtered over time (default 200 ms). Oscillation (waving) cancels, contraction (receding) subtracts, and significance is computed *after* filtering.
* **Exposure compensation:** each processing frame is gain-normalised to a reference mean, so auto-exposure changes or a hand shading the lens do not break Lucas–Kanade brightness constancy.
* **Middle panel renormalisation:** closeness is normalised per frame by percentile bounds, so when the nearest object (e.g. a hand) leaves, the background gets lighter without any real change. That is inherent to relative depth and cannot be removed; it only affects the right panel through the optional near mask (it can only force regions dark). Bounds smoothing now defaults to 1500 ms to damp this; the near mask can be switched off (slider 0).
* New synthetic scenes `waving` and `exposure`. Synthetic results: approach foreground ≈ 0.42 (dimmer than before, by design), all non-approach scenes ≤ 0.065 scene-wide maximum, most exactly 0. Still unverified on a real webcam.

## Update 3: fast punches
Why they were missed: only 1–3 processed frames per punch (6–10 fps), a 200 ms signed filter longer than the event, fits with scale > 2× rejected as "implausible" (then drawn dark), tiny low-texture fists with too few tracks/points.
Changes: scale limit 0.3–4×, rate clamp ±8 /s; extra 50 ms window (frame-to-frame); min 5 points / 4 inliers; **fast-attack path** – evidence that is strong (rate and significance high), confident, sustained ≥ 140 ms and agrees with the slower filtered rate shows immediately and decays with 150 ms (the agreement requirement is what keeps oscillating waving dark); adaptive cost – 500 ms/1 s windows run only every 4th frame while processing exceeds 60 ms/frame.
Synthetic: new `punch` scene (fist-sized patch, ×2.7 in 0.25 s) reaches peak foreground evidence 1.0 at both 30 and 15 fps with ≤ 0.2 % bright background. Cost: the synthetic `waving` scene (worst-case ±8 % scale wobble at 2 Hz) now shows up to ≈ 0.10 scene-wide peak (mean ≈ 0.07), previously ≈ 0.06. Real fists (blur, little texture, non-rigid) are harder than the synthetic one – re-test with the "fit rejections" line visible.

## Update 4: sound, separable objects, phone camera
* **Sound (beeps, headphones):** per-ear loudness follows where the bright regions are (left/right as displayed; Mirror is taken into account; *Flip left/right* swaps ears). Beeps repeat faster (1.5 → 12 /s) and slightly higher in pitch as the object gets closer. *Sound follows* selects the 3rd panel (approach; closeness measured from the depth map under the bright region) or the 2nd (closeness). *Beep only when approaching* (default on) silences everything unless separable approach evidence was present in the last 0.4 s. *Closeness threshold* (2nd panel) sets how close something must be (relative to the rest of the view) to count, so a distant wall is ignored; closeness is relative per frame, so the nearest thing in a bare room can still score high – the object filter below helps with that.
* **Only separable objects** (default on): bright regions must be compact, plausibly sized (not filling the frame), solid and sharp-edged; smooth gradients, huge regions, thin streaks and speckle are rejected (`src/motion/objects.ts`, unit-tested).
* **Phone camera:** `npm run dev` now serves **HTTPS** with a self-signed certificate (phones only allow camera access over HTTPS) and listens on the LAN. Choose *Phone camera* (toggle next to Source): a QR code with `https://<laptop LAN IP>:5173/phone.html?room=<random token>` appears. Scan it, accept the certificate warning, press *Start sending*; frames (JPEG over WebSocket, relayed by the dev server only between sockets that share the token) appear in all three panels. Phone capture times are mapped to the laptop clock so Wi-Fi jitter does not corrupt the elapsed-time maths; latency includes network + JPEG. **You must also accept the certificate warning once on the laptop** (Edge: Advanced → Continue to localhost). Phone and laptop need the same Wi-Fi, and Windows Firewall may ask to allow Node.js on private networks. Mirror is switched off when choosing the phone. Hold the phone landscape; portrait works but gives tall panels.
* Verified: relay between simulated phone/laptop sockets and room isolation (`node scripts/relay-test.mjs` against the running dev server), unit tests, type-check, build. **Not verified:** the full browser round trip over HTTPS (the automation browser blocked the self-signed certificate), a real phone, and the sound itself by ear.

## Update 5: run everything on the phone
Press **Run on phone (QR)**, scan, accept the certificate warning, tap *Start camera* (rear camera is preferred), tick *Sound*. Camera, OpenCV worker, depth model and audio all run **on the phone**; the laptop only serves the page (and must stay running on the same Wi-Fi). No frames travel between devices, so there is no streaming delay. On a phone the app defaults to mirror off, motion width 240 and depth input 266, and requests a screen wake lock. Needs a phone browser with WebGPU for fast depth (current Chrome on recent Android, or recent iOS Safari); otherwise choose the slow WASM backend or turn Depth off – approach beeps work without depth. The first start downloads the depth model onto the phone (internet needed once). For better performance serve the production build: `npm run build && npx vite preview --host`. **Untested on a real phone.**

Beep tuning: rate now 4 → 30 beeps/s (sqrt of urgency, where urgency = max(closeness, approach strength)), beep length shrinks with rate, and the first beep of an event is immediate. Not heard by ear here.

## Update 6: floor / camera motion / sound flicker
* **Scene-wide expansion is subtracted** (checkbox *Ignore scene-wide expansion*, default on): the weighted median per-track expansion rate of the whole view (needs ≥ 15 tracks) is removed, so camera motion and the floor/walls that expand with it no longer count; only things approaching faster than the scene stay bright. **This deliberately reverses the original spec** (forward camera motion stayed detectable); a static obstacle you walk toward is now ignored unless it expands faster than the rest of the scene. The stats line shows "scene-wide expansion X/s removed" when active.
* **Floor-like regions rejected** by the object filter: wide (≥ 35 % of the frame), flat (width/height ≥ 1.4) regions touching the bottom edge.
* **Sound flicker gate** (`src/audio/gate.ts`): evidence must appear in 2 consecutive updates (hysteresis 0.12 on / 0.05 off), short dropouts up to 300 ms are bridged, per-ear levels and beep urgency are smoothed. The approach gate for the 2nd-panel beeps uses this stabilised state too.
* New synthetic scenes `forward` (whole background expands: stays dark) and `forwardobj` (plus an object approaching faster: lights up). Unverified on a real camera and by ear. Note: a spinning orphaned test worker from an early hung run had slowed the machine during this session; it has been stopped.

QR troubleshooting: the QR code only appears after pressing **Run on phone (QR)** or **Phone camera (stream to laptop)**. The laptop's Wi-Fi address comes from the dev server (`/relay-info`), so restart `npm run dev` after updating the code. If it still cannot be detected (no Wi-Fi, VPN, or an old server), a field appears where you type the laptop's IPv4 address (`ipconfig` → Wi-Fi → IPv4 Address) and the QR is generated from that. `NO_HTTPS=1 npx vite --port 5174` starts an HTTP-only server for local debugging (camera on phones will not work over HTTP).

"Start sending" troubleshooting: the phone page shows step 1/3 (camera), 2/3 (connecting), 3/3 (sending) and error text. The laptop terminal prints `[relay] phone connected` and `[relay] first frame from phone …` when it works. The relay is attached to both `npm run dev` and `npm run phone` (vite preview). If the phone never connects: same Wi-Fi, Windows Firewall (allow Node.js on private networks), and on iPhone Safari may refuse secure WebSockets to a self-signed certificate – use Chrome on the phone or **Run on phone**.

## Update 7: evaluation on a real 3-D model, derotation and collision-path gate
**Goal:** a wearer should not walk into things. Model 3 (the approach panel) is classical tracking + geometry, **not a trained network**, so "training" here means *calibrating its hand-set thresholds* on simulated walk-throughs of a real model and checking them on walks it was not tuned on.

**Method (reproducible):** `eval-assets/sponza/` holds the Khronos glTF Sample "Sponza" atrium (Crytek, *Cryengine Limited License* – used for local testing only, do not redistribute). `src/eval/render.ts` + `src/eval/scenarios.ts` render scripted walks with head bob/sway at 30 fps / 320×240 with exact ray-cast ground truth (distance and time-to-contact along a body-width corridor), saved to `test-results/eval/`. `tests/evalHarness.ts` runs the *real* estimator on those frames at 10 fps (like the app), with the same object filter and sound gate, and scores hazard-frame recall and false alarms. Re-render: `npx vite --port 5180`, open `/eval.html`, run `evalApi.load()` then `evalApi.runAll()`; evaluate: `npx vitest run tests/evalBaseline.test.ts`; grid search: `EVAL_CALIBRATE=1 npx vitest run tests/evalCalibrate.test.ts`. Scenarios: clear walk down the nave, walk at the end wall, walk diagonally into the colonnade, head-on person-sized obstacle, person approaching a standing camera, person crossing ahead, turning the head in place. Only an interior (Sponza) was tested; **no city model**.

**What the real geometry showed (my synthetic tests had hidden all of this):**
* Turning the head: 88 % of frames alarmed. Cause: rotation stretches one side of the image and compresses the other. **Fix: `src/motion/derotate.ts`** estimates pan/tilt/roll (3 parameters, Cauchy-robust) and removes that flow before fitting expansion; forward-motion expansion (walking at a wall) is preserved. Result: 0 %.
* Walking past columns/banners: 40 % of frames alarmed (their sides expand as you pass). Parameter tuning could not fix this (sensitivity ↑ gave recall 0.70 but 86 % false alarms in the lane). **Fix: `src/motion/pathGate.ts`** – constant bearing + growth = collision course. Expansion rate gives distance (Z ≈ speed / rate), hence the object's sideways/vertical offset in metres; things wider than a body, or above head height, are suppressed. Result: 0 % false alarms in the clear walk, the turn and the crossing person.
* Calibrated defaults (adopted): sensitivity 1.6, path gate on, assumed closing speed 1.4 m/s, camera HFOV 70° (`hfovDeg`), derotation on, scene-wide-expansion removal on.

| variant (4 hazard walks, 3 quiet) | hazard-frame recall | false alarms on quiet frames |
|---|---|---|
| previous (no derotation, no path gate) | 0.51 | 0.20 (clear walk 0.40, crossing 0.43; turn 0.88 before derotation) |
| **new defaults** | **0.49** | **0.00** |

**Limits – read before relying on it:**
* **A plain wall is mostly missed** (recall 0.12 walking straight at the end wall, 0.41 into the colonnade). Expansion needs texture to track; plaster gives it none. Persons/objects with texture are caught better (recall 0.6–0.9) but still only about half of the frames in the last 2.5 s before contact, with first warnings 3–4 m out. **This is not a safety system; do not use it as the only means of avoiding obstacles.**
* Better static-obstacle detection needs a different signal (e.g. a *metric* depth model, depth-from-motion with known speed, or a depth sensor). That would change the specified model, so it was not done silently.
* Ground-truth, scene and motion are simulated (no blur, exposure change, rolling shutter, real gait). The grid search is small (16 settings, 7 walks, train/validation split by walk), so the numbers are indicative, not guarantees. Real hardware testing is still required.
* The path gate assumes the camera points where you walk and a roughly known speed; a hand-held phone aimed elsewhere breaks that assumption (checkbox "Only things on a collision path" turns it off).

## View modes (accessibility)
A mode bar at the top switches between three views:
1. **Settings** – the normal page with all controls.
2. **Peripheral vision** (tunnel vision) – no controls visible. The camera picture is shown at full-screen scale but only through a round window in the centre of the display, the rest stays black (nothing is scaled down; only the centre of what the camera sees is used). The window size is set beforehand in Settings → Advanced settings → "Peripheral view: visible window".
3. **Light perception** – no controls visible. The display shows the depth model output (middle panel: closer = brighter) full screen, so brightness itself carries depth. This turns Depth on automatically; it needs a device where the depth model runs (WebGPU), and the page announces by speech if it does not.

Sound is switched on in both vision modes. **Leave a vision mode by holding the screen for two seconds (or Escape).** The page announces the mode and how to leave by speech. `?mode=peripheral` or `?mode=light` in the address opens straight into that view (otherwise a reload always starts at the role selection); one tap is then needed to start the camera. Not tested with real users or on a real phone yet.

## Second device: audio data + vision data (QR)
One device sees (camera + analysis, e.g. the phone); a second device only plays the sound and shows the picture and needs **no camera** (e.g. a device connected to glasses, or any browser).
1. On the seeing device: More options → **Send sound + view to another device (QR)**. The QR code opens `view.html?room=…` on the second device.
2. On the second device: scan, accept the certificate warning, tap the screen once (browsers only start sound after a tap).
3. The second device then plays exactly the beeps (left/right level, loudness, rate, pitch) and shows the picture of the **current view** of the seeing device: camera for Settings / Peripheral (tunnel-vision window), depth brightness for Light perception. Pictures are small JPEGs (about 8 per second); the sound is sent as small numbers (`share.ts` documents the messages), not as audio, so it plays without delay beyond the Wi-Fi.
Scan the code **before** switching the seeing device into a vision mode (the vision modes hide all controls). Needs the laptop server (`npm run phone`) on the same Wi-Fi: the relay is part of that server, so it does **not** work on the public GitHub Pages site. Tested: relay logic (`tests/relayShare.test.ts`); not tested on real devices.

## Roles: alone, supplier, viewer
On opening the site you choose what this device does:
* **Both** (this device provides the camera and plays the sound and picture, e.g. the phone with headphones) – the normal app. The three views (Settings / Peripheral vision / Light perception) are in the bar at the top; in a vision view **tap the screen** to bring up a bar for switching, **hold it for two seconds** to return to the settings. *Peripheral vision* shows the **whole** camera picture on the whole display; *Light perception* shows the depth output (closer = brighter) the same way.
* **Viewer** (e.g. the Meta glasses) – shows a 6-character code (also read aloud). As soon as a supplier is connected the screen shows only the picture and plays the sound; nothing can be changed on it (hold two seconds to start over).
* **Supplier** (e.g. the phone) – type the code. The phone has the camera and all controls: the mode bar chooses what the viewer shows (camera picture, or depth brightness), Start starts the camera. The phone is silent, the viewer plays the sound.
The two devices talk directly (WebRTC) so the pictures and the sound data never pass through a server; only the introduction (code + connection details) goes through PeerJS's free public broker (`0.peerjs.com`), so **both devices need internet**, and it works on the hosted site without any server of ours. Tested in a browser with two tabs (viewer + supplier with a synthetic scene) through the real broker; not tested on real phones or glasses.
