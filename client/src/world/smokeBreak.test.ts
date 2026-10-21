import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS, collide } from './layout';
import {
  GO_OUT_MS,
  LIGHT_MS,
  MAX_BUTTS,
  NOOKS,
  PUFFS,
  PUFF_MS,
  ROLL_MS,
  addButt,
  inGap,
  newSmoke,
  pressE,
  standUpSmoke,
  tickSmoke,
} from './smokeBreak';

const run = (ms: number, now: number) => {
  let t = now;
  let s = newSmoke(t);
  s = pressE(s, t); // rolling
  t += ms ?? ROLL_MS;
  return { s, t };
};

describe('smokeBreak stage machine', () => {
  it('goes roll -> ready -> light -> lit -> puff..puff, in order', () => {
    let t = 0;
    let s = newSmoke(t);
    expect(s.stage).toBe('empty');
    s = pressE(s, t);
    expect(s.stage).toBe('rolling');
    t += ROLL_MS;
    s = tickSmoke(s, t).state;
    expect(s.stage).toBe('ready');
    s = pressE(s, t);
    expect(s.stage).toBe('lighting');
    t += LIGHT_MS;
    s = tickSmoke(s, t).state;
    expect(s.stage).toBe('lit');
    expect(s.puffsLeft).toBe(PUFFS);
    s = pressE(s, t);
    expect(s.stage).toBe('puffing');
  });

  it('a stray E mid-animation does nothing', () => {
    let t = 0;
    let s = pressE(newSmoke(t), t); // rolling
    const before = s;
    s = pressE(s, t + 1000); // still rolling
    expect(s).toEqual(before);
  });

  it('takes 8 puffs, then the butt goes into the ashtray and it resets to empty', () => {
    let t = 0;
    let s = newSmoke(t);
    s = pressE(s, t);
    t += ROLL_MS;
    s = tickSmoke(s, t).state; // ready
    s = pressE(s, t);
    t += LIGHT_MS;
    s = tickSmoke(s, t).state; // lit
    let butts = 0;
    for (let i = PUFFS; i > 0; i--) {
      expect(s.stage).toBe('lit');
      expect(s.puffsLeft).toBe(i);
      s = pressE(s, t);
      expect(s.stage).toBe('puffing');
      t += PUFF_MS;
      const r = tickSmoke(s, t);
      s = r.state;
      if (r.butt) butts++;
    }
    expect(butts).toBe(1);
    expect(s.stage).toBe('empty');
    expect(s.puffsLeft).toBe(PUFFS);
  });

  it('goes out after 90 s without a puff, and lighting it again works', () => {
    let t = 0;
    let s = newSmoke(t);
    s = pressE(s, t);
    t += ROLL_MS;
    s = tickSmoke(s, t).state; // ready
    s = pressE(s, t);
    t += LIGHT_MS;
    s = tickSmoke(s, t).state; // lit
    t += GO_OUT_MS;
    s = tickSmoke(s, t).state;
    expect(s.stage).toBe('out');
    s = pressE(s, t);
    expect(s.stage).toBe('lighting');
  });

  it('stays lit short of 90 s', () => {
    let t = 0;
    let s = newSmoke(t);
    s = pressE(s, t);
    t += ROLL_MS;
    s = tickSmoke(s, t).state;
    s = pressE(s, t);
    t += LIGHT_MS;
    s = tickSmoke(s, t).state;
    t += GO_OUT_MS - 1;
    s = tickSmoke(s, t).state;
    expect(s.stage).toBe('lit');
  });

  it('stubs an unfinished one into the ashtray on standing up, but not an empty one', () => {
    expect(standUpSmoke(newSmoke(0)).butt).toBe(false);
    const { s } = run(ROLL_MS, 0);
    expect(standUpSmoke(s).butt).toBe(true);
  });

  it('caps the ashtray at MAX_BUTTS', () => {
    let n = 0;
    for (let i = 0; i < MAX_BUTTS + 10; i++) n = addButt(n);
    expect(n).toBe(MAX_BUTTS);
  });
});

describe('smokeBreak nooks', () => {
  it('has a nook for both office balconies and the roof', () => {
    expect(NOOKS.map((n) => n.id).sort()).toEqual(['office-west', 'office-east', 'roof'].sort());
  });

  it("every nook's gap is wide enough to pass both ways, and collide() walks the table's whole length", () => {
    for (const n of NOOKS) {
      const width = n.gap.maxX - n.gap.minX;
      expect(width, n.id).toBeGreaterThanOrEqual(2 * PLAYER_RADIUS + 0.1 - 1e-9);
      const gapX = (n.gap.minX + n.gap.maxX) / 2;
      const rects = [n.bench, n.table];
      for (let z = n.table.minZ + 0.05; z <= n.table.maxZ - 0.05; z += 0.1) {
        const out = collide(gapX, z, rects);
        expect(out.x, `${n.id} z=${z}`).toBeCloseTo(gapX);
        expect(out.z, `${n.id} z=${z}`).toBeCloseTo(z);
      }
    }
  });

  it('seats sit within the gap, centred on the bench, 0.9 m apart', () => {
    for (const n of NOOKS) {
      for (const seat of n.seats) {
        expect(inGap(n, seat.x, seat.z), n.id).toBe(true);
      }
      expect(Math.abs(n.seats[1].z - n.seats[0].z)).toBeCloseTo(0.9);
    }
  });

  it('inGap is true only between the bench and the table', () => {
    const n = NOOKS[0];
    const midX = (n.gap.minX + n.gap.maxX) / 2;
    const midZ = (n.gap.minZ + n.gap.maxZ) / 2;
    expect(inGap(n, midX, midZ)).toBe(true);
    expect(inGap(n, midX, n.gap.maxZ + 5)).toBe(false);
    expect(inGap(n, n.table.maxX + 2, midZ)).toBe(false);
  });

  it("no nook's bench or table overlaps another nook's", () => {
    const overlaps = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: typeof a) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
    for (let i = 0; i < NOOKS.length; i++) {
      for (let j = i + 1; j < NOOKS.length; j++) {
        expect(overlaps(NOOKS[i].bench, NOOKS[j].bench)).toBe(false);
        expect(overlaps(NOOKS[i].table, NOOKS[j].table)).toBe(false);
      }
    }
  });
});
