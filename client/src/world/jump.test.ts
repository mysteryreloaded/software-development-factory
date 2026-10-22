import { describe, expect, it } from 'vitest';
import { groundedJump, JUMP, jumpHeight, startJump, stepJump } from './jump';

describe('jump', () => {
  it('rises to about the peak height and lands at 0 after about the jump duration', () => {
    let state = startJump(groundedJump());
    let elapsed = 0;
    let peak = 0;
    const dt = 1 / 60;
    while (state.airborne && elapsed < 2) {
      state = stepJump(state, dt);
      elapsed += dt;
      peak = Math.max(peak, jumpHeight(state));
    }
    expect(peak).toBeCloseTo(JUMP.height, 1);
    expect(elapsed).toBeCloseTo(JUMP.duration, 1);
    expect(jumpHeight(state)).toBe(0);
    expect(state.airborne).toBe(false);
  });

  it("won't jump again while already airborne", () => {
    const up = startJump(groundedJump());
    const stepped = stepJump(up, 0.1);
    expect(startJump(stepped)).toEqual(stepped);
  });

  it('a single long frame never dips below 0 or overshoots the peak', () => {
    const state = stepJump(startJump(groundedJump()), 0.5);
    const h = jumpHeight(state);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(JUMP.height + 1e-9);
  });

  it('is grounded again after landing', () => {
    const state = stepJump(startJump(groundedJump()), JUMP.duration + 1);
    expect(state).toEqual(groundedJump());
    expect(jumpHeight(state)).toBe(0);
  });
});
