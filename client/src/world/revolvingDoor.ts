// The lobby's revolving door (#41): a glass drum on the west wall, in place of the old sliding door. Pure rules;
// Outside.tsx draws it and feeds the player's speed in, Player.tsx's collide() uses drumColliders().

/** The drum: about 2.4 m across, on a post with WINGS glass wings. */
export const DRUM_RADIUS = 1.2;
export const WINGS = 4;
/** Each wing's half-thickness, so the two side panes (the only solid part) clear the walked-through middle. */
export const WING_T = 0.04;
/** How wide the walked-through gap between a drum's two side panes is: comfortably past the player's shoulders. */
export const PASSAGE = DRUM_RADIUS * 0.85;

/** How fast the wings turn for a given walking speed through the drum (rad/s per m/s): running turns them
 * clearly faster than walking, never so fast they'd sweep through where you're standing. */
export const SPEED_GAIN = 1.3;
/** Once nobody is pushing it, the drum eases to a stop over about this long. */
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

/**
 * Steps the door by `dt` seconds. `playerSpeed` is the player's own speed (m/s, >= 0) while they're inside the
 * drum's circle, or 0 when they're clear of it (inside the building or already out). The wings follow a rising
 * speed at once, so they never lag behind and bump into you, then ease down to a stop once you've left.
 */
export function tickRevolvingDoor(d: RevolvingDoorState, playerSpeed: number, dt: number): RevolvingDoorState {
  const target = Math.max(0, playerSpeed) * SPEED_GAIN;
  d.speed = target > d.speed ? target : Math.max(target, d.speed - (d.speed / COAST_S) * dt);
  if (d.speed < STOPPED && target === 0) d.speed = 0;
  d.angle = (d.angle + d.speed * dt) % (Math.PI * 2);
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

/**
 * The drum's only solid part for the player: its two curved glass sides, flanking the walked-through middle. The
 * wings and the centre post have no collider at all, so you walk in or out, either way, at any speed, and the
 * door itself never stops you. `axis` is the wall's outward side (-1 west, 1 east); `x` is the wall face, `z` the
 * doorway's middle.
 */
export function drumColliders(x: number, z: number, axis: 1 | -1): Rect[] {
  const minX = axis < 0 ? x - DRUM_RADIUS * 2 : x;
  const maxX = axis < 0 ? x : x + DRUM_RADIUS * 2;
  return [
    { minX, maxX, minZ: z - DRUM_RADIUS, maxZ: z - PASSAGE / 2 },
    { minX, maxX, minZ: z + PASSAGE / 2, maxZ: z + DRUM_RADIUS },
  ];
}

// ---------- the one on the lobby's west wall (Outside.tsx) ----------

const live = createRevolvingDoor();

/** Steps the lobby's one revolving door and returns its state, for Outside.tsx to draw and doors.ts to report. */
export const tickLiveDoor = (playerSpeed: number, dt: number): RevolvingDoorState => tickRevolvingDoor(live, playerSpeed, dt);
export const liveDoorState = (): RevolvingDoorState => live;
