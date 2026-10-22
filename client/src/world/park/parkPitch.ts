// Where the penalty pitch sits in the park (#46, #41): the goal, the spot you shoot from, and the billboard. Pure
// (no three.js), derived from the park's own rect (outside/grounds.ts HOME_PARK) so it never drifts off the grass
// or through the fence. Pitch.tsx and ParkOpponent.tsx draw and walk it; parkPitch.test.ts checks the numbers.

import { GOAL } from '../../../../shared/penalty';
import { HOME_PARK } from '../outside/grounds';

/** Clear of the fence on every side, metres. */
const CLEAR = 1;
/** How far the goal's line sits in from the park's west (fenced) edge. */
const GOAL_IN = 3;
/** How far the net recedes behind the goal line, away from the spot. */
const NET_DEPTH = 2;

export interface GoalPitch {
  /** The goal mouth's x: the frame (two posts and a bar) stands here, facing +x. */
  lineX: number;
  /** The frame's (and the spot's) z. */
  z: number;
  /** Behind the line, where the net's back wall is. */
  netX: number;
  /** Where you shoot from: GOAL.spot out from the line, towards the building (+x). */
  spotX: number;
}

/** The goal: against the park's west fence, its net facing +x (towards the building), the spot 11 m out. */
export function goalPitch(): GoalPitch {
  const lineX = HOME_PARK.minX + GOAL_IN;
  const z = (HOME_PARK.minZ + HOME_PARK.maxZ) / 2;
  return { lineX, z, netX: lineX - NET_DEPTH, spotX: lineX + GOAL.spot };
}

export interface BoardPitch {
  x: number;
  z: number;
  width: number;
  height: number;
  /** Metres up from the ground to the board's bottom edge. */
  bottom: number;
  /** The direction the board's face looks out in (a unit-ish vector); towards the building is (1, 0). */
  facing: { x: number; z: number };
}

const BOARD = { width: 26, height: 19, bottom: 2 };

/** The billboard: the park's NW corner, facing the building, well clear of the goal and the fence. */
export function boardPitch(): BoardPitch {
  const x = HOME_PARK.minX + GOAL_IN + BOARD.width; // east of the goal, with room to spare
  const z = HOME_PARK.minZ + BOARD.width / 2 + CLEAR; // as far north as its own width allows, clear of the fence
  return { x, z, width: BOARD.width, height: BOARD.height, bottom: BOARD.bottom, facing: { x: 1, z: 0 } };
}
