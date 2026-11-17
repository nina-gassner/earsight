# Earsight 👂

Hear what's coming!

Earsight takes a camera feed and turns it into sound, so you can *hear* something moving toward you before it gets to you. It runs completely in the browser, on your phone or laptop. No server, no API keys, no account.

We won the **Meta challenge at Junction** with this :D 🏆
Here's our pitch: https://youtu.be/EuUEM5ndjEg

## How it sounds

Think of a car's parking sensor, but with direction and height too:

- the closer something is, the **faster** the beeps (2 up to 36 per second)
- the closer something is, the **louder** they get
- something on your left beeps in your left ear, same for the right
- something high up gets a high tone, something low gets a low one

There are also two views for the glasses or the second screen. **Peripheral vision** shows the camera picture across the whole display (for tunnel vision), and **light perception** shows depth as brightness, so closer means brighter (for very low vision).

## How does it work?

Short version: it's not a neural network. There are two parts:

**1. Is something coming at me? (`src/motion/`)**
Things that move toward you get bigger in the picture, so we just measure that.
We pick a bunch of corner-ish points in the image (Shi-Tomasi), follow them from frame to frame (Lucas-Kanade optical flow) and look at whether little patches of points are spreading apart. Spreading apart means the thing is getting closer. RANSAC throws out points that got tracked wrong, and we filter over time so a waving hand doesn't set it off. We also cancel out your own head turning (`derotate.ts`), and a path gate (`pathGate.ts`) only cares about stuff that's actually on a collision course and not something passing by on the side.
No training data, no labels. A scooter, a door and a dog all work the same way, and it's fast enough for a phone.

**2. How close is it? (`src/depth/`)**
Here we do use a neural net: Depth Anything V2 Small, pre-trained, running in the browser. It only gives *relative* depth (closer or farther, not meters), and we use it to decide how loud and how fast the beeps are.

The beeps follow whichever is bigger, how close something is or how strongly it's approaching.

## Two devices

When you open the app you pick a role:

- **Both**: this device does everything (e.g. your phone + headphones)
- **Supplier**: the phone, it has the camera and does all the analysis
- **Viewer**: the glasses (or any browser), it shows the picture and plays the sound

The viewer shows a 6-character code, you type it into the phone, done. They connect directly over WebRTC, so the video never goes through any server of ours.

## Run it

```bash
cd earsight
npm install
npm run dev     # https://localhost:5173, HTTPS because phones need it for the camera
npm test
npm run build
```

Open it, pick a role, allow the camera, hit Start. The depth model (a few dozen MB) gets downloaded the first time. `npm run phone` serves the production build on your wifi so you can try it on a real phone. Every push to `main` also deploys to GitHub Pages.

## What's in here

```
earsight/              the app (TypeScript + Vite)
  src/motion/          approach detection (OpenCV.js in a worker)
  src/depth/           depth model (transformers.js, in a worker)
  src/audio/           beeps + the gate that stops them flickering
  src/ui/              roles, vision modes, button navigation for the glasses
  src/link.ts          pairing between phone and glasses
  src/eval/            walks through a 3D model, used to tune things
  tests/               vitest
  README.md            our long dev log with every design decision and all the limits
earsight-circles/      earlier prototype
```

## Things it can't do (yet)

Please don't use this as your only way of not walking into stuff.

- It needs texture to track. A plain white wall or the sky gives it nothing to follow, and then it says "unknown", not "safe". In our simulated walks it mostly missed plain walls.
- Distance is relative, not in meters.
- Heavy shaking, darkness, motion blur and sudden exposure changes can fool it.
- We mostly tested on synthetic scenes and simulated walks through one 3D building (Sponza). Real-world testing on phones and glasses is still thin. The details are in [`earsight/README.md`](earsight/README.md).

## Credits

- Depth: [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) (Apache-2.0), run through `@huggingface/transformers` and ONNX Runtime Web
- Tracking: OpenCV 4.12 via `@techstark/opencv-js`
- Phone-to-glasses link: PeerJS / WebRTC
- The Sponza test model (Khronos glTF samples, Cryengine Limited License) was only used locally for evaluation and is not included
