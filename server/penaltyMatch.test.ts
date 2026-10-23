import { describe, expect, it } from 'vitest';
import { GOAL } from '../shared/penalty.ts';
import { PenaltyMatch, RESOLVE_GRACE_MS, SHOT_TIMEOUT_MS } from './penaltyMatch.ts';

const A = { id: 'a', name: 'Ada' };
const B = { id: 'b', name: 'Bo' };

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('join and take-over', () => {
  it('the first joiner waits, the second starts the match live', () => {
    const m = new PenaltyMatch();
    expect(m.view.phase).toBe('empty');
    expect(m.join(A)).toBe(true);
    expect(m.view).toMatchObject({ phase: 'waiting', players: [{ id: 'a', side: 'player' }] });
    expect(m.join(B)).toBe(true);
    expect(m.view).toMatchObject({ phase: 'live', turn: 'player', players: [{ id: 'a', side: 'player' }, { id: 'b', side: 'opponent' }] });
  });

  it('the same peer joining twice, or a third peer once live, is rejected', () => {
    const m = new PenaltyMatch();
    m.join(A);
    expect(m.join(A)).toBe(false);
    m.join(B);
    expect(m.join({ id: 'c', name: 'Cy' })).toBe(false);
  });
});

describe('alternating kicks', () => {
  it('turn flips after each resolved kick', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    expect(m.view.turn).toBe('player');
    expect(m.shot('a', { x: 0, y: 10, power: 0.5 })).toBe(true); // well over the bar: a clean miss
    c.advance(10_000);
    const resolved = m.tick();
    expect(resolved?.result).toBe('over');
    expect(m.view).toMatchObject({ turn: 'opponent', kicks: [{ side: 'player', scored: false }] });
    expect(m.shot('b', { x: 0, y: 10, power: 0.5 })).toBe(true);
    c.advance(10_000);
    m.tick();
    expect(m.view.turn).toBe('player');
  });

  it('only the shooter on turn may strike', () => {
    const m = new PenaltyMatch();
    m.join(A);
    m.join(B);
    expect(m.shot('b', { x: 0, y: 1, power: 0.5 })).toBe(false);
    expect(m.shot('a', { x: 0, y: 1, power: 0.5 })).toBe(true);
    expect(m.shot('a', { x: 0, y: 1, power: 0.9 })).toBe(false); // once per kick
  });
});

describe('the 15 s shot clock', () => {
  it('times out an unstruck kick as a miss', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    c.advance(SHOT_TIMEOUT_MS - 1);
    expect(m.tick()).toBeNull();
    c.advance(1);
    const resolved = m.tick();
    expect(resolved).toMatchObject({ result: 'wide', kmh: 0 });
    expect(m.view.kicks).toEqual([{ side: 'player', scored: false, kmh: 0 }]);
  });
});

describe('dive timing', () => {
  it('an early guess saves a hard shot', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    expect(m.dive('b', { x: 2, y: 1 })).toBe(true); // the keeper guesses well before the strike
    c.advance(300);
    expect(m.shot('a', { x: 2, y: 1, power: 1 })).toBe(true); // a hard shot, same spot as the dive
    c.advance(10_000); // plenty of time for the keeper to have arrived
    const resolved = m.tick();
    expect(resolved?.result).toBe('saved');
  });

  it('a late dive misses a shot the keeper never reaches in time', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    expect(m.shot('a', { x: 2, y: 1, power: 0.3 })).toBe(true); // a slow shot...
    c.advance(5000); // ...but the keeper dives long after it would have already arrived
    expect(m.dive('b', { x: 2, y: 1 })).toBe(true);
    c.advance(10_000);
    const resolved = m.tick();
    expect(resolved?.result).toBe('goal');
  });

  it('a second dive is ignored', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    expect(m.dive('b', { x: 2, y: 1 })).toBe(true);
    expect(m.dive('b', { x: -2, y: 1 })).toBe(false);
    c.advance(100);
    expect(m.shot('a', { x: -2, y: 1, power: 1 })).toBe(true); // aimed where the (ignored) second dive would be
    c.advance(10_000);
    expect(m.tick()?.result).toBe('goal'); // the keeper really dove right (first dive), so left is unguarded
  });
});

describe('resolve', () => {
  it('does nothing before the flight (plus grace) has passed', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    m.shot('a', { x: 0, y: 1, power: 0.5 });
    expect(m.tick()).toBeNull();
    c.advance(RESOLVE_GRACE_MS);
    expect(m.tick()).toBeNull(); // the shot itself still takes some flight time on top of the grace
  });

  it('a post counts as a miss even though it was on target', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    m.shot('a', { x: GOAL.width / 2 - 0.05, y: 1, power: 0.5 });
    c.advance(10_000);
    expect(m.tick()?.result).toBe('post');
    expect(m.view.kicks[0].scored).toBe(false);
  });
});

describe('a finished match', () => {
  it('produces a result once a side can no longer catch up', () => {
    const c = clock();
    const m = new PenaltyMatch(c.now);
    m.join(A);
    m.join(B);
    // player scores, opponent always goes over the bar: decided 1-0 after 3 each (no way back once short-handed)
    for (let i = 0; i < 6; i++) {
      const turn = m.view.turn!;
      const shot = turn === 'player' ? { x: 2, y: 1, power: 1 } : { x: 0, y: 10, power: 0.5 };
      m.shot(turn === 'player' ? 'a' : 'b', shot);
      c.advance(10_000);
      m.tick();
      if (m.view.phase === 'done') break;
    }
    expect(m.view.phase).toBe('done');
    const result = m.result();
    expect(result?.winner).toBe('player');
    expect(result?.player).toEqual(A);
    expect(result?.opponent).toEqual(B);
    expect(result?.kicks.length).toBeGreaterThan(0);
    m.clearDone();
    expect(m.view.phase).toBe('empty');
  });
});

describe('forfeit', () => {
  it('ends the match with no result when either side is gone', () => {
    const m = new PenaltyMatch();
    m.join(A);
    m.join(B);
    m.shot('a', { x: 0, y: 1, power: 0.9 });
    expect(m.forfeit('b')).toBe(true);
    expect(m.view).toMatchObject({ phase: 'empty', players: [], kicks: [] });
    expect(m.result()).toBeNull();
  });

  it('is a no-op for someone not in the match', () => {
    const m = new PenaltyMatch();
    m.join(A);
    expect(m.forfeit('nobody')).toBe(false);
    expect(m.view.phase).toBe('waiting');
  });
});
