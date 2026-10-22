import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../../../shared/types.ts';
import { DESK, deskPosition, SEATS } from './layout.ts';
import { DESK_LAMP, deskLampLit, DOLLHOUSE_CUT, nearestCeilingLampDistance, SHADE_CLEARANCE_ABOVE } from './deskLampRule.ts';

describe('deskLampLit', () => {
  it('lights a desk while its agent is setting up or working', () => {
    expect(deskLampLit('preparing')).toBe(true);
    expect(deskLampLit('working')).toBe(true);
  });

  it('leaves idle, finished, failed, stopped desks and empty ones dark', () => {
    const dark: (AgentStatus | undefined)[] = ['idle', 'done', 'error', 'stopped', undefined];
    for (const status of dark) expect(deskLampLit(status)).toBe(false);
  });
});

describe('the shade', () => {
  it('hangs clear of every name tag and speech bubble, and under the dollhouse cut', () => {
    expect(DESK_LAMP.shadeBottomY).toBeGreaterThan(SHADE_CLEARANCE_ABOVE);
    expect(DESK_LAMP.shadeTopY).toBeLessThan(DOLLHOUSE_CUT);
  });
});

describe('the floor pool', () => {
  it('covers the desk (1.9 x 0.95) and the chair at z 0.8', () => {
    const { r, z: poolZ } = DESK_LAMP.floorPool;
    const corners = [
      [-DESK.w / 2, -DESK.d / 2],
      [DESK.w / 2, -DESK.d / 2],
      [-DESK.w / 2, DESK.d / 2],
      [DESK.w / 2, DESK.d / 2],
      // the chair, roughly 0.5m square, centred at z 0.8
      [-0.26, 0.55],
      [0.26, 1.05],
    ];
    for (const [x, z] of corners) expect(Math.hypot(x, z - poolZ)).toBeLessThanOrEqual(r);
  });
});

describe('ceiling lamps', () => {
  it('never sit within 0.6m of any desk lamp, in every slot, east desks included', () => {
    for (let slot = 0; slot < SEATS; slot++) {
      const { x, z } = deskPosition(slot);
      expect(nearestCeilingLampDistance(x, z)).toBeGreaterThan(0.6);
    }
  });
});
