# Earsight — Circle Approach (3-way model)

Copy of `../earsight` with a **different 3rd model**. Everything else (camera, depth panel, phone camera / QR, per-ear beeps, UI) is the same.

| Panel | Model |
|---|---|
| 1. Camera | unchanged |
| 2. Relative closeness | unchanged (Depth Anything V2 small) |
| 3. **Approaching circles** | **new**: only *circular* objects whose radius keeps growing count. Everything else stays dark. |

The old optical-expansion estimator (`src/motion/expansion*.ts`) is still in the folder with its tests but is no longer used by the worker.

## Run
```
npm install
npm run dev        # https://localhost:5174  (port 5174 so it can run next to ../earsight)
npm test           # 99 tests
```
Press **Start camera**, tick **Sound** (headphones). Synthetic test scenes (no camera) are in the Source list: ball approaching / fast / receding / sideways / static / wobbling, plus the old square scenes, which must stay dark.

## The specification (why false positives / negatives drop)
Instead of asking "does anything expand?", the 3rd model asks one narrow question. A circle is reported as **approaching** only if **all** hold (`src/circles/`):

1. **It is a circle** (`detect.ts`). Hough candidates are verified on the full-resolution image: 48 rays from the centre, ≥ 75 % of them must show a clear radial edge at (nearly) the same radius, and a least-squares circle through those edge points must have rms deviation ≤ 6 % of the radius (≥ 0.7 px). Centre and radius are refined to sub-pixel from those points. Squares, flat ellipses, half-discs/arcs, texture, blobs and wrong-radius candidates are rejected. Radius 2.5 %–42 % of the image width. A ball that is partly hidden still passes (only 75 % of the outline is needed).
2. **It is tracked** (`tracker.ts`): greedy nearest matching in (position, radius), dropouts bridged up to 300 ms; ≥ 5 detections over ≥ 300 ms in ≥ 70 % of the frames of the window (no single-frame flukes).
3. **Its radius grows steadily**: slope of ln(radius) over the window (default 600 ms) ≥ 0.3 /s (÷ sensitivity), significance slope/stderr ≥ 3.5, R² ≥ 0.55, **and** the mean ln-radius of the first/middle/last third of the window increases step by step (rejects oscillation / size wobble).
4. **Hysteresis**: once approaching it stays approaching until the rate stays below half the threshold for 250 ms (no flicker).

Constant, receding, sideways, wobbling or jittering circles have rate ≤ 0 or fail the checks → never approaching. Non-circular objects are never even tracked. `1 / rate` is shown as a time-to-contact estimate.

## Sound
Only approaching circles make sound. The most urgent circle sets:
* **pan** from its position in the picture (constant-power pan; Mirror and *Flip left/right* respected),
* **beep rate** 4 → 30 /s **and pitch** 400 → 1800 Hz, both rising with its **closeness** = max(apparent size / 25 % of frame width, 1 − time-to-contact / 3 s),
* silent when nothing approaches (*Beep only when a circle approaches*; the sound option "2nd panel: closeness" still works as before).

## Panels and overlays
Panel 3 paints a disc on every approaching circle (brightness = approach strength); everything else is dark. *Show detected circles* overlays yellow rings (seen, not approaching) and green rings (approaching, with rate and time-to-contact) on panels 1 and 3. The stats line lists every live circle track with rate and z-score.

## Validation (Node, real OpenCV, synthetic textured video, 30 fps, `test-results/circle-metrics.json`)
* approaching ball flagged after ≈ 0.3 s, painted on the ball, 0 % bright background; fast ball flagged after ≈ 0.3 s.
* receding / sideways / static / wobbling ball: seen as a circle in most frames, **never** flagged.
* 11 non-circular scenes (square patches approaching, punch, camera moving forward, waving, rotation, exposure change, plain): 0 flagged frames.
* dropped frames, 15 fps, covered camera + recovery, timestamp problems (NaN, backwards, 60 s gap): handled.
* cost ≈ 20–30 ms/frame in Node.

## Limitations (honest list)
* **Not tested on a real webcam, phone or by ear.** The synthetic ball has a dark rim; a real ball must have a visible outline (≥ 75 % of it) against the background. Low-contrast, motion-blurred or very small (< 2.5 % of width) balls are missed — this is the price for fewer false alarms.
* Round things that are not "an object coming at us" can still trigger if their radius genuinely grows: a person walking toward a **clock or round sign on a wall** while carrying the camera makes it grow (camera ego-motion is *not* subtracted in this model). Heads/faces are ellipses and mostly rejected.
* Very slow approach (< 0.3 /s ⇒ time-to-contact > ~3 s) is not reported; raise *Sensitivity* to catch slower ones at the cost of more false alarms.
* Objects seen at a strong angle (discs) become ellipses and fail the circle test; spheres (balls) are fine.
* Closeness for the sound uses size and time-to-contact, not metres, so a large close object and a small fast one can sound alike.
* Detection runs at the motion-worker frame rate (≈ 10–30 fps); a very fast throw has fewer samples, but the 300 ms minimum observation still applies.
