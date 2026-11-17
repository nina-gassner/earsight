# Earsight

**Hear what's coming.** Earsight turns a camera feed into sound, so that something moving toward you can be *heard* before it reaches you. It runs entirely in the browser (phone or laptop), with no server, no API keys and no account.

🏆 Winner of the **Meta challenge** at Junction.
🎬 Pitch: https://youtu.be/EuUEM5ndjEg

## What it does

A camera sees the scene. Earsight works out **where something is approaching** and **how close it is**, then plays it as beeps in headphones or glasses:

| Sound | Means |
|---|---|
| Beeps get **faster** (2 → 36 per second) | the object is getting closer |
| Beeps get **louder** | the object is getting closer |
| **Left / right ear** | the object is to your left / right |
| **Pitch** | the object is high / low in the view |

Think of a car's parking sensor, extended with direction and height.

Besides the sound, the second device (for example glasses) can show two accessibility views:
- **Peripheral vision**: the camera picture on the whole display, for people with tunnel vision.
- **Light perception**: depth as brightness, where closer means brighter, for people with very low vision.

## How it works

Two separate parts answer two separate questions:

| Question | Part | Method |
|---|---|---|
| *Is something coming toward me, and where?* | **Approach detector** (`src/motion/`) | Classical computer vision, **not a trained model** |
| *How close is it?* | **Depth model** (`src/depth/`) | Pre-trained Depth Anything V2 Small (relative depth, not metres) |

### Approach detection: things that come toward you get bigger

1. Pick distinctive corner points across the image (Shi-Tomasi, `goodFeaturesToTrack`), spread over a grid so the whole view is covered.
2. Follow them from frame to frame (pyramidal Lucas-Kanade optical flow), with a forward/backward check to drop unreliable tracks.
3. For small neighbourhoods, fit a local transform with RANSAC (robust against wrongly tracked points) and read out how fast the patch is **expanding**: `rate = ln(scale) / Δt`. For a flat surface this is 1/time-to-contact.
4. Reject doubtful fits, filter evidence over time so that waving hands cancel out, and compensate for the wearer's own head rotation (`derotate.ts`).
5. A path gate (`pathGate.ts`) keeps only things on a collision course: constant bearing plus growth. Things passing by at the side stay quiet.
6. Evidence is painted into an approach map. A sound gate (`gate.ts`) debounces it so the beeps don't flicker.

No training data is needed, it needs no object labels (a scooter, a door and a dog all work), it runs in real time on a phone, and every decision can be traced back to the points that grew.

### Two devices

On start you choose a role:
- **Both**: one device provides camera and sound (a phone with headphones).
- **Supplier** (phone) and **Viewer** (glasses): the phone sees and analyses; the glasses show the picture and play the sound. They connect directly over WebRTC with a 6-character pairing code, so images and sound data never pass through our server.

## Run it

```bash
cd earsight
npm install
npm run dev        # https://localhost:5173 (HTTPS, so phones can use the camera)
npm test           # unit + pipeline + evaluation tests
npm run build      # type-check + production build
```

Open the page, choose a role, allow the camera and tap Start. The depth model (tens of MB) is downloaded once on first use. `npm run phone` serves the production build on the local network for testing on a real phone. The site is also deployed to GitHub Pages from `main` (`.github/workflows`).

## Repository layout

```
earsight/            the app (TypeScript + Vite)
  src/motion/        approach detection (OpenCV.js in a worker)
  src/depth/         depth model (transformers.js, WebGPU/WASM, in a worker)
  src/audio/         sonifier (beeps) and sound gate
  src/ui/            roles, vision modes, button navigation for glasses
  src/link.ts        WebRTC pairing between supplier and viewer
  src/eval/          renders scripted walks through a 3-D model for evaluation
  tests/             vitest
  README.md          detailed engineering log (design decisions, tuning, all limits)
earsight-circles/    earlier prototype
```

## Honest limitations

- **This is not a safety system.** Don't rely on it as the only way to avoid obstacles.
- It needs **texture** to track. A plain wall or the sky gives no trackable points, so the result is "unknown", not "safe". In our simulated walks, recall on a plain wall was low.
- Distance is **relative** (closer or farther), not in metres.
- Heavy camera shake, darkness, motion blur and sudden exposure changes can produce false or missing detections.
- Evaluated mainly on synthetic scenes and simulated walks through one 3-D interior (Sponza). Real-world testing on phones and glasses is still limited; the details are in [`earsight/README.md`](earsight/README.md).

## Credits and licences

- Depth: [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) (Apache-2.0) via `@huggingface/transformers` (Apache-2.0) and ONNX Runtime Web (MIT)
- Tracking: OpenCV 4.12 via `@techstark/opencv-js` (Apache-2.0)
- Pairing: PeerJS (WebRTC)
- The Sponza test model (Khronos glTF Sample Assets, Cryengine Limited License) is used for local evaluation only and is not redistributed.
