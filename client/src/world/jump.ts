// A jump's vertical arc: pure constant-gravity kinematics, no three.js, so Player.tsx just adds the height to the
// eye each frame. window.__swarmJump exposes it for e2e, like gamepad.ts's __swarmPad.

export const JUMP = {
  height: 0.45, // metres at the peak
  duration: 0.55, // seconds in the air, take-off to landing
};

const GRAVITY = (8 * JUMP.height) / (JUMP.duration * JUMP.duration);
const TAKEOFF_SPEED = (GRAVITY * JUMP.duration) / 2;

export interface JumpState {
  airborne: boolean;
  /** Seconds since take-off. */
  elapsed: number;
}

export const groundedJump = (): JumpState => ({ airborne: false, elapsed: 0 });

/** Takes off, unless already airborne (no double jump). */
export function startJump(state: JumpState): JumpState {
  return state.airborne ? state : { airborne: true, elapsed: 0 };
}

/** Advances the jump by `dt`, clamped to the jump's own duration so one long frame can't skip past landing. */
export function stepJump(state: JumpState, dt: number): JumpState {
  if (!state.airborne) return state;
  const elapsed = state.elapsed + Math.max(0, Math.min(dt, JUMP.duration));
  return elapsed >= JUMP.duration ? groundedJump() : { airborne: true, elapsed };
}

/** Height above the floor right now: 0 on the ground, and exactly 0 again the instant it lands. */
export function jumpHeight(state: JumpState): number {
  if (!state.airborne) return 0;
  const t = state.elapsed;
  return Math.max(0, TAKEOFF_SPEED * t - 0.5 * GRAVITY * t * t);
}
