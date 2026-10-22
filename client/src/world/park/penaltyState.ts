// A penalty shoot-out in the park, as plain module state (like toys/pongState.ts): the opponent, the running score,
// whose kick it is, the live aim/charge/dive while it's being taken, and window.__swarmPenalty. ParkOpponent.tsx
// ticks it once a frame and walks the opponent; Player.tsx reads it to steer the mouse and keys while you're playing;
// ui/PenaltyHud.tsx reads it to show the score. The outcome itself (shared/penalty.ts) is pure; this is the clock.

import { api } from '../../api';
import { useStore } from '../../store';
import { flightMsOf, GOAL, kickOutcome, kmhOf, shootoutState, type Dive, type KickOutcome, type PenaltyKick, type Side } from '../../../../shared/penalty';
import { isFree } from '../errands';
import { aiKeeperDive, aiShooterShot } from './penaltyAi';
import { goalPitch } from './parkPitch';

/** How long the pitch settles before a kick's aim and charge come alive. */
const SETUP_MS = 500;
/** How long the AI shooter takes to wind up before striking: within this range, ms. */
const WINDUP_MS = [900, 1700] as const;
/** How long the outcome is shown before the next kick (or the final result stays up). */
const RESULT_MS = 1600;
const OVER_MS = 4000;
/** Full power, held this long. */
const CHARGE_MS = 900;
/** How far either side of the posts (and above the bar) you may aim: beyond this is an obvious, instant miss. */
const OVER_AIM = 1.6;

export type Stage = 'walkup' | 'setup' | 'live' | 'flight' | 'result' | 'over';

export interface Match {
  id: number;
  opponentId: string;
  opponentName: string;
  turn: Side;
  stage: Stage;
  since: number; // performance.now() the stage began
  kicks: PenaltyKick[];
  shot: { x: number; y: number; power: number } | null;
  dive: Dive | null;
  strikeAt: number | null; // performance.now()
  outcome: KickOutcome | null;
  winner: Side | null;
  aim: { x: number; y: number };
  power: number;
  charging: boolean;
  chargeAt: number;
  keeperX: number;
  keeperY: number;
  diveCommitted: boolean;
  aiAt: number | null; // performance.now() the AI shooter will strike
}

let match: Match | null = null;
let seq = 1;
const listeners = new Set<() => void>();

/** The probe's overrides for the AI's shot or dive (window.__swarmPenalty.forceShot/forceDive): stick until cleared
 * (pass null) or replaced, so a test can arm one ahead of the AI's turn without racing its clock. */
let forcedShot: { x: number; y: number; power: number } | null = null;
let forcedDive: Dive | null = null;
export const forcePenaltyShot = (shot: { x: number; y: number; power: number } | null) => void (forcedShot = shot);
export const forcePenaltyDive = (dive: Dive | null) => void (forcedDive = dive);

export const penaltyMatch = () => match;

export function penaltyChanged() {
  for (const fn of listeners) fn();
}

export function subscribePenalty(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Whether a goal is free for a new match: nobody's playing. */
export const penaltyFree = () => !match;

// ---------- the opponent's trip out and back (parkErrand.ts, ParkOpponent.tsx) ----------

/** Who's hidden from their floor, out in the park (or on the way), while the sequence runs; null once they're back. */
let awayId: string | null = null;
export const parkAwayId = () => awayId;
export function setParkAway(id: string | null) {
  awayId = id;
}

/** Someone free, on any floor, CEO included; null when nobody's free to play. */
function pickOpponent(): { id: string; name: string } | null {
  const s = useStore.getState();
  const free = Object.values(s.agents).filter((a) => isFree(a.status));
  if (free.length === 0) return null;
  const pick = free[Math.floor(Math.random() * free.length)];
  return { id: pick.id, name: pick.name };
}

/**
 * E at the penalty spot: a free agent (any floor, CEO included) sets off for the goal (parkErrand.ts walks them);
 * the match exists from now (stage 'walkup'), but play starts once they arrive (penaltyOpponentArrived). False
 * ("Everyone's busy, try again later") when nobody's free.
 */
export function requestPenaltyMatch(): boolean {
  if (match) return true;
  const opp = pickOpponent();
  if (!opp) return false;
  startPenaltyMatch(opp.id, opp.name);
  useStore.getState().setHeld({ kind: 'penalty', id: 'match' });
  return true;
}

/** The chosen opponent reached the spot (parkErrand.ts / ParkOpponent.tsx): the shoot-out begins. */
export function penaltyOpponentArrived() {
  if (!match || match.stage !== 'walkup') return;
  match.stage = 'setup';
  match.since = performance.now();
  penaltyChanged();
}

/** Starts the match record itself, for `opponentId`; a building block for requestPenaltyMatch and the probe. */
export function startPenaltyMatch(opponentId: string, opponentName: string): Match | null {
  if (match) return null;
  match = {
    id: seq++,
    opponentId,
    opponentName,
    turn: 'player',
    stage: 'walkup',
    since: performance.now(),
    kicks: [],
    shot: null,
    dive: null,
    strikeAt: null,
    outcome: null,
    winner: null,
    aim: { x: 0, y: GOAL.height * 0.45 },
    power: 0,
    charging: false,
    chargeAt: 0,
    keeperX: 0,
    keeperY: GOAL.height * 0.4,
    diveCommitted: false,
    aiAt: null,
  };
  penaltyChanged();
  return match;
}

/** Work called the opponent back, or they left some other way: no result, the goal's free again. */
export function abandonPenaltyMatch() {
  if (!match) return;
  if (useStore.getState().held?.kind === 'penalty') useStore.getState().setHeld(null);
  match = null;
  penaltyChanged();
}

// ---------- the player's side ----------

export const playerRole = (): 'shooter' | 'keeper' | null => (match ? (match.turn === 'player' ? 'shooter' : 'keeper') : null);

const FRAME = { halfW: GOAL.width / 2, height: GOAL.height };
/** Metres the aim (or the dive) moves per pixel of mouse movement. */
const PER_PX = 0.012;

/** Mouse movement while shooting: aims the marker over the goal mouth (frame coordinates, +x right, +y up). */
export function penaltyAim(dx: number, dy: number, sensitivity = 1) {
  if (!match) return;
  const lim = FRAME.halfW + OVER_AIM;
  match.aim.x = Math.min(lim, Math.max(-lim, match.aim.x + dx * PER_PX * sensitivity));
  match.aim.y = Math.min(FRAME.height + OVER_AIM, Math.max(0, match.aim.y - dy * PER_PX * sensitivity));
}

/** Mouse movement while keeping: aims the dive target the same way the shooter aims. */
export function penaltyAimDive(dx: number, dy: number, sensitivity = 1) {
  if (!match || match.diveCommitted) return;
  match.keeperY = Math.min(FRAME.height, Math.max(0, match.keeperY - dy * PER_PX * sensitivity));
  penaltyShuffle(dx * PER_PX * sensitivity);
}

/** A/D while keeping: shuffles along the line. */
export function penaltyShuffle(dx: number) {
  if (!match || match.diveCommitted) return;
  match.keeperX = Math.min(FRAME.halfW + 0.4, Math.max(-(FRAME.halfW + 0.4), match.keeperX + dx));
}

/** Holding the throw key or the mouse button while shooting: charges the power. */
export function penaltyCharge(on: boolean) {
  if (!match || match.turn !== 'player' || match.stage !== 'live') return;
  if (on && !match.charging) {
    match.charging = true;
    match.chargeAt = performance.now();
  } else if (!on && match.charging) {
    match.charging = false;
    strike(match.aim.x, match.aim.y, match.power);
  }
}

/** The keeper (you) commits their dive, final: no more moving once it's thrown. */
export function penaltyCommitDive() {
  if (!match || match.turn === 'player' || match.diveCommitted || match.stage === 'result' || match.stage === 'over') return;
  match.diveCommitted = true;
  match.dive = { x: match.keeperX, y: match.keeperY, at: match.strikeAt === null ? -1 : performance.now() - match.strikeAt };
}

function strike(x: number, y: number, power: number) {
  if (!match) return;
  match.shot = { x, y, power };
  match.strikeAt = performance.now();
  if (match.turn === 'player') {
    const kmh = kmhOf(power);
    match.dive = forcedDive ?? aiKeeperDive({ x, y, power }, flightMsOf(kmh), Math.random);
  }
  match.outcome = kickOutcome(match.shot, match.dive);
  match.stage = 'flight';
  match.since = performance.now();
  penaltyChanged();
}

// ---------- the clock ----------

/** Once a frame, from ParkOpponent.tsx: runs the AI's shot and the stage clock. Does nothing with no match on. */
export function tickPenalty() {
  const m = match;
  if (!m) return;
  // Work calls them back (a status patch from the office): the match leaves no result, however far it got.
  if (m.stage !== 'over' && !isFree(useStore.getState().agents[m.opponentId]?.status ?? 'idle')) {
    abandonPenaltyMatch();
    return;
  }
  const now = performance.now();
  const elapsed = now - m.since;
  switch (m.stage) {
    case 'walkup':
      return; // ParkOpponent.tsx walks them; penaltyOpponentArrived() moves this on
    case 'setup':
      if (elapsed < SETUP_MS) return;
      m.stage = 'live';
      m.since = now;
      m.aim = { x: 0, y: GOAL.height * 0.45 };
      m.power = 0;
      m.charging = false;
      m.keeperX = 0;
      m.keeperY = GOAL.height * 0.4;
      m.diveCommitted = false;
      m.dive = null;
      m.shot = null;
      if (m.turn === 'opponent') {
        m.shot = forcedShot ?? aiShooterShot(Math.random);
        m.aiAt = now + WINDUP_MS[0] + Math.random() * (WINDUP_MS[1] - WINDUP_MS[0]);
      } else {
        m.aiAt = null;
      }
      penaltyChanged();
      return;
    case 'live':
      if (m.turn === 'player') {
        if (m.charging) m.power = Math.min(1, (now - m.chargeAt) / CHARGE_MS);
      } else if (m.aiAt !== null && now >= m.aiAt && m.shot) {
        strike(m.shot.x, m.shot.y, m.shot.power);
      }
      return;
    case 'flight': {
      if (!m.outcome || !m.strikeAt || !m.shot) return;
      if (now - m.strikeAt < m.outcome.flightMs) return;
      // the player keeping may have moved (or finally committed) since the strike: the save is judged on arrival
      if (m.turn === 'opponent') m.outcome = kickOutcome(m.shot, m.dive);
      m.kicks.push({ side: m.turn, scored: m.outcome.result === 'goal', kmh: m.outcome.kmh });
      m.stage = 'result';
      m.since = now;
      penaltyChanged();
      return;
    }
    case 'result': {
      if (elapsed < RESULT_MS) return;
      const state = shootoutState(m.kicks);
      if (state.winner) {
        m.winner = state.winner;
        m.stage = 'over';
        m.since = now;
        report(m);
      } else {
        m.turn = m.turn === 'player' ? 'opponent' : 'player';
        m.stage = 'setup';
        m.since = now;
      }
      penaltyChanged();
      return;
    }
    case 'over':
      if (elapsed < OVER_MS) return;
      abandonPenaltyMatch();
  }
}

/** Reports the finished shoot-out to the office-wide board (server/swarm.ts recordPenalty). */
function report(m: Match) {
  if (!m.winner) return;
  void api.penaltyResult({ opponentId: m.opponentId, winner: m.winner, kicks: m.kicks }).catch(() => undefined);
}

// ---------- the view ----------

export interface PenaltyView {
  opponentName: string;
  you: 'shooter' | 'keeper';
  stage: Stage;
  turn: Side;
  score: { player: number; opponent: number };
  kicksShown: ('goal' | 'miss')[];
  power: number;
  winner: Side | null;
  gamePoint: boolean;
}

/** Where the camera sits while you play: behind the ball to shoot, at the keeper's eye (tracking your shuffle) to save. */
export function penaltyCamera(): { x: number; y: number; z: number; yaw: number; pitch: number } | null {
  const m = match;
  if (!m) return null;
  const g = goalPitch();
  const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));
  if (m.turn === 'player') {
    const x = g.spotX + 1.6;
    const z = g.z;
    return { x, y: 1.5, z, yaw: facing(x, z, g.lineX, g.z + m.aim.x), pitch: -0.06 };
  }
  const x = g.lineX + 0.3;
  const z = g.z + m.keeperX;
  return { x, y: 1.7, z, yaw: facing(x, z, g.spotX, g.z), pitch: 0 };
}

export function penaltyView(): PenaltyView | null {
  const m = match;
  if (!m) return null;
  const score = (side: Side) => m.kicks.filter((k) => k.side === side && k.scored).length;
  const next = shootoutState(m.kicks);
  return {
    opponentName: m.opponentName,
    you: playerRole() ?? 'shooter',
    stage: m.stage,
    turn: m.turn,
    score: { player: score('player'), opponent: score('opponent') },
    kicksShown: m.kicks.map((k) => (k.scored ? 'goal' : 'miss')),
    power: m.power,
    winner: m.winner,
    gamePoint: next.winner === null && m.kicks.length >= 4,
  };
}
