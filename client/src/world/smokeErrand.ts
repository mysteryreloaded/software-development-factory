// The smoke break errand (#58): a free office agent, now and then, walks out through a side door onto the balcony,
// stands by the bench between it and its little table (smokeBreak.ts, SmokeBreak.tsx: #57), rolls one, lights it,
// takes six puffs over about two minutes, stubs it out in that table's ashtray and comes back. Registered from
// ErrandDirector.tsx, like coffeeErrand.ts's coffee break.

import type { Gesture } from './body';
import { registerErrand, isFree, type ErrandStep } from './errands';
import { doorWalkers } from './hiringState';
import { errandOf, handJoint, setHandJoint } from './people';
import { agentAtSeat, NPC_SMOKE, nookStub, setAgentSeat, smokeNookReports, type NookId } from './smokeBreak';

/** Nook and seat a smoke-break spot id (`smoke-<nookId>-<0|1>`, walkways.ts) names. */
function parseSmokeSpot(spotId: string): { nook: NookId; seat: 0 | 1 } | null {
  const m = /^smoke-(office-west|office-east)-([01])$/.exec(spotId);
  return m ? { nook: m[1] as NookId, seat: Number(m[2]) as 0 | 1 } : null;
}

/** The smoke-break spots nobody (not the player, not another agent) is sitting at right now. */
function freeSmokeSpots(): string[] {
  const out: string[] = [];
  for (const r of smokeNookReports()) r.seats.forEach((s, i) => void (s === 'free' && out.push(`smoke-${r.id}-${i}`)));
  return out;
}

const steps: ErrandStep[] = [
  { gesture: 'none', seconds: 0.05, cue: 'sit' },
  { gesture: 'roll', seconds: NPC_SMOKE.roll, cue: 'roll' },
  { gesture: 'light', seconds: NPC_SMOKE.light, cue: 'light' },
  ...Array.from({ length: NPC_SMOKE.puffs }, (_, i): ErrandStep[] => [
    { gesture: 'puff' as Gesture, seconds: NPC_SMOKE.puffGesture, cue: 'puff' },
    { gesture: 'none', seconds: NPC_SMOKE.puffGap, turn: i % 2 ? 0.3 : -0.3 },
  ]).flat(),
];

/** Who (of ours) is seated where, so `end` can let go of the seat and the ashtray gets its stub. */
const seated = new Map<string, { nook: NookId; seat: 0 | 1 }>();

registerErrand({
  name: 'smoke',
  when: (agent, s) => s.floor === 'office' && isFree(agent.status) && s.seatedFor >= s.restless,
  spot: [],
  where: () => freeSmokeSpots(),
  weight: 0.5, // about half as likely as a plain stretch
  max: 2,
  steps,
  // the doorway opens for them for the whole round trip; shut again once they're back (or never got there)
  claim(agentId) {
    doorWalkers.add(agentId);
    return true;
  },
  cue(agentId, cue) {
    if (cue === 'sit') {
      const parsed = parseSmokeSpot(errandOf(agentId)?.spot ?? '');
      if (!parsed || agentAtSeat(parsed.nook, parsed.seat)) return false; // taken a moment ago after all
      seated.set(agentId, parsed);
      setAgentSeat(parsed.nook, parsed.seat, agentId);
      setHandJoint(agentId, { lit: false, puffsLeft: NPC_SMOKE.puffs, exhaleAt: 0 });
      return true;
    }
    if (cue === 'light') {
      setHandJoint(agentId, { lit: true, puffsLeft: NPC_SMOKE.puffs, exhaleAt: 0 });
      return true;
    }
    if (cue === 'puff') {
      const j = handJoint(agentId);
      const puffsLeft = Math.max(0, (j?.puffsLeft ?? NPC_SMOKE.puffs) - 1);
      setHandJoint(agentId, { lit: puffsLeft > 0, puffsLeft, exhaleAt: performance.now() });
    }
    return true;
  },
  end(agentId) {
    const info = seated.get(agentId);
    seated.delete(agentId);
    if (info) {
      setAgentSeat(info.nook, info.seat, null);
      nookStub(info.nook); // however it ends, what they'd rolled is stubbed out
    }
    setHandJoint(agentId, null);
    doorWalkers.delete(agentId);
  },
});
