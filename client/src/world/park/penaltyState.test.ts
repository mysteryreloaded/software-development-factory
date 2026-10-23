import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../store';

// The store pulls in the sound module, which listens on window for the first click; tests run in node.
vi.stubGlobal('window', { addEventListener: () => undefined });
const sendWs = vi.fn(() => true);
vi.mock('../../net', () => ({ sendWs }));
const { useStore } = await import('../../store');
const { takeRoster } = await import('../presence/presenceState');
const {
  abandonPenaltyMatch,
  applyPkKick,
  applyPkState,
  applyPkStrike,
  forcePenaltyShot,
  penaltyCharge,
  penaltyCommitDive,
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
  useStore.setState({ agents: {}, held: null, floor: 0 });
  sendWs.mockClear();
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

describe("the keeper's dive, judged against when the agent actually strikes", () => {
  it('a dive committed before strikeAt exists (the only way to stop a quick shot) still saves it', () => {
    startPenaltyMatch('bob', 'Bob');
    penaltyOpponentArrived();
    vi.advanceTimersByTime(SETUP_MS);
    tickPenalty(); // 'live', turn 'player': play their kick out of the way first

    penaltyCharge(true);
    vi.advanceTimersByTime(CHARGE_MS);
    tickPenalty();
    penaltyCharge(false); // strikes, 'flight'
    const flightMs1 = penaltyMatch()!.outcome!.flightMs;
    vi.advanceTimersByTime(flightMs1 + 10);
    tickPenalty(); // 'result'
    vi.advanceTimersByTime(RESULT_MS);
    tickPenalty(); // 'setup', turn 'opponent'
    expect(penaltyMatch()!.turn).toBe('opponent');

    // arm the agent's shot before 'live' starts (penaltyState.ts reads it exactly at the setup->live transition)
    forcePenaltyShot({ x: 2.5, y: 1, power: 1 });
    vi.advanceTimersByTime(SETUP_MS + 5); // +5: floating-point flight times upstream can shave a hair off SETUP_MS
    tickPenalty(); // 'live': m.strikeAt is null here (the bug: it used to still be the previous kick's)
    expect(penaltyMatch()!.stage).toBe('live');
    expect(penaltyMatch()!.strikeAt).toBeNull();

    const m = penaltyMatch()!;
    m.keeperX = 2.5;
    m.keeperY = 1;
    penaltyCommitDive(); // guesses now, well before the agent strikes

    vi.advanceTimersByTime(1700); // past WINDUP_MS's range: the agent has struck by now
    tickPenalty();
    expect(penaltyMatch()!.stage).toBe('flight');
    const flightMs2 = penaltyMatch()!.outcome!.flightMs;
    vi.advanceTimersByTime(flightMs2 + 10);
    tickPenalty(); // 'result': the kick is judged on arrival

    expect(penaltyMatch()!.kicks.at(-1)).toMatchObject({ side: 'opponent', scored: false });
    forcePenaltyShot(null);
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

describe('a visitor match (#47): refereed by the server, applyPkState/applyPkKick', () => {
  beforeEach(() => takeRoster({ type: 'visitors', you: 'me', visitors: [] }, 0));

  it('starts from pk-state live and plays a server-reported kick through to the next one', () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'me', name: 'Me', side: 'player' }, { id: 'other', name: 'Other', side: 'opponent' }], kicks: [] });
    const m = penaltyMatch()!;
    expect(m.visitor).not.toBeNull();
    expect(m.turn).toBe('player'); // this browser is always its own 'player'

    vi.advanceTimersByTime(500); // SETUP_MS: 'setup' -> 'live'
    tickPenalty();
    expect(penaltyMatch()!.stage).toBe('live');

    applyPkKick({ type: 'pk-kick', shot: { x: 0, y: 2, power: 0.5 }, dive: null, result: 'goal', kmh: 85 });
    expect(penaltyMatch()!.stage).toBe('flight');

    vi.advanceTimersByTime(10_000);
    tickPenalty();
    expect(penaltyMatch()!.stage).not.toBe('flight'); // a real flight time: moves on well within 10s
    expect(penaltyMatch()!.kicks).toEqual([{ side: 'player', scored: true, kmh: 85 }]);
  });

  it("a shot-clock timeout (kmh 0, nobody struck in time) still leaves the 'flight' stage, not stuck forever", () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'me', name: 'Me', side: 'player' }, { id: 'other', name: 'Other', side: 'opponent' }], kicks: [] });
    vi.advanceTimersByTime(500);
    tickPenalty();

    applyPkKick({ type: 'pk-kick', shot: { x: 0, y: 0, power: 0 }, dive: null, result: 'wide', kmh: 0 }); // server/penaltyMatch.ts SHOT_TIMEOUT_MS fallback
    expect(penaltyMatch()!.stage).toBe('flight');

    tickPenalty(); // flightMs must be 0, not Infinity: this alone (no time advance needed) should resolve it
    expect(penaltyMatch()!.stage).toBe('result');
    expect(penaltyMatch()!.kicks).toEqual([{ side: 'player', scored: false, kmh: 0 }]);
  });

  it("a bystander's own replica (never shoots, so its stage only cycles on local timers) still applies a kick that arrives while it's mid-'setup', not just exactly 'live'", () => {
    // A real participant's own shot is what sends pk-shot in the first place, always while they're locally 'live' -
    // a bystander never shoots, so nothing keeps its own setup/live/result cycle in lockstep with the server's
    // actual kick cadence, and the server's pk-kick can arrive at any point in that cycle.
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: [] });
    expect(penaltyMatch()!.stage).toBe('setup'); // never shot: still mid local setup when the kick lands
    applyPkKick({ type: 'pk-kick', shot: { x: 0, y: 2, power: 0.5 }, dive: null, result: 'goal', kmh: 85 });
    expect(penaltyMatch()!.stage).toBe('flight');
    expect(penaltyMatch()!.winner).toBeNull();
  });

  it("the next kick landing while a bystander's own clock is still showing the PREVIOUS kick's 'result' flips the turn first, so kicks keep alternating sides", () => {
    // tickPenalty's own 'result' case is the only place `turn` normally flips, and only once RESULT_MS has passed
    // locally; skipping straight from 'result' to 'flight' for a new kick without that flip would record it under
    // the same side as the one before it, corrupting every side label from there on (and so shootoutState()'s count
    // of each side's kicks, which is what decides the match).
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: [] });
    vi.advanceTimersByTime(500);
    tickPenalty();
    expect(penaltyMatch()!.stage).toBe('live');

    applyPkKick({ type: 'pk-kick', shot: { x: 0, y: 2, power: 0.5 }, dive: null, result: 'goal', kmh: 85 });
    // Just past this kick's flight (~466 ms) but well short of RESULT_MS (1600 ms) after it: the match's own
    // visitor-clock interval (ensureVisitorClock, independent of this test calling tickPenalty itself) runs
    // under these fake timers too, so advancing time alone already carries it from 'flight' into 'result'.
    vi.advanceTimersByTime(1_000);
    expect(penaltyMatch()!.stage).toBe('result');
    expect(penaltyMatch()!.kicks).toEqual([{ side: 'player', scored: true, kmh: 85 }]);

    applyPkKick({ type: 'pk-kick', shot: { x: 0, y: 2, power: 0.5 }, dive: null, result: 'goal', kmh: 85 }); // kick 2 arrives early
    vi.advanceTimersByTime(1_000);
    expect(penaltyMatch()!.kicks).toEqual([
      { side: 'player', scored: true, kmh: 85 },
      { side: 'opponent', scored: true, kmh: 85 }, // flipped, not another 'player'
    ]);
  });

  it('a spectator (neither side is me) gets a display-only replica: no held, and an unrelated agent match of their own is left alone', () => {
    startPenaltyMatch('bob', 'Bob'); // my own, unrelated agent match - a free agent walking out to the park
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: [] });
    // Not this match: my own agent match is untouched, and nothing here grabs held/camera/input for it.
    expect(penaltyMatch()!.opponentId).toBe('bob');
    expect(useStore.getState().held).toBeNull();
  });

  it('an actual participant (one of the two sides) does get held, camera and input - not a spectator', () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'me', name: 'Me', side: 'player' }, { id: 'other', name: 'Other', side: 'opponent' }], kicks: [] });
    expect(penaltyMatch()!.visitor).toMatchObject({ spectator: false });
    expect(useStore.getState().held).toEqual({ kind: 'penalty', id: 'match' });
  });

  it('dropping an active visitor match (G/Esc/a panel) tells the server too, so it does not record a forfeit win for the opponent or pull this browser straight back in', () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'me', name: 'Me', side: 'player' }, { id: 'other', name: 'Other', side: 'opponent' }], kicks: [] });
    useStore.getState().setHeld(null); // G/Esc: dropHeld() does this, which the held-watch (ensureHeldWatch) turns into an abandon
    expect(sendWs).toHaveBeenCalledWith({ type: 'pk-leave' });
    expect(penaltyMatch()).toBeNull();
  });

  it("a spectator's own replica - never held, so nothing to drop - sends no pk-leave: they were never a participant to forfeit", () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: [] });
    abandonPenaltyMatch();
    expect(sendWs).not.toHaveBeenCalledWith({ type: 'pk-leave' });
  });

  it('a mid-match arrival is seeded with the kicks already taken, not 0-0', () => {
    applyPkState({
      type: 'pk-state',
      phase: 'live',
      turn: 'opponent',
      players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }],
      kicks: [{ side: 'player', scored: true, kmh: 100 }, { side: 'opponent', scored: false, kmh: 90 }],
    });
    expect(penaltyMatch()!.kicks).toEqual([{ side: 'player', scored: true, kmh: 100 }, { side: 'opponent', scored: false, kmh: 90 }]);
  });

  it("a mid-match arrival's seeded kicks are translated to this browser's own side convention, not copied from the server's global labels verbatim (which would swap the score whenever mySide is 'opponent')", () => {
    applyPkState({
      type: 'pk-state',
      phase: 'live',
      turn: 'opponent',
      players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'me', name: 'Me', side: 'opponent' }], // I'm the server's 'opponent'
      kicks: [{ side: 'player', scored: true, kmh: 100 }, { side: 'opponent', scored: false, kmh: 90 }],
    });
    // 'player' (the server's, Other's) kick is MY 'opponent'; 'opponent' (the server's, mine) kick is MY 'player'.
    expect(penaltyMatch()!.kicks).toEqual([{ side: 'opponent', scored: true, kmh: 100 }, { side: 'player', scored: false, kmh: 90 }]);
  });

  it("the 'done' phase's kicks are translated too, not just seeded ones - the same swap risk on every decisive kick, not only a mid-match arrival", () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'me', name: 'Me', side: 'opponent' }], kicks: [] });
    expect(penaltyMatch()!.visitor).toMatchObject({ mySide: 'opponent' });
    const kicks = [
      { side: 'player' as const, scored: true, kmh: 100 },
      { side: 'opponent' as const, scored: false, kmh: 90 },
      { side: 'player' as const, scored: true, kmh: 100 },
      { side: 'opponent' as const, scored: false, kmh: 90 },
      { side: 'player' as const, scored: true, kmh: 100 },
    ]; // the server's 'player' (Other) wins 3-0
    applyPkState({ type: 'pk-state', phase: 'done', turn: null, players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'me', name: 'Me', side: 'opponent' }], kicks });
    expect(penaltyMatch()!.winner).toBe('opponent'); // Other, the server's 'player', is MY 'opponent'
    // mine (the server's 'opponent', translated to my own 'player') never scored; theirs (the server's 'player',
    // translated to my own 'opponent') always did - swapped verbatim, this would show the other way round.
    expect(penaltyMatch()!.kicks.filter((k) => k.side === 'player').every((k) => !k.scored)).toBe(true);
    expect(penaltyMatch()!.kicks.filter((k) => k.side === 'opponent').every((k) => k.scored)).toBe(true);
  });

  it('a new match (different players) replaces a stale replica instead of being silently ignored forever', () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: [] });
    const firstId = penaltyMatch()!.id;
    // A completely different pair: the old replica (never cleanly ended, e.g. a missed 'empty') must not block it.
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'third', name: 'Third', side: 'player' }, { id: 'fourth', name: 'Fourth', side: 'opponent' }], kicks: [] });
    expect(penaltyMatch()!.id).not.toBe(firstId);
    expect(penaltyMatch()!.opponentName).toBe('Fourth');
  });

  it("the decisive kick's own 'done' phase settles a replica whose local clock hasn't caught up yet, instead of letting the next 'empty' wipe it with no result", () => {
    const kicks = [
      { side: 'player' as const, scored: true, kmh: 100 },
      { side: 'opponent' as const, scored: false, kmh: 90 },
      { side: 'player' as const, scored: true, kmh: 100 },
      { side: 'opponent' as const, scored: false, kmh: 90 },
      { side: 'player' as const, scored: true, kmh: 100 },
    ]; // player wins 3-0 after 3 each
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'opponent', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: kicks.slice(0, 1) });
    applyPkState({ type: 'pk-state', phase: 'done', turn: null, players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks });
    expect(penaltyMatch()!.stage).toBe('over');
    expect(penaltyMatch()!.winner).toBe('player'); // this replica's own mySide defaulted to 'player' (a spectator)
    expect(penaltyMatch()!.kicks).toEqual(kicks);
  });

  it('leaving floor 0 ends a visitor replica (a spectator never holds anything, so nothing else would catch this)', () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'other', name: 'Other', side: 'player' }, { id: 'another', name: 'Another', side: 'opponent' }], kicks: [] });
    expect(penaltyMatch()).not.toBeNull();
    useStore.setState({ floor: 1 });
    expect(penaltyMatch()).toBeNull();
  });

  it('pk-strike moves the ball at once (still live, no outcome yet) - pk-kick settles what actually happened to it', () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'me', name: 'Me', side: 'player' }, { id: 'other', name: 'Other', side: 'opponent' }], kicks: [] });
    vi.advanceTimersByTime(500);
    tickPenalty();
    expect(penaltyMatch()!.stage).toBe('live');

    applyPkStrike({ type: 'pk-strike', shot: { x: 1, y: 2, power: 0.8 } });
    expect(penaltyMatch()!.stage).toBe('live'); // not yet settled
    expect(penaltyMatch()!.shot).toEqual({ x: 1, y: 2, power: 0.8 });
    expect(penaltyMatch()!.strikeAt).not.toBeNull();

    applyPkKick({ type: 'pk-kick', shot: { x: 1, y: 2, power: 0.8 }, dive: null, result: 'goal', kmh: 130 });
    expect(penaltyMatch()!.stage).toBe('flight'); // now settled
  });

  it("pk-kick keeps pk-strike's own timing for this same kick, rather than restarting the flight from the spot", () => {
    applyPkState({ type: 'pk-state', phase: 'live', turn: 'player', players: [{ id: 'me', name: 'Me', side: 'player' }, { id: 'other', name: 'Other', side: 'opponent' }], kicks: [] });
    vi.advanceTimersByTime(500);
    tickPenalty();

    applyPkStrike({ type: 'pk-strike', shot: { x: 1, y: 2, power: 0.8 } });
    const strikeAt = penaltyMatch()!.strikeAt;
    expect(strikeAt).not.toBeNull();

    vi.advanceTimersByTime(10_000); // well past this kmh's flight time, still waiting on pk-kick to settle it
    applyPkKick({ type: 'pk-kick', shot: { x: 1, y: 2, power: 0.8 }, dive: null, result: 'goal', kmh: 130 });
    expect(penaltyMatch()!.strikeAt).toBe(strikeAt); // unchanged - restarting it would fly the ball a second time

    tickPenalty(); // flight (relative to the ORIGINAL strikeAt) is already well past: resolves at once, not another wait
    expect(penaltyMatch()!.stage).toBe('result');
  });
});
