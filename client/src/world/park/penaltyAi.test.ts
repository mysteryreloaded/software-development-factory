import { describe, expect, it } from 'vitest';
import { GOAL } from '../../../../shared/penalty';
import { aiKeeperDive, aiShooterShot, REACT_ABOVE_MS } from './penaltyAi';

/** A deterministic sequence of "random" numbers, cycling, for repeatable tests. */
function seq(...vals: number[]) {
  let i = 0;
  return () => vals[i++ % vals.length];
}

describe('aiKeeperDive', () => {
  it('reacts to the true spot (within noise) once there is time to watch the ball', () => {
    const shot = { x: 2, y: 1.2, power: 0.5 };
    const flightMs = 900;
    expect(flightMs).toBeGreaterThan(REACT_ABOVE_MS);
    const dive = aiKeeperDive(shot, flightMs, seq(0.5, 0.25, 0.5, 0.25));
    expect(dive.x).toBeCloseTo(shot.x, 0); // close to the real spot, not exact (noise)
    expect(dive.at).toBeGreaterThanOrEqual(0);
    expect(dive.at).toBeLessThanOrEqual(100);
  });

  it('guesses a side, committed before the strike, when the shot is too fast to react to', () => {
    const shot = { x: 2, y: 1.2, power: 1 };
    const flightMs = 300;
    expect(flightMs).toBeLessThanOrEqual(REACT_ABOVE_MS);
    const dive = aiKeeperDive(shot, flightMs, seq(0.99, 0.5));
    expect(dive.at).toBeLessThan(0);
    expect(Math.abs(dive.x)).toBeGreaterThan(0); // a post, not necessarily the real spot
  });

  it('a guess always lands on a post or the middle, never off the frame', () => {
    for (const r of [0, 0.4, 0.99]) {
      const dive = aiKeeperDive({ x: 10, y: 10, power: 1 }, 100, seq(r));
      expect(Math.abs(dive.x)).toBeLessThanOrEqual(GOAL.width / 2);
    }
  });
});

describe('aiShooterShot', () => {
  it('aims inside the frame, with a healthy charge', () => {
    for (let i = 0; i < 20; i++) {
      const shot = aiShooterShot(seq(i / 20, 0.5, 0.5, 0.5));
      expect(shot.power).toBeGreaterThanOrEqual(0.55);
      expect(shot.power).toBeLessThanOrEqual(1);
    }
  });

  it('is biased towards the corners, not dead centre every time', () => {
    const a = aiShooterShot(seq(0.0, 0.5, 0.5));
    const b = aiShooterShot(seq(0.3, 0.5, 0.5));
    expect(a.x).not.toBeCloseTo(b.x, 0);
  });
});
