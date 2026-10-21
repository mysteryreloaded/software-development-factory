// The lobby's revolving door (#41): a glass drum on the west wall, in place of the old sliding door. Pure rules;
// Outside.tsx draws it and feeds the player's position in, Player.tsx's collide() uses drumColliders().

/** The drum: about 2.4 m across, centred on its post, with WINGS glass wings. */
export const DRUM_RADIUS = 1.2;
export const WINGS = 4;

/** How much the door turns over one full crossing of the drum (its diameter), rad/s per m/s of the player's
 * through-wall speed. At rest the wings sit 45° off the doorway (WINGS' own even spacing, wingAngle()): turning
 * more than ~25° either side of that while you're still inside would swing a wing close to you, so a full
 * crossing (2 × DRUM_RADIUS) turns only about CROSSING_TURN in total, leaving a comfortable margin the whole way
 * except right by the post, where the wings are close to you however the phase lands (#41 round 3). */
const CROSSING_TURN = Math.PI / 9; // 20°
export const SPEED_GAIN = CROSSING_TURN / (2 * DRUM_RADIUS);
/** Once you've left the drum, how long it takes to ease the rest of the way to the next quarter turn. */
export const COAST_S = 2.2;
/** Below this angular speed (rad/s) it counts as stopped, so a test (or the renderer) isn't chasing an asymptote forever. */
export const STOPPED = 0.01;

export interface RevolvingDoorState {
  /** The wings' turn about the post, radians. */
  angle: number;
  /** Angular speed, rad/s: positive while someone's walking it; eases towards 0 once nobody is. */
  speed: number;
}

export const createRevolvingDoor = (): RevolvingDoorState => ({ angle: 0, speed: 0 });

const QUARTER = Math.PI / 2;

/**
 * Steps the door by `dt` seconds. `speed` is the player's own through-wall speed (m/s, >= 0); `inside` is whether
 * they're within the drum's circle right now (Outside.tsx: distance to the post <= DRUM_RADIUS). While inside, the
 * wings are phased to your progress across the drum, not to time: they follow at once, speeding up and slowing
 * down with you, never lagging behind or running ahead. Once you've left, there's no more driving it: it eases to
 * a stop exactly on the next quarter turn ahead, so it's always resting mid-compartment, however far round it got.
 */
export function tickRevolvingDoor(d: RevolvingDoorState, speed: number, inside: boolean, dt: number): RevolvingDoorState {
  if (inside) {
    d.speed = Math.max(0, speed) * SPEED_GAIN;
    d.angle = (d.angle + d.speed * dt) % (Math.PI * 2);
    return d;
  }
  const rest = Math.ceil(d.angle / QUARTER - 1e-9) * QUARTER;
  const remaining = rest - d.angle;
  if (remaining < 1e-4) {
    d.angle = rest % (Math.PI * 2);
    d.speed = 0;
    return d;
  }
  const left = remaining * Math.exp(-dt / COAST_S);
  d.speed = (remaining - left) / dt;
  d.angle = rest - left;
  return d;
}

/** A wing's turn (radians) phased so a compartment, not a wing, faces the doorway at angle 0: the player always
 * finds themselves between two wings, which sweep round them rather than through their view. */
export const wingAngle = (d: RevolvingDoorState, i: number) => d.angle + Math.PI / WINGS + (i * Math.PI * 2) / WINGS;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** cos(45°) = sin(45°): where a quarter arc's two ends sit, so a box of this half-width/half-depth exactly
 * bounds it. */
const ARC = Math.SQRT1_2;

/**
 * The drum's only solid part for the player: its two curved glass sides (Outside.tsx draws them as open
 * CylinderGeometry arcs), bounding boxes of the quarter-circle arcs on the north and south of the post at (x, z).
 * The wings and the post have no collider at all, so you walk in or out, either way, at any speed, through the
 * open east and west quarters, and the door itself never stops you.
 */
export function drumColliders(x: number, z: number): Rect[] {
  const near = DRUM_RADIUS * ARC;
  return [
    { minX: x - near, maxX: x + near, minZ: z - DRUM_RADIUS, maxZ: z - near }, // north quarter
    { minX: x - near, maxX: x + near, minZ: z + near, maxZ: z + DRUM_RADIUS }, // south quarter
  ];
}

// ---------- the one on the lobby's west wall (Outside.tsx) ----------

const live = createRevolvingDoor();

/** Steps the lobby's one revolving door and returns its state, for Outside.tsx to draw and doors.ts to report. */
export const tickLiveDoor = (speed: number, inside: boolean, dt: number): RevolvingDoorState => tickRevolvingDoor(live, speed, inside, dt);
export const liveDoorState = (): RevolvingDoorState => live;
