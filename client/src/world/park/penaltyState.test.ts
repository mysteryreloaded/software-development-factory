import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../store';

// The store pulls in the sound module, which listens on window for the first click; tests run in node.
vi.stubGlobal('window', { addEventListener: () => undefined });
const { useStore } = await import('../../store');
const {
  abandonPenaltyMatch,
  penaltyCharge,
  penaltyFree,
  penaltyMatch,
  penaltyOpponentArrived,
  startPenaltyMatch,
  tickPenalty,
} = await import('./penaltyState');

const agent = (id: string, patch: Partial<Agent> = {}): Agent =>
  ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    repoId: '',
    role: 'agent',
    status: 'idle',
    task: null,
    issueNumber: null,
    prNumber: null,
    branch: null,
    look: 'masculine',
    ...patch,
  }) as Agent;

const SETUP_MS = 500;
const CHARGE_MS = 900;
const RESULT_MS = 1600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  abandonPenaltyMatch(); // a stray match from an earlier test (module state outlives each test)
  useStore.setState({ agents: {}, held: null });
});

afterEach(() => {
  abandonPenaltyMatch();
  vi.useRealTimers();
});

describe('the stage clock', () => {
  it('walks through walkup, setup, a kick, and back to setup with no winner yet', () => {
    const m = startPenaltyMatch('bob', 'Bob')!;
    expect(m.stage).toBe('walkup');

    penaltyOpponentArrived();
    expect(penaltyMatch()!.stage).toBe('setup');

    tickPenalty(); // SETUP_MS hasn't elapsed yet
    expect(penaltyMatch()!.stage).toBe('setup');
    vi.advanceTimersByTime(SETUP_MS);
    tickPenalty();
    expect(penaltyMatch()!.stage).toBe('live');
    expect(penaltyMatch()!.turn).toBe('player');

    // charge to full power and strike: a deterministic flight time follows from the shot's speed
    penaltyCharge(true);
    vi.advanceTimersByTime(CHARGE_MS);
    tickPenalty();
    penaltyCharge(false);
    expect(penaltyMatch()!.stage).toBe('flight');
    const flightMs = penaltyMatch()!.outcome!.flightMs;

    tickPenalty(); // the flight isn't over yet
    expect(penaltyMatch()!.stage).toBe('flight');
    vi.advanceTimersByTime(flightMs + 10);
    tickPenalty();
    expect(penaltyMatch()!.stage).toBe('result');
    expect(penaltyMatch()!.kicks).toHaveLength(1);

    tickPenalty(); // RESULT_MS hasn't elapsed yet
    expect(penaltyMatch()!.stage).toBe('result');
    vi.advanceTimersByTime(RESULT_MS);
    tickPenalty();
    const after = penaltyMatch()!;
    expect(after.stage).toBe('setup'); // one kick in: nobody's won yet
    expect(after.turn).toBe('opponent');
  });

  it('abandons the match once OVER_MS has passed in "over"', () => {
    startPenaltyMatch('bob', 'Bob');
    penaltyOpponentArrived();
    const m = penaltyMatch()!;
    m.stage = 'over';
    m.since = performance.now();
    m.winner = 'player';
    tickPenalty();
    expect(penaltyMatch()).not.toBeNull(); // OVER_MS hasn't elapsed yet
    vi.advanceTimersByTime(4000);
    tickPenalty();
    expect(penaltyMatch()).toBeNull();
  });
});

describe('work calling the opponent back', () => {
  it('abandons the match with no result, and clears a held penalty', () => {
    useStore.setState({ agents: { bob: agent('bob') } });
    startPenaltyMatch('bob', 'Bob');
    penaltyOpponentArrived();
    useStore.getState().setHeld({ kind: 'penalty', id: 'match' });
    tickPenalty();
    expect(penaltyMatch()).not.toBeNull();

    useStore.setState((s) => ({ agents: { ...s.agents, bob: { ...s.agents.bob, status: 'preparing' } } }));
    tickPenalty();
    expect(penaltyMatch()).toBeNull();
    expect(penaltyFree()).toBe(true);
    expect(useStore.getState().held).toBeNull();
  });

  it('leaves the match alone while the opponent stays free', () => {
    useStore.setState({ agents: { bob: agent('bob') } });
    startPenaltyMatch('bob', 'Bob');
    penaltyOpponentArrived();
    tickPenalty();
    expect(penaltyMatch()).not.toBeNull();
  });
});

describe('leaving (G, Esc, or any other way the held penalty is dropped)', () => {
  it('abandons the match as soon as the held penalty is cleared', () => {
    startPenaltyMatch('bob', 'Bob');
    useStore.getState().setHeld({ kind: 'penalty', id: 'match' });
    expect(penaltyMatch()).not.toBeNull();

    useStore.getState().setHeld(null); // what dropHeld() (hands.ts) does on G/Esc
    expect(penaltyMatch()).toBeNull();
  });

  it('leaves an unrelated match alone when some other held item comes and goes', () => {
    startPenaltyMatch('bob', 'Bob'); // never picked up as `held` (that's requestPenaltyMatch's job, not this test's)
    useStore.getState().setHeld({ kind: 'mug', id: 'mug-1', sips: 2 });
    useStore.getState().setHeld(null);
    expect(penaltyMatch()).not.toBeNull();
  });
});
