// window.__swarmPenalty: the penalty shoot-out for QA and Playwright (pointer lock doesn't work headless). Starts a
// match against an agent (or picks a free one), takes the player's shot or dive directly (no mouse needed), forces
// the AI's next shot or dive, and reads the whole match plus the office-wide board.

import { useStore } from '../../store';
import type { Dive } from '../../../../shared/penalty';
import {
  forcePenaltyDive,
  forcePenaltyShot,
  parkAwayId,
  penaltyCharge,
  penaltyCommitDive,
  penaltyMatch,
  penaltyView,
  playerRole,
  requestPenaltyMatch,
  requestPenaltyTakeover,
  startPenaltyMatch,
  type Match,
} from './penaltyState';

function state() {
  const m = penaltyMatch();
  const v = penaltyView();
  return {
    view: v,
    turn: m?.turn ?? null,
    stage: m?.stage ?? null,
    you: playerRole(),
    aim: m ? { ...m.aim } : null,
    power: m?.power ?? 0,
    keeper: m ? { x: m.keeperX, y: m.keeperY } : null,
    opponentId: m?.opponentId ?? null,
    away: parkAwayId(),
    kicks: m ? [...m.kicks] : [],
    winner: m?.winner ?? null,
    visitor: !!m?.visitor, // a server-refereed match against another visitor (#47), not the AI
  };
}

const probe = {
  get state() {
    return state();
  },
  /** Starts a shoot-out: against `opponentId` if given and free, otherwise any free agent. False if nobody's free. */
  start(opponentId?: string) {
    if (!opponentId) return requestPenaltyMatch();
    const a = useStore.getState().agents[opponentId];
    if (!a) return false;
    const m = startPenaltyMatch(a.id, a.name);
    if (m) useStore.getState().setHeld({ kind: 'penalty', id: 'match' });
    return !!m;
  },
  /** Jumps a waiting match straight to play, skipping the walk out (for quick tests). */
  skipWalk() {
    const m: Match | null = penaltyMatch();
    if (!m || m.stage !== 'walkup') return false;
    m.stage = 'setup';
    m.since = performance.now();
    return true;
  },
  /** As shooter: aims at (x, y) in the goal's frame coordinates (metres, centre at 0, ground at 0) and shoots at `power` (0-1). */
  shoot(x: number, y: number, power = 0.8) {
    const m = penaltyMatch();
    if (!m || m.turn !== 'player' || m.stage !== 'live') return false;
    m.aim = { x, y };
    penaltyCharge(true);
    m.power = power;
    penaltyCharge(false);
    return true;
  },
  /** As keeper: dives at (x, y) at once. */
  dive(x: number, y: number) {
    const m = penaltyMatch();
    if (!m || m.turn !== 'opponent' || (m.stage !== 'live' && m.stage !== 'flight')) return false;
    m.keeperX = x;
    m.keeperY = y;
    penaltyCommitDive();
    return true;
  },
  /** Takes over the agent's place (#47), or joins a visitor waiting for a second: sends pk-join. */
  takeover: () => requestPenaltyTakeover(),
  /** Forces the AI's next shot (as shooter) or dive (as keeper); null clears it. */
  forceShot: (shot: { x: number; y: number; power: number } | null) => forcePenaltyShot(shot),
  forceDive: (dive: Dive | null) => forcePenaltyDive(dive),
  /** The office-wide board, as the client has it. */
  board: () => useStore.getState().penalty,
  /** For tests: work calling the opponent back, the same patch the office would send (AgentPatch status). */
  callBack: (id: string) => useStore.getState().apply({ type: 'agents', agents: [{ id, status: 'preparing' }] }),
};

if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__swarmPenalty = probe;
