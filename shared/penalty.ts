// Penalty shoot-out rules and the office-wide leaderboard (#46). Shared: the client plays the shots and the dives by
// these rules (client/src/world/park/penaltyState.ts) and the server keeps the board (swarm.ts), accepting only
// shoot-outs that really ended the way the client says. Pure.

/** The goal (metres), the spot it's taken from, and the ball's radius (for a near-post graze). */
export const GOAL = { width: 7.32, height: 2.44, spot: 11, ballR: 0.11 };
/** The shot's speed range (km/h): 40 + 90 * power. */
export const KMH = { min: 40, max: 130 };
/** How long the keeper takes to cross from centre to their dive spot. */
export const DIVE_MS = 500;
/** How far the keeper's hands reach from where they end up, to get a glove to the ball. */
export const REACH = 1.0;
/** Office-wide rows kept on the board; past that, whoever played longest ago drops off. */
export const PENALTY_KEEP = 30;
/** The manager's id on the board (agents use their own, or shared/types.ts CEO_ID). */
export const PENALTY_PLAYER = 'player';

export type Side = 'player' | 'opponent';

/** A shot aimed at the goal mouth: `x` metres right of centre, `y` metres up from the ground, `power` 0-1. */
export interface Shot {
  x: number;
  y: number;
  power: number;
}

/** The keeper's dive: where they end up, and when (ms after the strike) they committed to it; negative = guessed. */
export interface Dive {
  x: number;
  y: number;
  at: number;
}

export type KickResultKind = 'goal' | 'saved' | 'post' | 'wide' | 'over';

export interface KickOutcome {
  result: KickResultKind;
  kmh: number;
  flightMs: number;
}

const halfW = () => GOAL.width / 2;
const CENTRE = { x: 0, y: GOAL.height * 0.45 };

/** Signed-to-unsigned distance from `v` to the closed range [lo, hi] (0 when inside it). */
const outside = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/** How close (x, y) comes to the goal frame itself (the two posts and the bar; the ground is open, no frame there). */
function frameDist(x: number, y: number): number {
  const hw = halfW();
  const left = Math.hypot(x + hw, outside(y, 0, GOAL.height));
  const right = Math.hypot(x - hw, outside(y, 0, GOAL.height));
  const bar = Math.hypot(outside(x, -hw, hw), y - GOAL.height);
  return Math.min(left, right, bar);
}

/** The keeper's position `flightMs` after the strike: still at centre until `dive.at`, there by `dive.at + DIVE_MS`. */
function keeperAt(dive: Dive | null, flightMs: number): { x: number; y: number } {
  if (!dive) return CENTRE;
  const frac = Math.min(1, Math.max(0, (flightMs - dive.at) / DIVE_MS));
  return { x: CENTRE.x + (dive.x - CENTRE.x) * frac, y: CENTRE.y + (dive.y - CENTRE.y) * frac };
}

/** The shot's speed, km/h: 40 at no charge, 130 at full power. */
export const kmhOf = (power: number) => KMH.min + (KMH.max - KMH.min) * Math.min(1, Math.max(0, power));

/** How long (ms) a shot at this speed takes to cross the spot to the goal line. */
export const flightMsOf = (kmh: number) => (GOAL.spot * 3600) / kmh;

/**
 * What became of a shot aimed at (shot.x, shot.y) with `shot.power`, against a keeper who dove as `dive` says (or
 * never moved, `dive` null). Hitting the frame (within `GOAL.ballR`) is always a post, even on target; otherwise
 * off-target is wide (left or right of the posts) or over (above the bar); on target, the keeper's reach decides.
 */
export function kickOutcome(shot: Shot, dive: Dive | null): KickOutcome {
  const kmh = kmhOf(shot.power);
  const flightMs = flightMsOf(kmh);
  const { x, y } = shot;
  const hw = halfW();
  if (frameDist(x, y) <= GOAL.ballR) return { result: 'post', kmh, flightMs };
  if (x < -hw || x > hw) return { result: 'wide', kmh, flightMs };
  if (y > GOAL.height || y < 0) return { result: 'over', kmh, flightMs };
  const keeper = keeperAt(dive, flightMs);
  const saved = Math.hypot(x - keeper.x, y - keeper.y) <= REACH;
  return { result: saved ? 'saved' : 'goal', kmh, flightMs };
}

// ---------- the shoot-out ----------

/** One kick taken, in order: who took it and whether it went in. */
export interface Kick {
  side: Side;
  scored: boolean;
}

export interface ShootoutState {
  /** Whose turn is next, or null once it's decided. */
  next: Side | null;
  /** Who won, or null while it's still going. */
  winner: Side | null;
}

/**
 * Where a shoot-out stands after `kicks` (in the order taken): 3 each, alternating, the player first, ending the
 * moment one side can't catch up; level after 3 each goes to sudden death, a kick each per round, decided the
 * instant a round's two kicks aren't both scored or both missed.
 */
export function shootoutState(kicks: readonly Kick[]): ShootoutState {
  let pScore = 0;
  let oScore = 0;
  let pTaken = 0;
  let oTaken = 0;
  for (const k of kicks) {
    if (k.side === 'player') {
      pTaken++;
      if (k.scored) pScore++;
    } else {
      oTaken++;
      if (k.scored) oScore++;
    }
    if (pTaken <= 3 && oTaken <= 3) {
      const pRemain = 3 - pTaken;
      const oRemain = 3 - oTaken;
      if (pScore > oScore + oRemain) return { next: null, winner: 'player' };
      if (oScore > pScore + pRemain) return { next: null, winner: 'opponent' };
      if (pTaken === 3 && oTaken === 3 && pScore !== oScore) return { next: null, winner: pScore > oScore ? 'player' : 'opponent' };
    } else {
      const extraP = pTaken - 3;
      const extraO = oTaken - 3;
      if (extraP > 0 && extraP === extraO && pScore !== oScore) return { next: null, winner: pScore > oScore ? 'player' : 'opponent' };
    }
  }
  return { next: pTaken === oTaken ? 'player' : 'opponent', winner: null };
}

// ---------- reported results and the board ----------

/** One kick, as the client reports it: who took it, whether it scored, and how fast (for the hardest-shot record). */
export interface PenaltyKick {
  side: Side;
  scored: boolean;
  kmh: number;
}

/** A finished shoot-out as the client reports it (POST /api/penalty): the opponent's agent id and the kicks taken. */
export interface ParsedPenaltyResult {
  opponentId: string;
  winner: Side;
  kicks: PenaltyKick[];
}

/** A request body as a ParsedPenaltyResult, or what's wrong with it. */
export function parsePenaltyResult(body: unknown): ParsedPenaltyResult | { error: string } {
  const { opponentId, winner, kicks } = (body ?? {}) as { opponentId?: unknown; winner?: unknown; kicks?: unknown };
  if (typeof opponentId !== 'string' || opponentId.length === 0 || opponentId.length > 100) return { error: 'opponentId must be a non-empty id' };
  if (winner !== 'player' && winner !== 'opponent') return { error: "winner must be 'player' or 'opponent'" };
  if (!Array.isArray(kicks) || kicks.length < 1 || kicks.length > 14) return { error: 'kicks must be the kicks the shoot-out was decided by' };
  const parsed: PenaltyKick[] = [];
  for (const raw of kicks) {
    const k = raw as { side?: unknown; scored?: unknown; kmh?: unknown };
    if ((k.side !== 'player' && k.side !== 'opponent') || typeof k.scored !== 'boolean' || typeof k.kmh !== 'number' || !Number.isFinite(k.kmh) || k.kmh < 0 || k.kmh > KMH.max + 1) {
      return { error: 'each kick needs a side, whether it scored, and its speed' };
    }
    parsed.push({ side: k.side, scored: k.scored, kmh: k.kmh });
  }
  const state = shootoutState(parsed.map((k) => ({ side: k.side, scored: k.scored })));
  if (state.winner !== winner) return { error: "winner doesn't match a finished shoot-out for these kicks" };
  return { opponentId, winner, kicks: parsed };
}

/** One player on the office-wide board: the manager or an agent, with their shoot-outs. */
export interface PenaltyRow {
  id: string;
  name: string;
  wins: number;
  losses: number;
  goals: number;
  lastAt: number;
}

/** The fastest goal ever scored. */
export interface HardestShot {
  id: string;
  name: string;
  kmh: number;
  at: number;
}

export interface PenaltyBoard {
  rows: PenaltyRow[];
  hardest: HardestShot | null;
}

/** A shoot-out that just finished, ready for the board: both sides' names, the winner, the kicks, and when. */
export interface PenaltyMatch {
  /** `id` defaults to PENALTY_PLAYER (the manager, #46); a visitor match (#47) gives its own (visitorId). */
  player: { id?: string; name: string };
  opponent: { id: string; name: string };
  winner: Side;
  kicks: readonly PenaltyKick[];
  at: number;
}

const blankRow = (id: string, name: string): PenaltyRow => ({ id, name, wins: 0, losses: 0, goals: 0, lastAt: 0 });

/** Best first: most wins, then the better win rate, then more goals, then whoever played last. */
export function rankPenaltyBoard(rows: readonly PenaltyRow[]): PenaltyRow[] {
  const rate = (r: PenaltyRow) => r.wins / Math.max(1, r.wins + r.losses);
  return [...rows].sort((a, b) => b.wins - a.wins || rate(b) - rate(a) || b.goals - a.goals || b.lastAt - a.lastAt);
}

/** The board after `match` (a new object; rows are copied, never changed in place), ranked, at most `keep` rows. */
export function recordShootout(board: PenaltyBoard, match: PenaltyMatch, keep = PENALTY_KEEP): PenaltyBoard {
  const rows = board.rows.map((r) => ({ ...r }));
  const sides: { id: string; name: string; side: Side }[] = [
    { id: match.player.id ?? PENALTY_PLAYER, name: match.player.name, side: 'player' },
    { id: match.opponent.id, name: match.opponent.name, side: 'opponent' },
  ];
  let hardest = board.hardest;
  for (const p of sides) {
    let row = rows.find((r) => r.id === p.id);
    if (!row) rows.push((row = blankRow(p.id, p.name)));
    row.name = p.name;
    row.goals += match.kicks.filter((k) => k.side === p.side && k.scored).length;
    if (match.winner === p.side) row.wins++;
    else row.losses++;
    row.lastAt = Math.max(row.lastAt, match.at);
    const best = match.kicks.filter((k) => k.side === p.side && k.scored).reduce((m, k) => Math.max(m, k.kmh), 0);
    if (best > 0 && (!hardest || best > hardest.kmh)) hardest = { id: p.id, name: p.name, kmh: best, at: match.at };
  }
  const kept = rows.length > keep ? [...rows].sort((a, b) => b.lastAt - a.lastAt).slice(0, keep) : rows;
  return { rows: rankPenaltyBoard(kept), hardest };
}

// ---------- visitor matches (#47): browser -> server messages, refereed by server/penaltyMatch.ts ----------

/** The board id a visitor plays under: 'player' for the manager (any case), else 'v:' + their lower-cased name. */
export const visitorId = (name: string, managerName: string) => (name.trim().toLowerCase() === managerName.trim().toLowerCase() ? PENALTY_PLAYER : `v:${name.trim().toLowerCase()}`);

/** How far either side of the posts (and above the bar) a shot or dive may aim; beyond this, reject the message. */
const AIM_MARGIN = 2;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type PenaltyMessage =
  | { type: 'pk-join' }
  | { type: 'pk-shot'; x: number; y: number; power: number }
  | { type: 'pk-dive'; x: number; y: number }
  | { type: 'pk-shuffle'; x: number }
  | { type: 'pk-leave' };

/** A pk-* message from a browser on /ws (at most 1024 characters), validated and clamped; null for anything else. */
export function parsePenaltyMessage(raw: unknown): PenaltyMessage | null {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 1024) return null;
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const hw = GOAL.width / 2 + AIM_MARGIN;
  switch (r.type) {
    case 'pk-join':
      return { type: 'pk-join' };
    case 'pk-shot':
      if (!finite(r.x) || !finite(r.y) || !finite(r.power)) return null;
      return { type: 'pk-shot', x: clamp(r.x, -hw, hw), y: clamp(r.y, -1, GOAL.height + AIM_MARGIN), power: clamp(r.power, 0, 1) };
    case 'pk-dive':
      if (!finite(r.x) || !finite(r.y)) return null;
      return { type: 'pk-dive', x: clamp(r.x, -hw, hw), y: clamp(r.y, -1, GOAL.height + AIM_MARGIN) };
    case 'pk-shuffle':
      return finite(r.x) ? { type: 'pk-shuffle', x: clamp(r.x, -hw, hw) } : null;
    case 'pk-leave':
      return { type: 'pk-leave' };
    default:
      return null;
  }
}
