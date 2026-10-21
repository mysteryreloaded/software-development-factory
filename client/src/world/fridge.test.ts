import { describe, expect, it } from 'vitest';
import { PUDDLE, RESTOCK, SNACKS, addPuddle, dryPuddles, fullShelf, meltCountdown, meltStage, nextRestockIn, putBack, restock, takeSnack } from './fridge';

describe('taking a snack', () => {
  it('takes one off the shelf and starts its restock clock', () => {
    const shelf = fullShelf();
    const r = takeSnack(shelf, 'bar', 0);
    expect(r.ok).toBe(true);
    expect(r.shelf.bar).toEqual({ n: SNACKS.bar.stock - 1, lowSince: 0 });
    expect(r.waitS).toBe(0);
  });

  it('refuses an empty shelf and says how long until one more', () => {
    let shelf = fullShelf();
    for (let i = 0; i < SNACKS.candy.stock; i++) shelf = takeSnack(shelf, 'candy', 0).shelf;
    const r = takeSnack(shelf, 'candy', 42);
    expect(r.ok).toBe(false);
    expect(r.waitS).toBeCloseTo(RESTOCK - 42);
    expect(r.shelf.candy.n).toBe(0);
  });

  it('restocks from when it first ran low, not from the latest take', () => {
    let shelf = fullShelf();
    shelf = takeSnack(shelf, 'bar', 0).shelf; // lowSince = 0
    shelf = takeSnack(shelf, 'bar', 5).shelf; // still lowSince = 0
    const r = takeSnack(shelf, 'bar', RESTOCK + 5); // one restocked by now
    expect(r.ok).toBe(true);
    expect(r.shelf.bar.n).toBe(SNACKS.bar.stock - 2); // started at full-2, +1 restock, -1 taken
  });
});

describe('restocking', () => {
  it('adds one every RESTOCK seconds until full, then stops tracking it', () => {
    let shelf = takeSnack(fullShelf(), 'water', 0).shelf;
    shelf = restock(shelf, RESTOCK - 1);
    expect(shelf.water.n).toBe(SNACKS.water.stock - 1);
    shelf = restock(shelf, RESTOCK);
    expect(shelf.water.n).toBe(SNACKS.water.stock);
    expect(shelf.water.lowSince).toBeNull();
  });

  it('never restocks past the full stock, however long it waits', () => {
    const shelf = takeSnack(fullShelf(), 'icecream', 0).shelf;
    const r = restock(shelf, RESTOCK * 50);
    expect(r.icecream.n).toBe(SNACKS.icecream.stock);
  });

  it("nextRestockIn is 0 for a full shelf", () => {
    expect(nextRestockIn(fullShelf(), 'bar', 0)).toBe(0);
  });
});

describe('putting a snack back', () => {
  it('adds one back, capped at full', () => {
    const shelf = takeSnack(fullShelf(), 'bar', 0).shelf;
    const back = putBack(shelf, 'bar', 1);
    expect(back.bar).toEqual({ n: SNACKS.bar.stock, lowSince: null });
  });

  it('does nothing to an already-full shelf', () => {
    const shelf = fullShelf();
    expect(putBack(shelf, 'water', 0)).toEqual(shelf);
  });

  it('keeps the restock clock running when the shelf is still short', () => {
    let shelf = fullShelf();
    shelf = takeSnack(shelf, 'candy', 0).shelf;
    shelf = takeSnack(shelf, 'candy', 1).shelf;
    const back = putBack(shelf, 'candy', 2);
    expect(back.candy.n).toBe(SNACKS.candy.stock - 1);
    expect(back.candy.lowSince).not.toBeNull();
  });
});

describe('melt stages', () => {
  it('is fresh, then soft, then a puddle', () => {
    expect(meltStage(0, 0)).toBe('fresh');
    expect(meltStage(0, 19.9)).toBe('fresh');
    expect(meltStage(0, 20)).toBe('soft');
    expect(meltStage(0, 59.9)).toBe('soft');
    expect(meltStage(0, 60)).toBe('puddle');
    expect(meltStage(0, 1000)).toBe('puddle');
  });

  it('counts down to the puddle, from whenever it left the freezer', () => {
    expect(meltCountdown(10, 10)).toBe(60);
    expect(meltCountdown(10, 40)).toBe(30);
    expect(meltCountdown(10, 70)).toBe(0);
  });
});

describe('puddles', () => {
  it('caps at PUDDLE.cap, dropping the oldest first', () => {
    let puddles: { id: string; x: number; z: number; bornAt: number }[] = [];
    for (let i = 0; i < PUDDLE.cap + 3; i++) puddles = addPuddle(puddles, { id: `p${i}`, x: 0, z: 0, bornAt: i });
    expect(puddles).toHaveLength(PUDDLE.cap);
    expect(puddles[0].id).toBe(`p${3}`);
    expect(puddles.at(-1)!.id).toBe(`p${PUDDLE.cap + 2}`);
  });

  it('dries up after its life is over', () => {
    const puddles = [{ id: 'a', x: 0, z: 0, bornAt: 0 }];
    expect(dryPuddles(puddles, PUDDLE.life - 1)).toHaveLength(1);
    expect(dryPuddles(puddles, PUDDLE.life)).toHaveLength(0);
  });
});
