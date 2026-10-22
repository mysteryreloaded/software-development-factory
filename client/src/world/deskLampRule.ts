// The pendant lamp over a busy agent's desk (#52): the lit rule and its dimensions, pure so they're easy to test and
// so OfficeFloor's "busy" sign and the lamps lit always agree.
import type { AgentStatus } from '../../../shared/types.ts';
import { BUBBLE, SIGN_SIZE } from './activitySign.ts';
import { CEILING_LAMPS, WALL_H } from './layout.ts';

/** Lit while the agent at that desk is doing something: setting up or running a session. Away on an errand, idle,
 * finished, failed, stopped or no agent at all: dark. */
export function deskLampLit(status: AgentStatus | undefined): boolean {
  return status === 'working' || status === 'preparing';
}

/** The lamp's shape and placement, in the desk's own space (desk top at y 0.77, chair at z 0.8). */
export const DESK_LAMP = {
  /** The cord's top, at the ceiling. */
  cordTopY: WALL_H,
  /** The shade: a short frustum, closed at the top (the cord), open at the bottom round the bulb. */
  shadeTopY: 3.3,
  shadeBottomY: 2.95,
  shadeTopR: 0.09,
  shadeBottomR: 0.25,
  /** The bulb hanging just inside the shade's open bottom. */
  bulbY: 2.98,
  bulbR: 0.075,
  /** The light beam: an open cone from the shade's mouth to a wide ring on the floor. */
  beamTopR: 0.3,
  /** The bright floor pool, centred a little in front of the desk (over the desk and the chair). */
  floorPool: { z: 0.2, r: 1.6 },
  /** The warmer pool on the desk top itself. */
  deskPool: { y: 0.776, w: 1.9, d: 0.95 },
};

/** How close a pendant lamp (hanging straight down over the desk's middle) would come to a ceiling lamp. */
export function nearestCeilingLampDistance(x: number, z: number): number {
  return Math.min(...CEILING_LAMPS.map(([lx, lz]) => Math.hypot(x - lx, z - lz)));
}

/** The shade's lowest point clears every name tag and speech bubble, and stays under the dollhouse cut. */
export const SHADE_CLEARANCE_ABOVE = BUBBLE.clear + SIGN_SIZE.h / 2;
export const DOLLHOUSE_CUT = WALL_H - 0.08;
