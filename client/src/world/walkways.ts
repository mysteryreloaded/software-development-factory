import { kanbanColumnSpan, KANBAN_KEYS } from './draw';
import { BOARD, CEO_DESK, COFFEE_CORNER, GONG_SPOT, HALF_D, HALF_W, JUKEBOX, MANAGER_DESK, PLAYER_RADIUS, PONG_TABLE, RECEPTION, SEATS, SIDES, SIDE_OPENINGS, deskPosition, isEastDesk, sideSign, type Rect, type Side } from './layout';
import { nook, type NookId } from './smokeBreak';
import { hoopRim } from './toys/hoopScore';
import { clear, makeNav, planPath, roombaRects, type Nav, type Pt } from './toys/roombaBrain';

// Walkways: where people can walk on each floor kind, how to get from A to B, and the named places they walk to.
// Pure (no three.js): the grid and A* are the roomba's (roombaBrain.ts), sized for a person instead. Headings
// follow the roomba's: facing h looks along (cos h, sin h), so 0 is east, π/2 south (+z), π west, -π/2 north.

export type FloorKind = 'office' | 'lobby';

/** A person's radius, the same as the player's. */
export const WALK_R = PLAYER_RADIUS;
/** Normal walking speed, m/s. */
export const WALK_SPEED = 1.2;

const EAST = 0;
const SOUTH = Math.PI / 2;
const WEST = Math.PI;
const NORTH = -Math.PI / 2;

/** A named place: where to stand and which way to face there, plus a seat for places you sit down at. */
export interface Spot {
  id: string;
  x: number;
  z: number;
  facing: number;
  sit?: { x: number; z: number; facing: number };
}

export interface Walkways {
  floor: FloorKind;
  nav: Nav;
  spots: Spot[];
  /** Where people start from: every desk (office), the CEO's desk (lobby). */
  homes: Spot[];
}

// ---------- named spots ----------

const STAND_BACK = 1.5; // behind a desk's chair, where its occupant stands up

/** Desk `slot`'s "stand up here" spot, just behind the chair, facing the desk (the east wall's desks face the wall). */
export function deskSpot(slot: number): Spot {
  const { x, z } = deskPosition(slot);
  return isEastDesk(slot) ? { id: `desk-${slot}`, x: x - STAND_BACK, z, facing: EAST } : { id: `desk-${slot}`, x, z: z + STAND_BACK, facing: NORTH };
}

/** In front of each Kanban column, as drawKanban lays them out across the board. */
function boardSpots(): Spot[] {
  const px = 2560; // the board's canvas width (KanbanBoard.tsx); only the ratio matters
  return KANBAN_KEYS.map((key, ci) => {
    const { x0, colW } = kanbanColumnSpan(ci, px);
    return { id: `board-${key}`, x: -BOARD.w / 2 + ((x0 + colW / 2) / px) * BOARD.w, z: -HALF_D + 1.1, facing: NORTH };
  });
}

function hoopSpot(floor: FloorKind): Spot {
  const rim = hoopRim(floor);
  return { id: 'hoop', x: rim.x, z: rim.z - 4, facing: SOUTH }; // a 4 m shot, what the basketball is tuned for
}

// The middle of each floor's ball play area, among where its balls start out (BALLS in toys/balls.tsx).
const BALL_AREA: Record<FloorKind, Pt> = { office: { x: 9.5, z: 7.2 }, lobby: { x: -8, z: 6 } };
const ballsSpot = (floor: FloorKind): Spot => ({ id: 'balls', ...BALL_AREA[floor], facing: SOUTH });

const elevatorSpot = (): Spot => ({ id: 'elevator', x: 0, z: HALF_D - 1, facing: SOUTH });

/** A metre in from the west and east windows (Shell.tsx; the lobby passes its own), looking out. */
function windowSpots(west: number[], east: number[]): Spot[] {
  return [
    ...west.map((z, i) => ({ id: `window-w${i}`, x: -HALF_W + 1, z, facing: WEST })),
    ...east.map((z, i) => ({ id: `window-e${i}`, x: HALF_W - 1, z, facing: EAST })),
  ];
}

/** Where a ping-pong player stands at each end of the table, facing down it (pongErrands.ts). */
export function pongSpots(): Spot[] {
  const t = PONG_TABLE;
  const off = t.len / 2 + t.stand;
  return [
    { id: 'pong-west', x: t.x - off, z: t.z, facing: EAST },
    { id: 'pong-east', x: t.x + off, z: t.z, facing: WEST },
  ];
}

// In front of the jukebox, picking a song.
const jukeboxSpot = (x: number): Spot => ({ id: 'jukebox', x, z: HALF_D - JUKEBOX.d - 0.8, facing: SOUTH });

/** A smoke break's two spots per office balcony (world/smokeBreak.ts): standing in the gap, by the free end of the
 * bench (the errand's agents stand there rather than truly sitting, like every other errand away from a desk).
 * `nook.yaw` is already a body heading (0 facing -Z, like a perch's); walkways' own spots face the other way round
 * (0 east), so it's turned into that before `headingFor` turns it back. */
function smokeSpots(): Spot[] {
  const ids: NookId[] = ['office-west', 'office-east'];
  return ids.flatMap((id) => {
    const n = nook(id);
    const gapX = (n.gap.minX + n.gap.maxX) / 2;
    const facing = n.yaw > 0 ? WEST : EAST;
    return n.seats.map((seat, i): Spot => ({ id: `smoke-${id}-${i}`, x: gapX, z: seat.z, facing }));
  });
}

function officeSpots(): Spot[] {
  return [
    ...boardSpots(),
    ...smokeSpots(),
    // the kitchenette counter (OfficeFloor.tsx, Props.tsx): the coffee machine sits 1.1 m north of its middle
    { id: 'coffee', x: HALF_W - 1.45, z: 5.9, facing: EAST },
    // the mug dispenser, 0.45 m south of the machine
    { id: 'mugs', x: HALF_W - 1.45, z: 6.55, facing: EAST },
    // a step back from the machine and one more behind that, waiting a turn; and two places by the counter for a sip
    // and a chat, face to face
    { id: 'coffee-line', x: HALF_W - 2.35, z: 5.9, facing: EAST },
    { id: 'coffee-line-1', x: HALF_W - 3.25, z: 5.9, facing: EAST },
    { id: 'coffee-sip-0', x: HALF_W - 1.45, z: 7.9, facing: WEST },
    { id: 'coffee-sip-1', x: HALF_W - 2.5, z: 7.9, facing: EAST },
    { id: 'cooler', x: HALF_W - 1.5, z: -9.5, facing: EAST },
    { id: 'gong', ...GONG_SPOT, facing: NORTH },
    // the couch's seat faces east; you walk up past the south end of the coffee table
    { id: 'couch', x: -HALF_W + 1.9, z: 7.7, facing: WEST, sit: { x: -HALF_W + 1.0, z: 7.3, facing: EAST } },
    hoopSpot('office'),
    ballsSpot('office'),
    // where two people throw the beach ball to each other, either side of where it starts
    { id: 'toss-a', x: 3.8, z: 8.2, facing: EAST },
    { id: 'toss-b', x: 8.3, z: 8.2, facing: WEST },
    ...pongSpots(),
    jukeboxSpot(JUKEBOX.officeX),
    elevatorSpot(),
    // not the west window at z 8 (the couch) or the east one at z -2 (behind the east wall's desks)
    ...windowSpots([-8, 0], [-8]),
  ];
}

function lobbySpots(): Spot[] {
  return [
    { id: 'ceo', x: CEO_DESK.x, z: CEO_DESK.z + STAND_BACK, facing: NORTH },
    { id: 'manager', x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.55, facing: NORTH }, // a visitor's spot
    { id: 'reception', x: RECEPTION.x, z: RECEPTION.z + RECEPTION.d / 2 + 0.6, facing: NORTH },
    // the sofa's seat faces south, towards its coffee table
    { id: 'couch', x: 10.2, z: 5.1, facing: NORTH, sit: { x: 10.6, z: 4.1, facing: SOUTH } },
    // the coffee corner's counter (Lobby.tsx) faces north from the south wall: the machine 0.3 m east of its middle,
    // the mug dispenser 0.4 m west
    { id: 'coffee', x: COFFEE_CORNER.x + 0.3, z: HALF_D - COFFEE_CORNER.d - 0.4, facing: SOUTH },
    { id: 'mugs', x: COFFEE_CORNER.x - 0.4, z: HALF_D - COFFEE_CORNER.d - 0.4, facing: SOUTH },
    hoopSpot('lobby'),
    ballsSpot('lobby'),
    jukeboxSpot(JUKEBOX.lobbyX),
    elevatorSpot(),
    ...windowSpots([1.5, 8], [-2.5, 3.6]),
  ];
}

// ---------- the walk grid ----------

const cache = new Map<FloorKind, Walkways>();

/** A floor kind's walk grid and named spots (built once, then cached). */
export function walkways(floor: FloorKind): Walkways {
  let w = cache.get(floor);
  if (w) return w;
  // Everything the roomba steers round (furniture, walls, the elevator doorway, plant pots, its dock), a person wide.
  // A slightly greedy search: paths get smoothed into straight legs anyway, and it searches far fewer cells.
  const nav = makeNav(roombaRects(floor), { planR: WALK_R + 0.1, lineR: WALK_R + 0.03, greed: 1.3 });
  const spots = floor === 'office' ? officeSpots() : lobbySpots();
  const homes =
    floor === 'office'
      ? Array.from({ length: SEATS }, (_, s) => deskSpot(s))
      : spots.filter((s) => s.id === 'ceo');
  w = { floor, nav, spots, homes };
  cache.set(floor, w);
  return w;
}

/** The spot called `id` on this floor (desk-N included), or undefined. */
export function spot(w: Walkways, id: string): Spot | undefined {
  return w.spots.find((s) => s.id === id) ?? w.homes.find((s) => s.id === id);
}

// ---------- onto the balconies (#58): the office nav stops at the side walls, so a walk out to a smoke-break spot
// bridges the doorway by hand, through the gap between that side's bench and table (smokeBreak.ts), clear of both. ----------

const NOOK_FOR_SIDE: Record<Side, NookId> = { west: 'office-west', east: 'office-east' };

const sideFor = (x: number): Side => (x < 0 ? 'west' : 'east');

/** Whether (x, z) is in a smoke-break nook's gap corridor (where its two spots stand): the rest of the balconies
 * stay off-limits. */
function inSmokeGap(x: number, z: number): boolean {
  for (const side of SIDES) {
    const n = nook(NOOK_FOR_SIDE[side]);
    if (Math.abs(x - (n.gap.minX + n.gap.maxX) / 2) < 0.1 && z >= n.gap.minZ - 0.1 && z <= n.gap.maxZ + 0.1) return true;
  }
  return false;
}

/** Whether a person can stand at (x, z): the indoor grid, or (office only) a smoke-break spot out on a balcony. */
export const standable = (w: Walkways, x: number, z: number) => (Math.abs(x) <= HALF_W ? clear(w.nav.rects, x, z, WALK_R) : w.floor === 'office' && inSmokeGap(x, z));

/** Just inside a side door, where the indoor nav ends before stepping out onto the balcony. */
function doorInside(side: Side): Pt {
  return { x: sideSign(side) * (HALF_W - 0.5), z: SIDE_OPENINGS.office[side].door };
}

/** The gap corridor's x on `side` (between that bench and table): clear of both, the whole way along. */
function gapX(side: Side): number {
  const n = nook(NOOK_FOR_SIDE[side]);
  return (n.gap.minX + n.gap.maxX) / 2;
}

/** From just inside `side`'s door out to `dest` (a balcony point), via the gap corridor. */
function outFromDoor(side: Side, dest: Pt): Pt[] {
  const doorZ = SIDE_OPENINGS.office[side].door;
  const gx = gapX(side);
  const out: Pt[] = [{ x: sideSign(side) * (HALF_W + 0.4), z: doorZ }];
  out.push({ x: gx, z: doorZ });
  if (Math.abs(doorZ - dest.z) > 0.05) out.push({ x: gx, z: dest.z });
  out.push({ x: dest.x, z: dest.z }); // a plain point: the last waypoint is never a Spot's own id/facing
  return out;
}

/** From a balcony point `from` back in to just inside `side`'s door. */
function inToDoor(side: Side, from: Pt): Pt[] {
  const doorZ = SIDE_OPENINGS.office[side].door;
  const gx = gapX(side);
  const pts: Pt[] = [];
  if (Math.abs(from.z - doorZ) > 0.05) pts.push({ x: gx, z: from.z }, { x: gx, z: doorZ });
  pts.push({ x: sideSign(side) * (HALF_W + 0.4), z: doorZ }, doorInside(side));
  return pts;
}

/**
 * A walk from `from` to `to`: a few straight legs round the furniture, as waypoints after `from` ending at `to`.
 * Null when there's no way through. Office only: a destination (or origin) out on a balcony bridges the doorway
 * (#58's smoke break) on top of the indoor grid.
 */
export function findPath(w: Walkways, from: Pt, to: Pt): Pt[] | null {
  // Only a smoke-break spot bridges the doorway: any other point out there stays unreachable, the nav clipping to
  // the nearest indoor cell as it always has (the balconies are otherwise still off-limits).
  const fromOut = w.floor === 'office' && Math.abs(from.x) > HALF_W && inSmokeGap(from.x, from.z);
  const toOut = w.floor === 'office' && Math.abs(to.x) > HALF_W && inSmokeGap(to.x, to.z);
  if (!fromOut && !toOut) return planPath(w.nav, from, to);
  if (fromOut && toOut) {
    const side = sideFor(from.x);
    const gx = gapX(side);
    return [{ x: gx, z: from.z }, { x: gx, z: to.z }, { x: to.x, z: to.z }];
  }
  if (toOut) {
    const side = sideFor(to.x);
    const indoor = planPath(w.nav, from, doorInside(side));
    return indoor && [...indoor, ...outFromDoor(side, to)];
  }
  const side = sideFor(from.x);
  const indoor = planPath(w.nav, doorInside(side), to);
  return indoor && [...inToDoor(side, from), ...indoor];
}

/**
 * Whether the straight line from `a` to `b` at radius `r` is clear of every rect: `toys/roombaBrain.ts`'s
 * `segmentClear`, minus its indoor-only bound (so a smoke-break leg out on a balcony can be checked too).
 */
export function legClear(rects: Rect[], a: Pt, b: Pt, r = WALK_R): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.08));
  for (let k = 0; k <= n; k++) {
    const x = a.x + ((b.x - a.x) * k) / n;
    const z = a.z + ((b.z - a.z) * k) / n;
    for (const rect of rects) if (x > rect.minX - r && x < rect.maxX + r && z > rect.minZ - r && z < rect.maxZ + r) return false;
  }
  return true;
}

// ---------- getting along ----------

/** Someone else on the floor. */
export interface Body extends Pt {
  id: string;
}

/** A walker this step: where it is and the (unit) direction it wants to go. */
export interface Mover extends Body {
  dx: number;
  dz: number;
}

export interface Steering {
  /** Share of walking speed to go forward at, 0-1. */
  speed: number;
  /** Sideways, as a share of walking speed: + is to the walker's right, (-dz, dx). */
  side: number;
  /** Nothing it can do but stand still and let them pass (replan if it lasts). */
  wait: boolean;
}

const LOOK = 1.8; // how far ahead a walker minds others
const GAP = 0.15; // room it keeps between itself and anyone else

/**
 * Slow down, sidestep or wait for whoever is ahead. Both of two walkers meeting head-on keep right, so they pass;
 * one coming up beside steps away from it. The player is only ever waited for and stepped round, never closed in on:
 * walkers don't collide with the player (and the player's own collisions ignore walkers), so this is the one rule
 * keeping them apart. `open` says whether a person could stand somewhere (walls, furniture).
 */
export function steer(me: Mover, walkers: Body[], player: Pt | null, open: (x: number, z: number) => boolean = () => true): Steering {
  const rx = -me.dz;
  const rz = me.dx;
  const others: [Pt, boolean][] = walkers.filter((o) => o.id !== me.id).map((o) => [o, false]);
  if (player) others.push([player, true]);
  // the nearest one ahead and in its lane
  let b: { ahead: number; lateral: number; min: number; player: boolean } | null = null;
  for (const [o, isPlayer] of others) {
    const ox = o.x - me.x;
    const oz = o.z - me.z;
    const ahead = ox * me.dx + oz * me.dz;
    const lateral = ox * rx + oz * rz;
    const min = WALK_R + (isPlayer ? PLAYER_RADIUS : WALK_R) + GAP;
    if (ahead <= 0 || ahead > LOOK || Math.abs(lateral) >= min) continue;
    if (!b || ahead < b.ahead) b = { ahead, lateral, min, player: isPlayer };
  }
  if (!b) return { speed: 1, side: 0, wait: false };

  // Ease off as they get closer, stopping a gap short; step away from their side (keep right when dead ahead).
  const room = Math.max(0, b.ahead - Math.sqrt(Math.max(0, b.min * b.min - b.lateral * b.lateral)));
  const speed = Math.min(1, room / (LOOK - b.min));
  const pref = Math.abs(b.lateral) < 0.05 ? 1 : -Math.sign(b.lateral);
  const step = 0.4;
  for (const dir of [pref, -pref]) {
    if (dir === -pref && Math.abs(b.lateral) >= 0.05 && !b.player) continue; // don't cut across a walker's path
    if (open(me.x + rx * dir * step, me.z + rz * dir * step)) return { speed, side: dir * 0.7, wait: false };
  }
  return { speed, side: 0, wait: speed === 0 };
}
