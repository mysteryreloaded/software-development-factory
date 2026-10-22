// A visitor-vs-visitor penalty shoot-out in the park (#47): one global match for floor 0, refereed here so every
// browser sees the same kicks. Pure (an injected clock, no I/O); owned and driven by server/presence.ts, which
// relays its state to floor 0 and tells it when a peer leaves, changes floor or wanders off (forfeit, no result).
// Kick timing matches #46's rules (shared/penalty.ts): the keeper's dive `at` is its arrival time minus the shot's;
// a kick resolves once flight + RESOLVE_GRACE_MS has passed, or after SHOT_TIMEOUT_MS with no shot at all (a miss).

import { kickOutcome, kmhOf, flightMsOf, shootoutState, type Dive, type KickResultKind, type PenaltyKick, type Shot, type Side } from '../shared/penalty.ts';

export const SHOT_TIMEOUT_MS = 15_000;
export const RESOLVE_GRACE_MS = 150;
/** The shooter's own browser may send its shot straight after setup; the keeper may shuffle at most this often. */
export const SHUFFLE_GAP_MS = 100;

export interface MatchPlayer {
  id: string;
  name: string;
}

export type Phase = 'empty' | 'waiting' | 'live' | 'done';

export interface MatchView {
  players: { id: string; name: string; side: Side }[];
  kicks: PenaltyKick[];
  turn: Side | null;
  phase: Phase;
}

export interface KickResolved {
  shot: Shot;
  dive: Dive | null;
  result: KickResultKind;
  kmh: number;
}

/** A finished match, ready for swarm.recordVisitorPenalty: both sides' names and ids, the winner and the kicks. */
export interface MatchResult {
  player: MatchPlayer;
  opponent: MatchPlayer;
  winner: Side;
  kicks: PenaltyKick[];
}

/**
 * The park's one penalty match: nobody playing ('empty'), one visitor joined ('waiting'), two alternating kicks
 * ('live'), or just decided ('done', for one tick before the hub clears it). `tick()` resolves a struck kick once
 * its flight (plus a little grace) has passed, or times out a shooter who never struck.
 */
export class PenaltyMatch {
  private a: MatchPlayer | null = null; // the 'player' side
  private b: MatchPlayer | null = null; // the 'opponent' side
  private kicks: PenaltyKick[] = [];
  private turn: Side | null = null;
  private phase: Phase = 'empty';
  private kickStartAt = 0;
  private shotVal: Shot | null = null;
  private shotAt: number | null = null;
  private diveVal: { x: number; y: number } | null = null;
  private diveAt: number | null = null;
  private lastShuffleAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get view(): MatchView {
    const players: MatchView['players'] = [];
    if (this.a) players.push({ id: this.a.id, name: this.a.name, side: 'player' });
    if (this.b) players.push({ id: this.b.id, name: this.b.name, side: 'opponent' });
    return { players, kicks: [...this.kicks], turn: this.turn, phase: this.phase };
  }

  has(id: string): boolean {
    return this.a?.id === id || this.b?.id === id;
  }

  private shooter(): MatchPlayer | null {
    return this.turn === 'player' ? this.a : this.turn === 'opponent' ? this.b : null;
  }

  private keeper(): MatchPlayer | null {
    return this.turn === 'player' ? this.b : this.turn === 'opponent' ? this.a : null;
  }

  /** `peer` wants to play: the first joiner waits, the second starts the match live. False once two are already in. */
  join(peer: MatchPlayer): boolean {
    if (this.has(peer.id)) return false;
    if (!this.a) {
      this.a = peer;
      this.phase = 'waiting';
      return true;
    }
    if (this.phase !== 'waiting' || this.b) return false;
    this.b = peer;
    this.startKick('player');
    return true;
  }

  private startKick(turn: Side) {
    this.turn = turn;
    this.phase = 'live';
    this.kickStartAt = this.now();
    this.shotVal = null;
    this.shotAt = null;
    this.diveVal = null;
    this.diveAt = null;
  }

  /** The shooter's strike; once per kick. False if it's not their turn, or they already struck this kick. */
  shot(peerId: string, shot: Shot): boolean {
    if (this.phase !== 'live' || this.shotVal !== null) return false;
    if (peerId !== this.shooter()?.id) return false;
    this.shotVal = shot;
    this.shotAt = this.now();
    return true;
  }

  /** The keeper's dive, before or after the strike; once per kick (a second one is ignored). */
  dive(peerId: string, d: { x: number; y: number }): boolean {
    if (this.phase !== 'live' || this.diveVal !== null) return false;
    if (peerId !== this.keeper()?.id) return false;
    this.diveVal = d;
    this.diveAt = this.now();
    return true;
  }

  /** The keeper shuffling along the line before the kick; rate-limited server-side too (at most 10/s). */
  shuffle(peerId: string): boolean {
    if (this.phase !== 'live' || peerId !== this.keeper()?.id) return false;
    const now = this.now();
    const last = this.lastShuffleAt.get(peerId) ?? 0;
    if (now - last < SHUFFLE_GAP_MS) return false;
    this.lastShuffleAt.set(peerId, now);
    return true;
  }

  /** Resolves the live kick once its flight (plus RESOLVE_GRACE_MS) has passed, or times out an unstruck one. */
  tick(): KickResolved | null {
    if (this.phase !== 'live') return null;
    const now = this.now();
    if (this.shotVal === null) {
      if (now - this.kickStartAt < SHOT_TIMEOUT_MS) return null;
      return this.resolve({ x: 0, y: 0, power: 0 }, null, { result: 'wide', kmh: 0 });
    }
    const kmh = kmhOf(this.shotVal.power);
    const flightMs = flightMsOf(kmh);
    if (now - this.shotAt! < flightMs + RESOLVE_GRACE_MS) return null;
    const dive: Dive | null = this.diveVal && this.diveAt !== null ? { x: this.diveVal.x, y: this.diveVal.y, at: this.diveAt - this.shotAt! } : null;
    return this.resolve(this.shotVal, dive, kickOutcome(this.shotVal, dive));
  }

  private resolve(shot: Shot, dive: Dive | null, outcome: { result: KickResultKind; kmh: number }): KickResolved {
    const kick: PenaltyKick = { side: this.turn!, scored: outcome.result === 'goal', kmh: outcome.kmh };
    this.kicks.push(kick);
    const state = shootoutState(this.kicks);
    if (state.winner) {
      this.phase = 'done';
      this.turn = null;
    } else {
      this.startKick(state.next!);
    }
    return { shot, dive, result: outcome.result, kmh: outcome.kmh };
  }

  /** Once 'done': both sides, the winner and the kicks, for the board; null before then or once already taken. */
  result(): MatchResult | null {
    if (this.phase !== 'done' || !this.a || !this.b) return null;
    const state = shootoutState(this.kicks);
    if (!state.winner) return null;
    return { player: this.a, opponent: this.b, winner: state.winner, kicks: [...this.kicks] };
  }

  /** Someone playing (or waiting to) is gone: the match ends at once, with no result either side. */
  forfeit(peerId: string): boolean {
    if (!this.has(peerId)) return false;
    this.reset();
    return true;
  }

  private reset() {
    this.a = null;
    this.b = null;
    this.kicks = [];
    this.turn = null;
    this.phase = 'empty';
    this.shotVal = null;
    this.shotAt = null;
    this.diveVal = null;
    this.diveAt = null;
  }

  /** The hub calls this right after reading a 'done' result, so the pitch is free for the next match. */
  clearDone() {
    if (this.phase === 'done') this.reset();
  }
}
