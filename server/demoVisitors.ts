// The demo's fake visitors (presence, #223): made-up people who wander the floor the last real visitor is on, emote
// now and then, ping the whiteboard and take the elevator to follow you between floors, so presence can be tried
// alone. Pure stepping; the hub (presence.ts) relays their poses like anyone's.

import { EMOTES, VISITOR_COLORS } from '../shared/presence.ts';
import type { EmoteId, VisitorHeld, VisitorPose } from '../shared/types.ts';
import { LIGHT_MS, PUFF_MS, PUFFS, ROLL_MS, nook } from '../client/src/world/smokeBreak.ts';

interface Pt {
  x: number;
  z: number;
}

/** Loops through open floor: no desks, walls or furniture on the way (demoVisitors.test.ts checks against layout.ts). */
export const ROUTES: { office: Pt[]; lobby: Pt[] } = {
  office: [
    { x: 0, z: 9.5 },
    { x: -9, z: 9.6 }, // round the west of the ping-pong table
    { x: -9, z: 5.6 },
    { x: -7, z: 1 },
    { x: -7, z: -8.5 },
    { x: 7, z: -8.5 },
    { x: 7, z: 1 },
    { x: 0, z: 1 },
    { x: 0, z: 6 },
  ],
  lobby: [
    { x: 0, z: 9.5 },
    { x: -9.5, z: 9.5 },
    { x: -9.5, z: 0 },
    { x: 8, z: 0 },
    { x: 8, z: 9.5 },
  ],
};

/** In front of the elevator, and inside its cabin, where riders vanish from one floor and appear on the next. */
export const LIFT = { door: { x: 0, z: 10.4 }, cabin: { x: 0, z: 12.9 } };
/** What they point out: the whiteboard upstairs, the front desk in the lobby. */
export const PING_SPOTS = { office: { x: 0, y: 1.8, z: -11.6, label: 'the whiteboard' }, lobby: { x: 3, y: 1.2, z: -2.9, label: 'the front desk' } };

const SPEED = 1.3; // m/s, a stroll
const NAMES = ['Robin', 'Sam', 'Kai', 'Noor', 'Mika', 'Jo', 'Ari', 'Lou', 'Tess', 'Remy', 'Ivy', 'Bo', 'Zane', 'Ida', 'Max', 'Pia'];

/** On a smoke break (#59), at one of #57's balcony nooks: rolling → lighting → lit/puffing through PUFFS puffs, then
 * up. `t`: seconds into the current stage; `wait`: seconds left holding `lit` before the next puff. */
export interface SmokeWalk {
  nook: 'office-west' | 'office-east';
  seat: 0 | 1;
  stage: 'rolling' | 'lighting' | 'lit' | 'puffing';
  t: number;
  wait: number;
  puffsLeft: number;
}

export interface Walker {
  index: number;
  /** null until there's a real visitor whose floor to go to. */
  floor: number | null;
  x: number;
  z: number;
  h: number;
  /** wander: round the route · toLift: to the door, then the cabin · fromLift: out of the cabin to the door. */
  leg: 'wander' | 'toLift' | 'fromLift';
  /** The route stop it's walking to (wander), or 0 the door / 1 the cabin (toLift). */
  next: number;
  /** The floor it's riding to. */
  to: number | null;
  /** Seconds left standing still (after an emote, or a look around at a stop). */
  wait: number;
  emoteIn: number;
  pingIn: number;
  held: VisitorHeld | null;
  /** Seconds until the next smoke break is tried (floor 1 only, #59); null while one is already under way. */
  smokeIn: number;
  smoke: SmokeWalk | null;
}

/** Their names and colours, by index. */
export function fakeProfile(i: number) {
  return { name: `${NAMES[i % NAMES.length]} (demo)`, color: VISITOR_COLORS[i % VISITOR_COLORS.length] };
}

/** Every fourth carries a mug; others a beach ball or a blaster, or nothing. */
function heldFor(i: number): VisitorHeld | null {
  const k = i % 4;
  return k === 0 ? { k: 'mug', id: `demo-mug-${i}`, s: 2 } : k === 2 ? { k: 'ball', id: 'beach-ball' } : k === 3 ? { k: 'blaster', id: i % 8 === 3 ? 'blaster-orange' : 'blaster-blue' } : null;
}

export function newWalker(i: number): Walker {
  return {
    index: i,
    floor: null,
    x: 0,
    z: 0,
    h: 0,
    leg: 'wander',
    next: 0,
    to: null,
    wait: 0,
    emoteIn: 3 + i * 1.7,
    pingIn: 12 + i * 5,
    held: heldFor(i),
    smokeIn: 120 + i * 53,
    smoke: null,
  };
}

const routeOf = (floor: number) => (floor === 0 ? ROUTES.lobby : ROUTES.office);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The joint a smoking walker holds, as others see it (shared/presence.ts's VisitorHeld). */
function jointHeld(sm: SmokeWalk): VisitorHeld {
  return { k: 'joint', id: 'demo-joint', s: sm.puffsLeft, l: sm.stage === 'lit' || sm.stage === 'puffing' ? 1 : 0, r: sm.stage === 'rolling' ? 1 : 0 };
}

export const poseOf = (w: Walker, now = Date.now()): VisitorPose => {
  if (w.smoke) {
    const seat = nook(w.smoke.nook).seats[w.smoke.seat];
    const yaw = nook(w.smoke.nook).yaw;
    return { ts: now, f: w.floor ?? 0, x: r2(seat.x), z: r2(seat.z), h: Math.round(yaw * 1000) / 1000, p: 0, held: jointHeld(w.smoke), s: `${w.smoke.nook}:${w.smoke.seat}` };
  }
  return { ts: now, f: w.floor ?? 0, x: r2(w.x), z: r2(w.z), h: Math.round(w.h * 1000) / 1000, p: 0, held: w.held };
};

const SMOKE_NOOKS: readonly ('office-west' | 'office-east')[] = ['office-west', 'office-east'];
const SMOKE_SEATS: readonly (0 | 1)[] = [0, 1];

/** A free (nook, seat) for a smoke break, picking at random among what's not in `taken` ('<nook>:<seat>'); null if none. */
function pickFreeSmokeSeat(taken: ReadonlySet<string>, rand: () => number): { nook: 'office-west' | 'office-east'; seat: 0 | 1 } | null {
  const free: { nook: 'office-west' | 'office-east'; seat: 0 | 1 }[] = [];
  for (const n of SMOKE_NOOKS) for (const s of SMOKE_SEATS) if (!taken.has(`${n}:${s}`)) free.push({ nook: n, seat: s });
  return free.length ? free[Math.floor(rand() * free.length) % free.length] : null;
}

/** Advances a smoke break by dt seconds: rolling → lighting → lit/puffing through PUFFS puffs. Clears `w.smoke`
 * (stands up) once the last puff is done. */
function stepSmoke(w: Walker, dt: number, rand: () => number) {
  const sm = w.smoke!;
  sm.t += dt;
  if (sm.stage === 'rolling') {
    if (sm.t >= ROLL_MS / 1000) {
      sm.stage = 'lighting';
      sm.t = 0;
    }
  } else if (sm.stage === 'lighting') {
    if (sm.t >= LIGHT_MS / 1000) {
      sm.stage = 'lit';
      sm.t = 0;
      sm.wait = 1.2 + rand() * 1.3;
    }
  } else if (sm.stage === 'lit') {
    sm.wait -= dt;
    if (sm.wait <= 0) {
      sm.stage = 'puffing';
      sm.t = 0;
    }
  } else if (sm.t >= PUFF_MS / 1000) {
    sm.puffsLeft -= 1;
    if (sm.puffsLeft <= 0) {
      w.smoke = null;
      return;
    }
    sm.stage = 'lit';
    sm.t = 0;
    sm.wait = 1.2 + rand() * 1.3;
  }
}

const NO_SEATS: ReadonlySet<string> = new Set();

/** Puts a walker on `floor`, spread along its route by index (halfway between two stops). */
function place(w: Walker, floor: number) {
  const route = routeOf(floor);
  const n = (w.index * 3 + 1) % route.length;
  const a = route[(n + route.length - 1) % route.length];
  const b = route[n];
  w.floor = floor;
  w.x = (a.x + b.x) / 2;
  w.z = (a.z + b.z) / 2;
  w.h = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  w.leg = 'wander';
  w.next = n;
}

export interface WalkerStep {
  moved: boolean;
  emote: EmoteId | null;
  ping: { x: number; y: number; z: number; label: string } | null;
}

/**
 * Advances a walker by dt seconds towards the floor real visitors are on (`target`; null: nobody yet). They keep to the
 * office floors and the lobby: nobody follows you up to the roof. `takenSeats` (#59): the smoke-break seats
 * ('<nook>:<seat>') other walkers already hold this tick, so two don't sit in the same one. Mutates `w`.
 */
export function stepWalker(w: Walker, dt: number, floor: number | null, rand: () => number, takenSeats: ReadonlySet<string> = NO_SEATS): WalkerStep {
  const out: WalkerStep = { moved: false, emote: null, ping: null };
  const target = floor !== null && floor >= 0 ? floor : w.floor;
  if (w.floor === null) {
    if (target === null) return out;
    place(w, target);
    out.moved = true;
    return out;
  }
  // A smoke break on floor 1 (#59), instead of wandering: once under way, see it through before resuming.
  if (w.smoke) {
    stepSmoke(w, dt, rand);
    out.moved = true;
    return out;
  }
  if (target === w.floor && w.floor === 1 && w.leg === 'wander' && w.wait <= 0) {
    w.smokeIn -= dt;
    if (w.smokeIn <= 0) {
      w.smokeIn = 150 + rand() * 150; // every 2.5-5 minutes or so, whether or not a seat was free
      const seat = pickFreeSmokeSeat(takenSeats, rand);
      if (seat) {
        w.smoke = { nook: seat.nook, seat: seat.seat, stage: 'rolling', t: 0, wait: 0, puffsLeft: PUFFS };
        out.moved = true;
        return out;
      }
    }
  }
  w.emoteIn -= dt;
  w.pingIn -= dt;
  if (w.emoteIn <= 0) {
    out.emote = EMOTES[Math.floor(rand() * EMOTES.length) % EMOTES.length];
    w.emoteIn = 6 + rand() * 8;
    w.wait = Math.max(w.wait, 1.6); // stop to do it
  }
  if (w.pingIn <= 0) {
    out.ping = w.floor === 0 ? PING_SPOTS.lobby : PING_SPOTS.office;
    w.pingIn = 25 + rand() * 20;
  }
  // Follow the real visitors to their floor by the elevator (or turn back if they came here meanwhile).
  if (target !== null && target !== w.floor) {
    if (w.leg !== 'toLift') {
      w.leg = 'toLift';
      w.next = 0;
      w.wait = 0;
    }
    w.to = target;
  } else if (w.leg === 'toLift') {
    w.leg = 'wander';
    w.next = 0;
  }
  if (w.wait > 0) {
    w.wait -= dt;
    return out;
  }
  const route = routeOf(w.floor);
  const goal = w.leg === 'wander' ? route[w.next % route.length] : w.leg === 'toLift' && w.next === 1 ? LIFT.cabin : LIFT.door;
  const dx = goal.x - w.x;
  const dz = goal.z - w.z;
  const dist = Math.hypot(dx, dz);
  const step = Math.min(dist, SPEED * dt);
  if (dist > 1e-6) {
    w.x += (dx / dist) * step;
    w.z += (dz / dist) * step;
    w.h = Math.atan2(-dx, -dz);
    out.moved = true;
  }
  if (dist - step > 0.02) return out;
  // arrived
  if (w.leg === 'wander') {
    w.next = (w.next + 1) % route.length;
    if (rand() < 0.35) w.wait = 1 + rand() * 2.5;
  } else if (w.leg === 'toLift' && w.next === 0) {
    w.next = 1;
  } else if (w.leg === 'toLift') {
    w.floor = w.to ?? w.floor; // the doors close here and open there
    w.leg = 'fromLift';
    out.moved = true;
  } else {
    w.leg = 'wander';
    w.next = 0;
  }
  return out;
}
