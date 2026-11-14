import { describe, it, expect } from 'vitest';
import { pathFactor } from '../src/motion/pathGate';

const f = 228; // px at 320 wide, ~70 degrees
describe('collision-path factor', () => {
  it('straight ahead at the horizon line with decent expansion is on the path', () => {
    expect(pathFactor(0, 0, 0.5, f)).toBeGreaterThan(0.9);
    expect(pathFactor(10, 5, 0.4, f)).toBeGreaterThan(0.8);
  });
  it('something far to the side with the same expansion is not (we will pass it)', () => {
    expect(pathFactor(140, 0, 0.5, f)).toBeLessThan(0.05);
    expect(pathFactor(-120, 10, 0.4, f)).toBeLessThan(0.05);
  });
  it('a slowly expanding (far) thing slightly off-centre is rejected, a fast one is kept', () => {
    expect(pathFactor(40, 0, 0.1, f)).toBeLessThan(0.05); // Z = 14 m, 2.5 m to the side
    expect(pathFactor(40, 0, 0.8, f)).toBeGreaterThan(0.8); // Z = 1.75 m, 0.3 m to the side
  });
  it('things far above head height or no expansion are rejected', () => {
    expect(pathFactor(0, -250, 0.5, f)).toBeLessThan(0.05);
    expect(pathFactor(0, 0, 0, f)).toBe(0);
    expect(pathFactor(0, 0, -0.5, f)).toBe(0);
  });
});
