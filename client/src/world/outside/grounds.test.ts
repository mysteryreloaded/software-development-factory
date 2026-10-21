import { describe, expect, it } from 'vitest';
import { CITY, CORRIDOR_HALF, streetLines } from './cityLayout.ts';
import { bollardXs, bollardZs, GROUNDS, groundsColliders, HOME_PARK, isWalkable, parkFenceLines, PAVED_STREET, PLAZA, type Rect } from './grounds.ts';

describe('grounds', () => {
  it('matches the city block numbers from the issue', () => {
    expect(PLAZA).toEqual({ minX: -30, maxX: 30, minZ: -26, maxZ: 26 });
    expect(PAVED_STREET.minX).toBeCloseTo(-43);
    expect(PAVED_STREET.maxX).toBeCloseTo(-30);
    expect(HOME_PARK.minX).toBeCloseTo(-82);
    expect(HOME_PARK.maxX).toBeCloseTo(-43);
    expect(GROUNDS).toEqual({ minX: HOME_PARK.minX, maxX: PLAZA.maxX, minZ: PLAZA.minZ, maxZ: PLAZA.maxZ });
    // ties back to the real street grid, not just numbers copied from the issue
    const xs = streetLines(CITY.homeHalfX);
    const westLine = xs[xs.length / 2 - 1];
    expect(PAVED_STREET.minX).toBeCloseTo(westLine - CORRIDOR_HALF);
    expect(PAVED_STREET.maxX).toBeCloseTo(westLine + CORRIDOR_HALF);
  });

  it('is walkable across the plaza, the paved stretch and the park, and nowhere past them', () => {
    expect(isWalkable(0, 0)).toBe(true); // the plaza
    expect(isWalkable(-36.5, 10)).toBe(true); // the paved street
    expect(isWalkable(-60, -5)).toBe(true); // the park
    expect(isWalkable(GROUNDS.minX, 0)).toBe(true);
    expect(isWalkable(GROUNDS.maxX, 0)).toBe(true);
    expect(isWalkable(GROUNDS.minX - 1, 0)).toBe(false); // the street beyond the park
    expect(isWalkable(0, GROUNDS.maxZ + 1)).toBe(false); // the street north of the plaza
    expect(isWalkable(0, GROUNDS.minZ - 1)).toBe(false);
    expect(isWalkable(GROUNDS.maxX + 5, 0)).toBe(false); // the street east of our block
  });

  it('walls off every edge but the east one, which the existing patio rail already guards', () => {
    const walls = groundsColliders();
    expect(walls).toHaveLength(3);
    for (const w of walls) {
      // every wall sits right on the GROUNDS boundary, not out in the open or inside it
      const onEdge = [w.minX, w.maxX].includes(GROUNDS.minX) || [w.minX, w.maxX].includes(GROUNDS.maxX) || [w.minZ, w.maxZ].includes(GROUNDS.minZ) || [w.minZ, w.maxZ].includes(GROUNDS.maxZ);
      expect(onEdge).toBe(true);
    }
    // just the three: north, south and west. No dedicated east wall (the existing patio rail already guards it)
    const thinVertical = (w: Rect) => w.maxX - w.minX <= 0.5 && w.maxZ - w.minZ > 10;
    expect(walls.filter(thinVertical)).toHaveLength(1); // the west one only
  });

  it("fences the park's north, west and south edges, never its east one", () => {
    const fence = parkFenceLines();
    expect(fence).toHaveLength(3);
    expect(fence.some((f) => f.axis === 'z' && f.at === HOME_PARK.maxX)).toBe(false); // the east edge, into the street
    const west = fence.find((f) => f.axis === 'z')!;
    expect(west.at).toBe(HOME_PARK.minX);
    expect([west.from, west.to].sort((a, b) => a - b)).toEqual([HOME_PARK.minZ, HOME_PARK.maxZ]);
    for (const f of fence.filter((f) => f.axis === 'x')) {
      expect([f.at, f.at]).toEqual([f.at === HOME_PARK.minZ ? HOME_PARK.minZ : HOME_PARK.maxZ, f.at]);
      expect([f.from, f.to].sort((a, b) => a - b)).toEqual([HOME_PARK.minX, HOME_PARK.maxX]);
    }
  });

  it('bollards both ends of the paved stretch, not along its sides', () => {
    const xs = bollardXs();
    expect(xs.length).toBeGreaterThanOrEqual(3);
    for (const x of xs) expect(x).toBeGreaterThan(PAVED_STREET.minX), expect(x).toBeLessThan(PAVED_STREET.maxX);
    expect(bollardZs()).toEqual([PAVED_STREET.minZ, PAVED_STREET.maxZ]);
  });
});
