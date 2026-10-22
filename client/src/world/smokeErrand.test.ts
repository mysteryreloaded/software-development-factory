import { describe, expect, it, vi } from 'vitest';
import type { NookHandle, Stage } from './smokeBreak';

// hiringState.ts (imported by smokeErrand.ts) reaches into the store, which touches window at module load.
vi.stubGlobal('window', { addEventListener: () => undefined });
const { errandNamed } = await import('./errands');
const { handJoint, setErrand } = await import('./people');
const { agentAtSeat, NPC_SMOKE, registerNook, setAgentSeat } = await import('./smokeBreak');
await import('./smokeErrand');
const { findPath, standable, walkways } = await import('./walkways');

const smoke = errandNamed('smoke')!;

/** A bare NookHandle, with a controllable "you" (player) seat; agents' own seats come from agentAtSeat, as the real
 * SmokeNook's report() mixes in. */
function fakeNook(id: 'office-west' | 'office-east', youSeat: 0 | 1 | null = null): NookHandle {
  return {
    focusAt: () => null,
    sit: () => {},
    press: () => {},
    label: () => '',
    stub: () => {},
    report: () => ({
      seats: [0, 1].map((i): 'free' | 'you' | `agent:${string}` => {
        if (i === youSeat) return 'you';
        const a = agentAtSeat(id, i as 0 | 1);
        return a ? `agent:${a}` : 'free';
      }) as ['free' | 'you' | `agent:${string}`, 'free' | 'you' | `agent:${string}`],
      butts: 0,
      stage: 'empty' as Stage,
      puffsLeft: 0,
    }),
  };
}

describe('the smoke errand', () => {
  it('is for free agents on an office floor, once restless, never while working', () => {
    const idle = { id: 'a', status: 'idle' as const, role: 'builder' };
    const working = { ...idle, status: 'working' as const };
    expect(smoke.when(idle, { floor: 'office', statusFor: 0, seatedFor: 100, restless: 10 })).toBe(true);
    expect(smoke.when(idle, { floor: 'office', statusFor: 0, seatedFor: 1, restless: 10 })).toBe(false);
    expect(smoke.when(idle, { floor: 'lobby', statusFor: 0, seatedFor: 100, restless: 10 })).toBe(false);
    expect(smoke.when(working, { floor: 'office', statusFor: 0, seatedFor: 100, restless: 10 })).toBe(false);
  });

  it('at most 2 a floor at once', () => {
    expect(smoke.max).toBe(2);
  });

  it("every desk has a path to both benches' seats, through the doorways, clear of the bench and table", () => {
    const w = walkways('office');
    const spots = w.spots.filter((s) => s.id.startsWith('smoke-'));
    expect(spots).toHaveLength(4); // 2 nooks, 2 seats each
    for (const home of w.homes) {
      for (const to of spots) {
        expect(standable(w, to.x, to.z), to.id).toBe(true);
        const path = findPath(w, home, to);
        expect(path, `${home.id} → ${to.id}`).not.toBeNull();
        expect(path!.at(-1)).toMatchObject({ x: to.x, z: to.z });
      }
    }
  });

  it('never picks a seat the player is sitting in', () => {
    // both nooks are always mounted together on an office floor (Outside.tsx's <SmokeBreak/>)
    const unWest = registerNook('office-west', fakeNook('office-west', 0));
    const unEast = registerNook('office-east', fakeNook('office-east'));
    try {
      const free = smoke.where!('someone');
      expect(free).not.toContain('smoke-office-west-0');
      expect(free).toContain('smoke-office-west-1');
      expect(free).toContain('smoke-office-east-0');
      expect(free).toContain('smoke-office-east-1');
    } finally {
      unWest();
      unEast();
    }
  });

  it('sitting down claims the seat and rolls one; the ashtray gets a stub however it ends', () => {
    const unregister = registerNook('office-west', fakeNook('office-west'));
    try {
      expect(smoke.where!('kai')).toContain('smoke-office-west-0');
      // sat down at seat 0: ErrandDirector.tsx's report() would have published this as they arrived
      setErrand('kai', { name: 'smoke', phase: 'there', spot: 'smoke-office-west-0' });
      expect(smoke.cue!('kai', 'sit')).toBe(true);
      expect(agentAtSeat('office-west', 0)).toBe('kai');
      expect(handJoint('kai')).toMatchObject({ lit: false, puffsLeft: NPC_SMOKE.puffs });

      smoke.cue!('kai', 'light');
      expect(handJoint('kai')!.lit).toBe(true);

      const before = handJoint('kai')!.puffsLeft;
      smoke.cue!('kai', 'puff');
      const after = handJoint('kai')!;
      expect(after.puffsLeft).toBe(before - 1);
      expect(after.exhaleAt).toBeGreaterThan(0);

      smoke.end!('kai', 'cut'); // work came in, or they finished: either way, they stub it and the seat's free again
      expect(agentAtSeat('office-west', 0)).toBeNull();
      expect(handJoint('kai')).toBeNull();
      setErrand('kai', null);
    } finally {
      unregister();
    }
  });

  it('the player sitting down mid-walk, before the cue fires, cancels the sit: no seat claimed', () => {
    let youSeat: 0 | 1 | null = null;
    const unregister = registerNook('office-west', {
      focusAt: () => null,
      sit: () => {},
      press: () => {},
      label: () => '',
      stub: () => {},
      report: () => ({
        seats: [0, 1].map((i): 'free' | 'you' | `agent:${string}` => (i === youSeat ? 'you' : 'free')) as ['free' | 'you' | `agent:${string}`, 'free' | 'you' | `agent:${string}`],
        butts: 0,
        stage: 'empty' as Stage,
        puffsLeft: 0,
      }),
    });
    try {
      setErrand('kai', { name: 'smoke', phase: 'there', spot: 'smoke-office-west-0' });
      youSeat = 0; // sat down while kai was still walking over
      expect(smoke.cue!('kai', 'sit')).toBe(false);
      expect(agentAtSeat('office-west', 0)).toBeNull();
      expect(handJoint('kai')).toBeNull();
      setErrand('kai', null);
    } finally {
      unregister();
    }
  });

  it('a second agent never gets a seat the first is already sitting in', () => {
    const unWest = registerNook('office-west', fakeNook('office-west'));
    const unEast = registerNook('office-east', fakeNook('office-east'));
    try {
      setAgentSeat('office-west', 0, 'kai');
      const free = smoke.where!('jamie');
      expect(free).not.toContain('smoke-office-west-0');
      expect(free).toContain('smoke-office-west-1');
    } finally {
      setAgentSeat('office-west', 0, null);
      unWest();
      unEast();
    }
  });
});
