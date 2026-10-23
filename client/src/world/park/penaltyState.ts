// A penalty shoot-out in the park, as plain module state (like toys/pongState.ts): the opponent, the running score,
// whose kick it is, the live aim/charge/dive while it's being taken, and window.__swarmPenalty. ParkOpponent.tsx
// ticks it once a frame and walks the opponent (a visitor match also keeps its own plain-interval clock running,
// see ensureVisitorClock below); Player.tsx reads it to steer the mouse and keys while you're playing; ui/PenaltyHud.tsx
// reads it to show the score. The outcome itself (shared/penalty.ts) is pure; this is the clock.
//
// #47: a second visitor can take an agent's place. `match.visitor` marks a server-refereed match: this browser is
// always local side 'player', the other visitor always 'opponent' (`visitor.mySide` is which Side the server calls
// *this* browser, for translating its turn/pk-state). The shooter's own strike and the keeper's dive go to the
// server (pk-shot/pk-dive) instead of resolving locally; applyPkKick plays the server's outcome exactly like a local
// strike() would, so the rest of the clock (tickPenalty, Pitch.tsx, PenaltyHud.tsx) needs no further changes.

import { api } from '../../api';
import { useStore } from '../../store';
import { sendWs } from '../../net';
import type { ServerEvent } from '../../../../shared/types';
import { flightMsOf, GOAL, kickOutcome, kmhOf, shootoutState, type Dive, type KickOutcome, type PenaltyKick, type Side } from '../../../../shared/penalty';
import { isFree } from '../errands';
import { myVisitorId } from '../presence/presenceState';
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
export const CHARGE_MS = 900;
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
  diveAt: number | null; // performance.now() the keeper committed, while strikeAt (this kick's) is still unknown
  aiAt: number | null; // performance.now() the AI shooter will strike
  /** A server-refereed match against another visitor (#47), instead of the AI; null for an agent match.
   * `spectator`: neither side is this browser (just someone else on floor 0 watching) - no held, camera, input
   * or pk-* sends, and this replica is display-only (Pitch.tsx's ball and billboard). `matchKey`: the two real
   * players' ids, sorted and joined, so a NEW match (different players) is told apart from the SAME one still
   * going - a mid-match arrival's own pk-join/pk-state race can otherwise leave a stale replica that never clears. */
  visitor: { mySide: Side; spectator: boolean; matchKey: string } | null;
}

/** The server's Side (shared/penalty.ts) translated to this browser's own convention: always 'player' for itself. */
const localSide = (serverSide: Side, mySide: Side): Side => (serverSide === mySide ? 'player' : 'opponent');

/** The server's own kicks (shared/penalty.ts PenaltyKick, globally 'player'/'opponent') translated the same way -
 * seeding or overwriting `match.kicks` straight from a server event without this swaps the score whenever this
 * browser's own side isn't the server's 'player' (i.e. whenever `mySide` is 'opponent'). */
const toLocalKicks = (kicks: PenaltyKick[], mySide: Side): PenaltyKick[] => kicks.map((k) => ({ ...k, side: localSide(k.side, mySide) }));

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
  cached = null;
  for (const fn of listeners) fn();
}

export function subscribePenalty(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Whether a goal is free for a new match: nobody's playing. */
export const penaltyFree = () => !match;

// ---------- the opponent's trip out and back (ParkOpponent.tsx) ----------

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
 * E at the penalty spot: a free agent (any floor, CEO included) sets off for the goal (ParkOpponent.tsx claims and
 * walks them); the match exists from now (stage 'walkup'), but play starts once they arrive (penaltyOpponentArrived).
 * False ("Everyone's busy, try again later") when nobody's free.
 */
export function requestPenaltyMatch(): boolean {
  if (match) return true;
  const opp = pickOpponent();
  if (!opp) return false;
  startPenaltyMatch(opp.id, opp.name);
  useStore.getState().setHeld({ kind: 'penalty', id: 'match' });
  return true;
}

/** The chosen opponent reached the spot (ParkOpponent.tsx): the shoot-out begins. */
export function penaltyOpponentArrived() {
  if (!match || match.stage !== 'walkup') return;
  match.stage = 'setup';
  match.since = performance.now();
  penaltyChanged();
}

/** Starts the match record itself, for `opponentId`; a building block for requestPenaltyMatch and the probe. */
export function startPenaltyMatch(opponentId: string, opponentName: string): Match | null {
  if (match) return null;
  ensureHeldWatch();
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
    diveAt: null,
    aiAt: null,
    visitor: null,
  };
  penaltyChanged();
  return match;
}

/** Work called the opponent back, or they left some other way: no result, the goal's free again. An actual
 * participant (not a spectator) dropping a visitor match this way has to tell the server too (#47): without a
 * pk-leave it still thinks we're playing, so our own kicks time out one by one, the opponent can end up with a
 * recorded win over someone who just walked off, and the next kick's pk-state pulls us straight back in. */
export function abandonPenaltyMatch() {
  if (!match) return;
  if (match.visitor && !match.visitor.spectator) sendWs({ type: 'pk-leave' });
  if (useStore.getState().held?.kind === 'penalty') useStore.getState().setHeld(null);
  match = null;
  stopVisitorClock();
  penaltyChanged();
}

// ---------- visitor matches (#47): refereed by server/penaltyMatch.ts, relayed by server/presence.ts ----------

/** ParkOpponent.tsx only ticks the clock (tickPenalty) once a frame, and R3F stops calling it at all while this
 * tab's render loop is paused (hidden, a panel open, perf.tsx's useRenderPaused) - fine for a match against the
 * AI, which nobody else needs this tab to keep up with. A visitor match is refereed by the server and shared with
 * another browser, though, so it can't freeze just because this tab isn't being looked at right now: a plain
 * interval keeps it moving (pushing resolved kicks, flipping the turn) independent of the render loop. */
let visitorClockTimer: ReturnType<typeof setInterval> | null = null;
function ensureVisitorClock() {
  if (visitorClockTimer) return;
  visitorClockTimer = setInterval(() => {
    if (match?.visitor) tickPenalty();
  }, 150);
}
function stopVisitorClock() {
  if (!visitorClockTimer) return;
  clearInterval(visitorClockTimer);
  visitorClockTimer = null;
}

/** Starts a server-refereed match against another visitor: `turn` is already translated to this browser's own
 * side. `spectator`: neither side is us, just watching from floor 0 - no held (so no camera jump, no input, and
 * Player.tsx never sends a pk-shot/pk-dive/pk-shuffle on our behalf: all of that is gated on `held`). `kicks`
 * seeds the replica with whatever the server says has already happened, so a mid-match arrival shows the real
 * score at once instead of starting over from 0-0. */
function startVisitorMatch(otherId: string, otherName: string, mySide: Side, turn: Side, spectator: boolean, matchKey: string, kicks: PenaltyKick[]) {
  ensureHeldWatch();
  ensureFloorWatch();
  ensureVisitorClock();
  match = {
    id: seq++,
    opponentId: otherId,
    opponentName: otherName,
    turn,
    stage: 'setup',
    since: performance.now(),
    kicks: [...kicks],
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
    diveAt: null,
    aiAt: null,
    visitor: { mySide, spectator, matchKey },
  };
  if (!spectator) useStore.getState().setHeld({ kind: 'penalty', id: 'match' });
  penaltyChanged();
}

/** E on the take-over hint (Pitch.tsx): joins the park's one visitor match (the second joiner starts it live). */
export function requestPenaltyTakeover() {
  if (match) return;
  sendWs({ type: 'pk-join' });
}

/** pk-state (store.ts apply): the park's match changed. */
export function applyPkState(ev: Extract<ServerEvent, { type: 'pk-state' }>) {
  const myId = myVisitorId();
  if (!myId) return;
  if (ev.phase === 'live') {
    const playerSide = ev.players.find((p) => p.side === 'player');
    const opponentSide = ev.players.find((p) => p.side === 'opponent');
    if (!playerSide || !opponentSide) return;
    const matchKey = [playerSide.id, opponentSide.id].sort().join('|');
    if (match && match.visitor) {
      if (match.visitor.matchKey === matchKey) return; // already in it: only pk-kick moves it on from here
      abandonPenaltyMatch(); // a stale replica (a match we never cleanly left) a NEW match has since replaced
    }
    // Playing it, or just watching from floor 0 (#47's "others watch"): a bystander gets a display-only replica
    // too, so the billboard and the ball show it - but never touches held/camera/input, and leaves an unrelated
    // agent match of their own alone (it isn't this match, so there's nothing here to take over from).
    const mine = ev.players.find((p) => p.id === myId);
    const spectator = !mine;
    if (spectator && match && !match.visitor) return;
    const mySide: Side = mine?.side ?? 'player';
    const other = mySide === 'player' ? opponentSide : playerSide;
    if (match) abandonPenaltyMatch(); // taking over from (or walking in on) a local agent match: no result for it
    startVisitorMatch(other.id, other.name, mySide, localSide(ev.turn ?? mySide, mySide), spectator, matchKey, toLocalKicks(ev.kicks, mySide));
    return;
  }
  if (ev.phase === 'waiting') {
    // someone else wants to play: if that's taking over from the agent match this browser is mid-way through,
    // answer with our own pk-join, so the server's second joiner is us (ParkOpponent.tsx walks the agent home once
    // abandonPenaltyMatch() below runs, same as #46's own "an agent called back to work" abandon).
    const waiting = ev.players[0];
    if (match && !match.visitor && waiting && waiting.id !== myId) sendWs({ type: 'pk-join' });
    return;
  }
  if (ev.phase === 'done' && match?.visitor && match.winner === null) {
    // The server's own decisive kick, settled - but this replica's own clock (tickPenalty) hasn't necessarily
    // caught up yet (it only notices a winner a tick after RESULT_MS, once its own kicks array says so): without
    // this, a mid-match arrival whose local kicks never fully line up (or any replica whose own clock is just
    // running a little behind) could ride straight past 'done' into 'empty' below and get wiped with no result
    // shown at all, even though the match it was watching was definitely won by someone.
    const state = shootoutState(ev.kicks);
    if (state.winner) {
      match.kicks = toLocalKicks(ev.kicks, match.visitor.mySide);
      match.winner = localSide(state.winner, match.visitor.mySide);
      match.stage = 'over';
      match.since = performance.now();
      penaltyChanged();
    }
    return;
  }
  if (ev.phase === 'empty' && match?.visitor && match.stage !== 'over') abandonPenaltyMatch(); // forfeited: no result
}

/** pk-strike (store.ts apply): the shooter's strike just landed on the server, well before the kick itself
 * resolves - so the ball starts flying for everyone at once, not just once pk-kick settles what happened to it. */
export function applyPkStrike(ev: Extract<ServerEvent, { type: 'pk-strike' }>) {
  const m = match;
  if (!m || !m.visitor || m.stage !== 'live') return;
  m.shot = ev.shot;
  m.strikeAt = performance.now();
  penaltyChanged();
}

/** pk-kick (store.ts apply): a kick resolved, the same way for every browser on floor 0. Only this browser's own
 * ongoing visitor match animates it; tickPenalty() (unchanged) carries it through flight to the next kick or over. */
export function applyPkKick(ev: Extract<ServerEvent, { type: 'pk-kick' }>) {
  const m = match;
  // A bystander's own stage (setup/live/result) cycles on its own local SETUP_MS/RESULT_MS timers with nothing to
  // keep it in lockstep with the server's actual kick cadence (a real participant's shot is what triggers this
  // event in the first place, always while they're exactly 'live'; a watcher has no such anchor). Requiring
  // 'live' here used to drop the kick outright whenever a bystander's own clock had drifted even a tick out of
  // phase - permanently, since no further kick was coming to retry it on. The server's kick is authoritative
  // regardless of what stage a bystander's replica happens to be cycling through; only 'flight' (a kick already
  // being animated: let it finish) and 'over' (decided; the server won't send another for it) are excluded.
  if (!m || !m.visitor || m.stage === 'flight' || m.stage === 'over') return;
  if (m.stage === 'result') {
    // Still sitting on the PREVIOUS kick's result, which only flips `turn` (tickPenalty's own 'result' case) once
    // RESULT_MS has passed locally: the server sending a new kick proves that previous one didn't decide the
    // match (or it wouldn't have), so do that flip now rather than let the push below record this kick under the
    // wrong side - skipping straight to 'flight' without it would leave every kick from here on mislabelled.
    m.turn = m.turn === 'player' ? 'opponent' : 'player';
  }
  m.shot = ev.shot;
  m.dive = ev.dive;
  m.outcome = { result: ev.result, kmh: ev.kmh, flightMs: flightMsOf(ev.kmh) };
  m.strikeAt = performance.now();
  m.charging = false;
  m.stage = 'flight';
  m.since = performance.now();
  penaltyChanged();
}

// G, Esc, a panel opening, or the mouse being freed some other way: no result either (like pongState.ts's own
// held-paddle subscription). Subscribed lazily, the first time a match actually starts: store.ts imports this
// module (to apply pk-state/pk-kick, #47), so subscribing at the top level here would run while store.ts is
// still mid-evaluation, before its own `useStore` export exists.
let heldWatchStarted = false;
function ensureHeldWatch() {
  if (heldWatchStarted) return;
  heldWatchStarted = true;
  useStore.subscribe((s, prev) => {
    if (prev.held?.kind === 'penalty' && s.held?.kind !== 'penalty') abandonPenaltyMatch();
  });
}

/** Leaving floor 0 (the only floor the pitch is on) ends a visitor replica too (#47): a real participant is
 * already covered indirectly (goToFloor clears `held`, which the watch above catches), but a spectator never
 * holds anything, so without this their replica would just sit there, stale, until some other kick's pk-state
 * happens to arrive and clear it - or forever, if the match ends while they're already gone. */
let floorWatchStarted = false;
function ensureFloorWatch() {
  if (floorWatchStarted) return;
  floorWatchStarted = true;
  useStore.subscribe((s, prev) => {
    if (s.floor !== prev.floor && s.floor !== 0 && match?.visitor) abandonPenaltyMatch();
  });
}

// ---------- the player's side ----------

export const playerRole = (): 'shooter' | 'keeper' | null => (match ? (match.turn === 'player' ? 'shooter' : 'keeper') : null);

const FRAME = { halfW: GOAL.width / 2, height: GOAL.height };
/** Metres the aim (or the dive) moves per pixel of mouse movement. */
const PER_PX = 0.012;

/** Mouse movement while shooting: aims the marker over the goal mouth (frame coordinates, +x right, +y up).
 * Negated: +x here is the shooter's right, but maps to world +z (Pitch.tsx's AimMarker, PenaltyBall), which is
 * the shooter's left (they face -x, towards the goal) - without this, mouse-right would turn the aim left. */
export function penaltyAim(dx: number, dy: number, sensitivity = 1) {
  if (!match) return;
  const lim = FRAME.halfW + OVER_AIM;
  match.aim.x = Math.min(lim, Math.max(-lim, match.aim.x - dx * PER_PX * sensitivity));
  match.aim.y = Math.min(FRAME.height + OVER_AIM, Math.max(0, match.aim.y - dy * PER_PX * sensitivity));
}

/** Mouse movement while keeping: aims the dive target the same way the shooter aims. */
export function penaltyAimDive(dx: number, dy: number, sensitivity = 1) {
  if (!match || match.diveCommitted) return;
  match.keeperY = Math.min(FRAME.height, Math.max(0, match.keeperY - dy * PER_PX * sensitivity));
  penaltyShuffle(dx * PER_PX * sensitivity);
}

/** At most 10/s (shared/penalty.ts's protocol, matched server-side too, server/penaltyMatch.ts SHUFFLE_GAP_MS). */
const SHUFFLE_SEND_MS = 100;
let lastShuffleSentAt = 0;

/** A/D while keeping: shuffles along the line. */
export function penaltyShuffle(dx: number) {
  if (!match || match.diveCommitted) return;
  match.keeperX = Math.min(FRAME.halfW + 0.4, Math.max(-(FRAME.halfW + 0.4), match.keeperX + dx));
  if (match.visitor && match.turn === 'opponent') {
    const now = performance.now();
    if (now - lastShuffleSentAt >= SHUFFLE_SEND_MS) {
      lastShuffleSentAt = now;
      sendWs({ type: 'pk-shuffle', x: match.keeperX });
    }
  }
}

/** Holding the throw key or the mouse button while shooting: charges the power. */
export function penaltyCharge(on: boolean) {
  if (!match || match.turn !== 'player' || match.stage !== 'live') return;
  if (on && !match.charging) {
    match.charging = true;
    match.chargeAt = performance.now();
    penaltyChanged();
  } else if (!on && match.charging) {
    match.charging = false;
    if (match.visitor) sendWs({ type: 'pk-shot', x: match.aim.x, y: match.aim.y, power: match.power }); // applyPkKick plays it once the server resolves it
    else strike(match.aim.x, match.aim.y, match.power);
  }
}

/** The keeper (you) commits their dive, final: no more moving once it's thrown. Usually before the agent has even
 * struck (this kick's strikeAt is still null - a guess, which is the only way to stop a shot that quick): `diveAt`
 * remembers when, and strike() turns it into the dive's `at` (ms since the strike, negative) once strikeAt is known. */
export function penaltyCommitDive() {
  if (!match || match.turn === 'player' || match.diveCommitted || match.stage === 'result' || match.stage === 'over') return;
  match.diveCommitted = true;
  match.diveAt = performance.now();
  match.dive = { x: match.keeperX, y: match.keeperY, at: match.strikeAt === null ? -1 : match.diveAt - match.strikeAt };
  if (match.visitor) sendWs({ type: 'pk-dive', x: match.keeperX, y: match.keeperY }); // the server times its arrival; this local `at` is only for the camera
}

function strike(x: number, y: number, power: number) {
  if (!match) return;
  match.shot = { x, y, power };
  match.strikeAt = performance.now();
  if (match.turn === 'player') {
    const kmh = kmhOf(power);
    match.dive = forcedDive ?? aiKeeperDive({ x, y, power }, flightMsOf(kmh), Math.random);
  } else if (match.dive && match.diveAt !== null) {
    // the keeper (you) committed before this strikeAt existed: now it does
    match.dive = { ...match.dive, at: match.diveAt - match.strikeAt };
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
  // A visitor match's "opponent" is another browser, not an agent: forfeits come from the server instead (#47).
  if (!m.visitor && m.stage !== 'over' && !isFree(useStore.getState().agents[m.opponentId]?.status ?? 'idle')) {
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
      m.diveAt = null;
      m.strikeAt = null;
      m.outcome = null;
      if (m.visitor) {
        m.aiAt = null; // the real shooter (local or the other browser) strikes in their own time; applyPkKick plays it
      } else if (m.turn === 'opponent') {
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
      } else if (!m.visitor && m.aiAt !== null && now >= m.aiAt && m.shot) {
        strike(m.shot.x, m.shot.y, m.shot.power);
      }
      return;
    case 'flight': {
      if (!m.outcome || !m.strikeAt || !m.shot) return;
      if (now - m.strikeAt < m.outcome.flightMs) return;
      // the player keeping may have moved (or finally committed) since the strike: the save is judged on arrival
      // (a visitor match's outcome is the server's own, from applyPkKick: never recomputed here)
      if (!m.visitor && m.turn === 'opponent') m.outcome = kickOutcome(m.shot, m.dive);
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
        if (!m.visitor) report(m); // a visitor match is recorded server-side (server/penaltyMatch.ts), already done
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
  /** When charging, performance.now() the charge began (for the HUD's own rAF-driven meter); null otherwise. */
  chargeAt: number | null;
  winner: Side | null;
  gamePoint: boolean;
}

/** Power right now, 0..1, from when a charge began; pure, so a per-frame HUD meter can read it without a snapshot. */
export const penaltyChargePower = (chargeAt: number, now = performance.now()) => Math.min(1, (now - chargeAt) / CHARGE_MS);

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

let cached: PenaltyView | null = null;

/** The match as the HUD shows it (the same object until something changes), or null with nobody playing. */
export function penaltyView(): PenaltyView | null {
  const m = match;
  if (!m) return null;
  if (cached) return cached;
  const score = (side: Side) => m.kicks.filter((k) => k.side === side && k.scored).length;
  const next = shootoutState(m.kicks);
  cached = {
    opponentName: m.opponentName,
    you: playerRole() ?? 'shooter',
    stage: m.stage,
    turn: m.turn,
    score: { player: score('player'), opponent: score('opponent') },
    kicksShown: m.kicks.map((k) => (k.scored ? 'goal' : 'miss')),
    power: m.power,
    chargeAt: m.charging ? m.chargeAt : null,
    winner: m.winner,
    gamePoint: next.winner === null && m.kicks.length >= 4,
  };
  return cached;
}
