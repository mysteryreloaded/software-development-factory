import { describe, expect, it } from 'vitest';
import { GOAL } from '../../../../shared/penalty';
import { HOME_PARK } from '../outside/grounds';
import { boardPitch, goalPitch } from './parkPitch';

describe('goalPitch', () => {
  it('sits inside the park, at least 1 m clear of the fence', () => {
    const g = goalPitch();
    expect(g.lineX).toBeGreaterThan(HOME_PARK.minX + 1);
    expect(g.netX).toBeGreaterThan(HOME_PARK.minX); // the net's back wall stays on the grass
    expect(g.spotX).toBeLessThan(HOME_PARK.maxX - 1);
    expect(g.z - GOAL.width / 2).toBeGreaterThan(HOME_PARK.minZ + 1);
    expect(g.z + GOAL.width / 2).toBeLessThan(HOME_PARK.maxZ - 1);
  });

  it('the net recedes behind the line, away from the spot', () => {
    const g = goalPitch();
    expect(g.netX).toBeLessThan(g.lineX);
    expect(g.spotX).toBeGreaterThan(g.lineX);
    expect(g.spotX - g.lineX).toBeCloseTo(GOAL.spot);
  });
});

describe('boardPitch', () => {
  it('sits inside the park, at least 1 m clear of the fence', () => {
    const b = boardPitch();
    expect(b.x).toBeGreaterThan(HOME_PARK.minX + 1);
    expect(b.x).toBeLessThan(HOME_PARK.maxX - 1);
    expect(b.z - b.width / 2).toBeGreaterThanOrEqual(HOME_PARK.minZ + 1 - 1e-6);
    expect(b.z + b.width / 2).toBeLessThan(HOME_PARK.maxZ - 1);
  });

  it('faces the building (+x) within 30 degrees', () => {
    const b = boardPitch();
    const angle = Math.abs(Math.atan2(b.facing.z, b.facing.x)) * (180 / Math.PI);
    expect(angle).toBeLessThanOrEqual(30);
  });

  it('is well clear of the goal, in the NW corner', () => {
    const g = goalPitch();
    const b = boardPitch();
    const dist = Math.hypot(b.x - g.lineX, b.z - g.z);
    expect(dist).toBeGreaterThan(10);
    expect(b.z).toBeLessThan(g.z); // further north than the goal's centre
  });
});
