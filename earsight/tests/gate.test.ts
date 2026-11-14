import { describe, it, expect } from 'vitest';
import { SoundGate } from '../src/audio/gate';

describe('sound flicker gate', () => {
  it('a single-update flash does not make sound', () => {
    const g = new SoundGate();
    const a = g.step(0.8, 0, 0); const b = g.step(0, 0, 50); const c = g.step(0, 0, 100);
    expect(a).toEqual({ left: 0, right: 0 }); expect(b.left).toBe(0); expect(c.left).toBe(0);
    expect(g.on).toBe(false);
  });
  it('sustained evidence turns on after consecutive updates', () => {
    const g = new SoundGate();
    g.step(0.8, 0, 0); const r = g.step(0.8, 0, 50);
    expect(g.on).toBe(true); expect(r.left).toBeGreaterThan(0.2);
  });
  it('short dropouts are bridged, long ones turn it off', () => {
    const g = new SoundGate();
    g.step(0.8, 0, 0); g.step(0.8, 0, 50);
    g.step(0, 0, 100); g.step(0, 0, 200);
    expect(g.on).toBe(true);
    g.step(0, 0, 600);
    expect(g.on).toBe(false);
  });
  it('alternating flicker (on/off every update) never opens the gate', () => {
    const g = new SoundGate();
    for (let i = 0; i < 20; i++) g.step(i % 2 ? 0.9 : 0, 0, i * 50);
    expect(g.on).toBe(false);
  });
});
