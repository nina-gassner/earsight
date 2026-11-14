/**
 * Dev-only evaluation renderer: scripted walk-throughs of a real 3-D model (Sponza interior) with exact ground truth.
 * Frames are saved to test-results/eval/<scenario>.* via the dev server so the real motion pipeline can be calibrated in Node.
 * Driven from the browser console / automation: window.evalApi.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

const W = 320, H = 240, FPS = 30;
const logEl = document.getElementById('log')!;
const log = (s: string) => { logEl.textContent = s; };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x889099);
const hemi = new THREE.HemisphereLight(0xffffff, 0x665544, 1.6);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 10, 4);
scene.add(hemi, sun);
const camera = new THREE.PerspectiveCamera(55.6, W / H, 0.05, 200);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
renderer.domElement.style.width = '640px'; renderer.domElement.style.height = '480px';
document.body.appendChild(renderer.domElement);
const grab = document.createElement('canvas'); grab.width = W; grab.height = H;
const gctx = grab.getContext('2d', { willReadFrequently: true })!;

let staticMeshes: THREE.Mesh[] = [];
let dynamic: THREE.Mesh | null = null;
const raycaster = new THREE.Raycaster();

async function load(url = '/eval-assets/sponza/Sponza.gltf') {
  log('loading model…');
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { (m.geometry as any).computeBoundsTree(); staticMeshes.push(m); }
  });
  scene.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  log('model loaded, meshes: ' + staticMeshes.length);
  return { min: box.min.toArray(), max: box.max.toArray(), meshes: staticMeshes.length };
}

function dist(origin: THREE.Vector3, dir: THREE.Vector3, maxD = 60): number {
  raycaster.set(origin, dir.clone().normalize());
  raycaster.far = maxD;
  const objs: THREE.Object3D[] = [...staticMeshes];
  if (dynamic) objs.push(dynamic);
  const hit = raycaster.intersectObjects(objs, false)[0];
  return hit ? hit.distance : maxD;
}

function makeObstacleTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#b5894d'; x.fillRect(0, 0, 256, 256);
  let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 160; i++) { x.fillStyle = `hsl(${rnd() * 360},45%,${25 + rnd() * 50}%)`; x.fillRect(rnd() * 240, rnd() * 240, 8 + rnd() * 30, 8 + rnd() * 30); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export interface Pose { pos: [number, number, number]; yaw: number }
export interface Scenario {
  name: string;
  duration: number;
  /** camera pose over time (seconds). yaw 0 looks along -Z (three.js default), positive turns left. */
  camera: (t: number) => Pose;
  /** optional dynamic obstacle position over time (centre of a 0.5 x 1.7 x 0.5 m box standing on the floor) */
  obstacle?: (t: number) => [number, number, number];
  label: string;
}

function setCamera(p: Pose, t: number) {
  // head bob and sway: realistic confounders for a body-worn camera
  const bob = 0.02 * Math.sin(2 * Math.PI * 1.8 * t);
  const sway = 0.025 * Math.sin(2 * Math.PI * 0.9 * t);
  camera.position.set(p.pos[0], p.pos[1] + bob, p.pos[2]);
  camera.rotation.set(0.01 * Math.sin(2 * Math.PI * 1.8 * t + 1), p.yaw + sway, 0, 'YXZ');
  camera.updateMatrixWorld(true);
}

function grabGray(): Uint8Array {
  gctx.drawImage(renderer.domElement, 0, 0, W, H);
  const d = gctx.getImageData(0, 0, W, H).data;
  const g = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

/** body-corridor distance ahead of the camera (heading = camera yaw, ignoring bob): 3 x 3 rays */
function corridorDistance(p: Pose): number {
  const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
  const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
  let best = 60;
  for (const lat of [-0.3, 0, 0.3]) for (const hgt of [0.3, 0.9, 1.5]) {
    const o = new THREE.Vector3(p.pos[0], hgt, p.pos[2]).addScaledVector(right, lat);
    best = Math.min(best, dist(o, fwd));
  }
  return best;
}

async function run(sc: Scenario, save = true) {
  if (dynamic) { scene.remove(dynamic); dynamic = null; }
  if (sc.obstacle) {
    dynamic = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 0.5), new THREE.MeshStandardMaterial({ map: makeObstacleTexture() }));
    scene.add(dynamic);
  }
  const n = Math.floor(sc.duration * FPS);
  const frames = new Uint8Array(n * W * H);
  const distances: number[] = [], speeds: number[] = [];
  const cams: Pose[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    const p = sc.camera(t);
    if (dynamic && sc.obstacle) { const o = sc.obstacle(t); dynamic.position.set(o[0], o[1] + 0.85, o[2]); dynamic.updateMatrixWorld(true); }
    setCamera(p, t);
    renderer.render(scene, camera);
    frames.set(grabGray(), i * W * H);
    distances.push(corridorDistance(p));
    cams.push(p);
    if (i % 10 === 0) log(`${sc.name}: frame ${i}/${n}`);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // closing speed from the distance change over the last 0.3 s; time to contact
  const lag = Math.round(0.3 * FPS);
  const ttc: (number | null)[] = distances.map((d, i) => {
    if (i < lag) return null;
    const v = (distances[i - lag] - d) / (lag / FPS);
    speeds.push(v);
    return v > 0.25 ? d / v : null;
  });
  const meta = { name: sc.name, label: sc.label, width: W, height: H, fps: FPS, frames: n, distances, ttc };
  if (save) {
    const post = (name: string, body: BodyInit) => fetch('/eval-save?name=' + encodeURIComponent(name), { method: 'POST', body });
    await post(sc.name + '.bin', frames);
    await post(sc.name + '.json', JSON.stringify(meta));
  }
  log(`${sc.name}: done (${n} frames)`);
  return { name: sc.name, frames: n, minDistance: Math.min(...distances), maxDistance: Math.max(...distances), sampleTtc: ttc.filter((x) => x !== null).slice(0, 5) };
}

function snap(p: Pose, t = 0) {
  setCamera(p, t);
  renderer.render(scene, camera);
  return corridorDistance(p);
}

async function runAll(names?: string[]) {
  const { SCENARIOS } = await import('./scenarios');
  const res = [];
  for (const sc of SCENARIOS) if (!names || names.includes(sc.name)) res.push(await run(sc));
  (window as any).__evalDone = res;
  return res;
}

(window as any).evalApi = {
  load, run, snap, runAll,
  probe: (o: number[], d: number[]) => dist(new THREE.Vector3(...o), new THREE.Vector3(...d)),
  W, H, FPS,
};
log('ready — call evalApi.load()');
