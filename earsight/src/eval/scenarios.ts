import type { Scenario } from './render';

/** Looking along +X in three.js: yaw = -90 degrees. Sponza nave: free lane z in (-1.7, 1.2), end wall at x ~ 10.4. */
const YAW_X = -Math.PI / 2;
const EYE = 1.6;

export const SCENARIOS: Scenario[] = [
  {
    name: 'clear_walk', label: 'Walk down the clear nave (columns and banners pass at ~2 m): no hazard', duration: 3.5,
    camera: (t) => ({ pos: [-9 + 1.2 * t, EYE, -0.3], yaw: YAW_X }),
  },
  {
    name: 'wall_approach', label: 'Walk straight at the end wall (static obstacle): hazard', duration: 4.5,
    camera: (t) => ({ pos: [4.0 + 1.2 * t, EYE, -0.3], yaw: YAW_X }),
  },
  {
    name: 'side_column', label: 'Walk diagonally into the side colonnade (static obstacle): hazard', duration: 4,
    camera: (t) => ({ pos: [-6 + 1.1 * t * Math.cos(0.45), EYE, -0.3 - 1.1 * t * Math.sin(0.45)], yaw: YAW_X + 0.45 }),
  },
  {
    name: 'head_on_person', label: 'Walking forward while a person-sized obstacle walks towards the camera: hazard', duration: 3.5,
    camera: (t) => ({ pos: [-9 + 1.0 * t, EYE, -0.3], yaw: YAW_X }),
    obstacle: (t) => [-1 - 1.2 * t, 0, -0.3],
  },
  {
    name: 'person_to_static_cam', label: 'Standing still while a person-sized obstacle approaches: hazard', duration: 4,
    camera: () => ({ pos: [-9, EYE, -0.3], yaw: YAW_X }),
    obstacle: (t) => [-2 - 1.6 * t, 0, -0.3],
  },
  {
    name: 'crossing_person', label: 'Walking while a person crosses 5 m ahead (not on a collision course): no hazard', duration: 3.5,
    camera: (t) => ({ pos: [-9 + 1.0 * t, EYE, -0.3], yaw: YAW_X }),
    obstacle: (t) => [-3.5, 0, -1.2 + 1.0 * t],
  },
  {
    name: 'pan_in_place', label: 'Turning the head in place (no translation): no hazard', duration: 2.5,
    camera: (t) => ({ pos: [-4, EYE, -0.3], yaw: YAW_X + 0.9 * t }),
  },
];
