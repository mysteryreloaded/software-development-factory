// How the free agent plays penalties, pure: as keeper, a left/centre/right guess when the shot is too fast to react
// to, or a true-spot reaction (with a little noise) once there's time; as shooter, an aim somewhere in the frame with
// a bit of scatter and a healthy charge. penaltyState.ts calls these at the moment they're needed; the probe can
// force either one (window.__swarmPenalty.forceDive / forceShot).

import { type Dive, type Shot, GOAL } from '../../../../shared/penalty';

/** Flight longer than this (ms) and the keeper has time to watch the ball and react to it. */
export const REACT_ABOVE_MS = 500;
/** How far off the true spot a reaction lands (m, one standard deviation). */
const REACT_NOISE = 0.5;
/** How long before the strike a guess is committed, and how long after a reaction is. */
const GUESS_BEFORE_MS = 250;
const REACT_AFTER_MS = 100;
/** Where the keeper stands ready, covering the middle at chest height. */
const KEEPER_Y = GOAL.height * 0.4;

/** A normal sample from two uniform ones in [0, 1). */
const normal = (u: number, v: number) => Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(2 * Math.PI * v);

/**
 * The keeper's dive against a shot that will take `flightMs` to arrive: a true-spot reaction (±REACT_NOISE),
 * committed a little after the strike, once there's more than REACT_ABOVE_MS to watch it; otherwise a blind guess
 * at a post or the middle, committed before the strike. `rand` gives uniform numbers in [0, 1).
 */
export function aiKeeperDive(shot: Shot, flightMs: number, rand: () => number): Dive {
  if (flightMs > REACT_ABOVE_MS) {
    const x = shot.x + normal(rand(), rand()) * REACT_NOISE;
    const y = Math.min(GOAL.height, Math.max(0, shot.y + normal(rand(), rand()) * REACT_NOISE));
    return { x, y, at: rand() * REACT_AFTER_MS };
  }
  const side = Math.floor(rand() * 3) - 1; // -1 left, 0 centre, 1 right
  return { x: side * (GOAL.width / 2) * 0.6, y: KEEPER_Y, at: -(rand() * GUESS_BEFORE_MS) };
}

/** How far in from each post the AI shooter aims (never right at the frame). */
const AIM_MARGIN = 0.5;
/** The aim's scatter (m, one standard deviation), and the power range they charge to. */
const AIM_SIGMA = 0.35;
const POWER = { min: 0.55, max: 1 };

/** A shot an agent takes: a corner or the middle, picked once per kick, blurred by AIM_SIGMA, at a healthy power. */
export function aiShooterShot(rand: () => number): Shot {
  const hw = GOAL.width / 2 - AIM_MARGIN;
  const targets: [number, number][] = [
    [-hw, GOAL.height * 0.75],
    [hw, GOAL.height * 0.75],
    [0, GOAL.height * 0.4],
    [-hw, GOAL.height * 0.25],
    [hw, GOAL.height * 0.25],
  ];
  const [tx, ty] = targets[Math.floor(rand() * targets.length)];
  const x = tx + normal(rand(), rand()) * AIM_SIGMA;
  const y = ty + normal(rand(), rand()) * AIM_SIGMA;
  const power = POWER.min + rand() * (POWER.max - POWER.min);
  return { x, y, power };
}
