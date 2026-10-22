import { describe, expect, it } from 'vitest';
import { flightMsOf, GOAL, kickOutcome, kmhOf, parsePenaltyMessage, parsePenaltyResult, recordShootout, shootoutState, visitorId, type Kick, type PenaltyBoard } from './penalty.ts';

describe('kickOutcome', () => {
  it('is a goal when the keeper never gets close', () => {
    const out = kickOutcome({ x: 2, y: 1, power: 0.5 }, { x: -2, y: 1, at: -200 });
    expect(out.result).toBe('goal');
  });

  it('is saved when the keeper dives there in time', () => {
    const out = kickOutcome({ x: 1, y: 1, power: 0.3 }, { x: 1, y: 1, at: -400 }); // slow shot, an early dive: well inside
    expect(out.result).toBe('saved');
  });

  it('is a post when the shot grazes the frame, even on target', () => {
    const out = kickOutcome({ x: GOAL.width / 2 - 0.05, y: 1, power: 0.5 }, null);
    expect(out.result).toBe('post');
  });

  it('is wide past the posts, clear of the frame', () => {
    const out = kickOutcome({ x: GOAL.width / 2 + 1, y: 1, power: 0.5 }, null);
    expect(out.result).toBe('wide');
  });

  it('is over the bar, clear of the frame', () => {
    const out = kickOutcome({ x: 0, y: GOAL.height + 1, power: 0.5 }, null);
    expect(out.result).toBe('over');
  });

  it('a shot at 130 km/h arrives too fast to react to: under 500 ms', () => {
    const out = kickOutcome({ x: 1, y: 1, power: 1 }, null);
    expect(kmhOf(1)).toBeCloseTo(130);
    expect(out.flightMs).toBeLessThan(500);
  });

  it('a shot at 60 km/h gives more than 500 ms, time to react', () => {
    const kmh = 60;
    expect(flightMsOf(kmh)).toBeGreaterThan(500);
  });

  it('a stationary keeper (no dive) never reaches a shot placed away from the centre', () => {
    const out = kickOutcome({ x: 3, y: 0.3, power: 0.6 }, null);
    expect(out.result).toBe('goal');
  });
});

describe('shootoutState', () => {
  const p = (scored: boolean): Kick => ({ side: 'player', scored });
  const o = (scored: boolean): Kick => ({ side: 'opponent', scored });

  it('ends early once a side can no longer catch up', () => {
    // player misses twice, opponent scores twice: with one kick left each, the opponent can't be caught
    const kicks: Kick[] = [p(false), o(true), p(false), o(true)];
    expect(shootoutState(kicks)).toEqual({ next: null, winner: 'opponent' });
  });

  it('keeps going while either side could still catch up', () => {
    const kicks: Kick[] = [p(true), o(false)];
    const state = shootoutState(kicks);
    expect(state.winner).toBeNull();
    expect(state.next).toBe('player');
  });

  it('level after 3 each goes to sudden death: not decided until both have kicked', () => {
    const kicks: Kick[] = [p(true), o(true), p(false), o(false), p(true), o(true)];
    expect(shootoutState(kicks)).toEqual({ next: 'player', winner: null }); // 3-3, into sudden death
    const roundOne: Kick[] = [...kicks, p(true)];
    expect(shootoutState(roundOne)).toEqual({ next: 'opponent', winner: null }); // player's sudden-death kick alone decides nothing yet
  });

  it('sudden death ends the instant one round is not both scored or both missed', () => {
    const level: Kick[] = [p(true), o(true), p(false), o(false), p(true), o(true)];
    const decided: Kick[] = [...level, p(true), o(false)];
    expect(shootoutState(decided)).toEqual({ next: null, winner: 'player' });
  });

  it('sudden death carries on when a round is level too', () => {
    const level: Kick[] = [p(true), o(true), p(false), o(false), p(true), o(true)];
    const stillLevel: Kick[] = [...level, p(true), o(true)];
    expect(shootoutState(stillLevel)).toEqual({ next: 'player', winner: null });
  });

  it('player kicks first', () => {
    expect(shootoutState([])).toEqual({ next: 'player', winner: null });
  });
});

describe('parsePenaltyResult', () => {
  const finished = [
    { side: 'player', scored: true, kmh: 90 },
    { side: 'opponent', scored: false, kmh: 70 },
    { side: 'player', scored: true, kmh: 95 },
    { side: 'opponent', scored: false, kmh: 65 },
  ];

  it('accepts a body matching a finished shoot-out', () => {
    const parsed = parsePenaltyResult({ opponentId: 'agent-1', winner: 'player', kicks: finished });
    expect(parsed).not.toHaveProperty('error');
  });

  it('rejects a missing or empty opponentId', () => {
    expect(parsePenaltyResult({ winner: 'player', kicks: finished })).toHaveProperty('error');
    expect(parsePenaltyResult({ opponentId: '', winner: 'player', kicks: finished })).toHaveProperty('error');
  });

  it('rejects a bad winner', () => {
    expect(parsePenaltyResult({ opponentId: 'agent-1', winner: 'nobody', kicks: finished })).toHaveProperty('error');
  });

  it('rejects malformed kicks', () => {
    expect(parsePenaltyResult({ opponentId: 'agent-1', winner: 'player', kicks: [{ side: 'player' }] })).toHaveProperty('error');
    expect(parsePenaltyResult({ opponentId: 'agent-1', winner: 'player', kicks: 'nope' })).toHaveProperty('error');
  });

  it('rejects a winner that these kicks did not actually produce', () => {
    expect(parsePenaltyResult({ opponentId: 'agent-1', winner: 'opponent', kicks: finished })).toHaveProperty('error');
  });
});

describe('recordShootout', () => {
  const empty: PenaltyBoard = { rows: [], hardest: null };

  it('adds both sides, tracks wins/losses/goals, and keeps the hardest goal', () => {
    const board = recordShootout(empty, {
      player: { name: 'Manager' },
      opponent: { id: 'agent-1', name: 'Rae' },
      winner: 'player',
      kicks: [
        { side: 'player', scored: true, kmh: 110 },
        { side: 'opponent', scored: false, kmh: 60 },
        { side: 'player', scored: true, kmh: 90 },
      ],
      at: 1000,
    });
    const player = board.rows.find((r) => r.id === 'player')!;
    const opp = board.rows.find((r) => r.id === 'agent-1')!;
    expect(player).toMatchObject({ wins: 1, losses: 0, goals: 2 });
    expect(opp).toMatchObject({ wins: 0, losses: 1, goals: 0 });
    expect(board.hardest).toMatchObject({ id: 'player', kmh: 110 });
  });

  it('keeps the fastest goal across matches, by anyone', () => {
    const once = recordShootout(empty, {
      player: { name: 'Manager' },
      opponent: { id: 'agent-1', name: 'Rae' },
      winner: 'opponent',
      kicks: [{ side: 'opponent', scored: true, kmh: 120 }],
      at: 1000,
    });
    const twice = recordShootout(once, {
      player: { name: 'Manager' },
      opponent: { id: 'agent-2', name: 'Kip' },
      winner: 'player',
      kicks: [{ side: 'player', scored: true, kmh: 80 }],
      at: 2000,
    });
    expect(twice.hardest).toMatchObject({ id: 'agent-1', kmh: 120 });
  });
});

describe('visitorId', () => {
  it("is 'player' for the manager, any case", () => {
    expect(visitorId('Jordan', 'jordan')).toBe('player');
    expect(visitorId('jordan', 'Jordan')).toBe('player');
  });

  it('is v: + the lower-cased name for anyone else', () => {
    expect(visitorId('Ada', 'Jordan')).toBe('v:ada');
  });
});

describe('parsePenaltyMessage', () => {
  it('parses each pk-* message, clamping shot/dive/shuffle coordinates', () => {
    expect(parsePenaltyMessage('{"type":"pk-join"}')).toEqual({ type: 'pk-join' });
    expect(parsePenaltyMessage('{"type":"pk-leave"}')).toEqual({ type: 'pk-leave' });
    expect(parsePenaltyMessage({ type: 'pk-shot', x: 1, y: 1, power: 0.5 })).toEqual({ type: 'pk-shot', x: 1, y: 1, power: 0.5 });
    expect(parsePenaltyMessage({ type: 'pk-shot', x: 1000, y: -1000, power: 5 })).toEqual({ type: 'pk-shot', x: GOAL.width / 2 + 2, y: -1, power: 1 });
    expect(parsePenaltyMessage({ type: 'pk-dive', x: 1, y: 1 })).toEqual({ type: 'pk-dive', x: 1, y: 1 });
    expect(parsePenaltyMessage({ type: 'pk-shuffle', x: 0.4 })).toEqual({ type: 'pk-shuffle', x: 0.4 });
  });

  it('rejects malformed, oversized or unknown messages', () => {
    expect(parsePenaltyMessage('not json')).toBeNull();
    expect(parsePenaltyMessage('x'.repeat(1025))).toBeNull();
    expect(parsePenaltyMessage({ type: 'pk-shot', x: 1, y: 1 })).toBeNull();
    expect(parsePenaltyMessage({ type: 'pk-dive', x: 'left', y: 1 })).toBeNull();
    expect(parsePenaltyMessage({ type: 'nope' })).toBeNull();
    expect(parsePenaltyMessage(null)).toBeNull();
  });
});
