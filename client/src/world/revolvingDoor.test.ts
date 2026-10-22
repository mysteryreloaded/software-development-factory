import { describe, expect, it } from 'vitest';
import { COAST_S, createRevolvingDoor, DRUM_RADIUS, drumColliders, STOPPED, tickRevolvingDoor, wingAngle, WINGS } from './revolvingDoor.ts';

describe('tickRevolvingDoor', () => {
  it('turns faster the faster the player walks it, and not at all when they stand still', () => {
    const stopped = tickRevolvingDoor(createRevolvingDoor(), 0, true, 1);
    expect(stopped.speed).toBe(0);

    const walking = tickRevolvingDoor(createRevolvingDoor(), 3.6, true, 1);
    expect(walking.speed).toBeGreaterThan(0);

    const running = tickRevolvingDoor(createRevolvingDoor(), 6.5, true, 1);
    expect(running.speed).toBeGreaterThan(walking.speed);
  });

  it("ignores the player's speed once they're outside the drum circle", () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 6.5, false, 1);
    expect(d.angle).toBeCloseTo(0);
    expect(d.speed).toBe(0);
  });

  it('turns the wings over time, proportionally to their speed', () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 3.6, true, 0.5);
    expect(d.angle).toBeCloseTo(d.speed * 0.5);
    expect(d.angle).toBeGreaterThan(0);
  });

  it('follows a rising and a falling speed at once while inside, so the wings never lag behind', () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 3.6, true, 1);
    const walking = d.speed;
    tickRevolvingDoor(d, 6.5, true, 1e-6); // the next instant, running flat out
    expect(d.speed).toBeGreaterThan(walking);
    tickRevolvingDoor(d, 0, true, 1e-6); // and stopping dead, still inside: no coast while you're in it
    expect(d.speed).toBe(0);
  });

  it("coasts to a stop once you've left, and rests exactly on the next quarter turn", () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 6.5, true, 1); // get it spinning, still inside
    expect(d.speed).toBeGreaterThan(0);
    const spinning = d.speed;
    const spunTo = d.angle;
    // nobody's driving it any more
    tickRevolvingDoor(d, 6.5, false, 0.001); // speed is ignored now that we're outside
    expect(d.speed).toBeLessThan(spinning);
    expect(d.angle).toBeGreaterThan(spunTo); // still easing forward towards the next quarter, not snapped back
    for (let i = 0; i < 2000; i++) tickRevolvingDoor(d, 0, false, COAST_S / 20);
    expect(d.speed).toBeLessThanOrEqual(STOPPED);
    expect(d.angle % (Math.PI / 2)).toBeCloseTo(0, 3);
  });

  it("keeps a walk and a run crossing the drum's circle at rest clear of every wing by at least 20°, except right by the post, and rests on a quarter (#41 round 3)", () => {
    const MARGIN = Math.PI / 9; // 20°
    const NEAR_POST = 0.2;
    const dt = 1 / 60;
    const TAU = Math.PI * 2;
    // the smallest turn from a to b, in [0, π]
    const angleBetween = (a: number, b: number) => {
      const d = ((a - b) % TAU + TAU + Math.PI) % TAU;
      return Math.abs(d - Math.PI);
    };

    const minClearance = (speed: number) => {
      const d = createRevolvingDoor();
      let x = -DRUM_RADIUS;
      let worst = Math.PI;
      while (x < DRUM_RADIUS) {
        const inside = x * x <= DRUM_RADIUS * DRUM_RADIUS;
        tickRevolvingDoor(d, inside ? speed : 0, inside, dt);
        x += speed * dt;
        if (Math.abs(x) < NEAR_POST) continue;
        const bearing = Math.atan2(x, 0); // the player's own bearing from the post: ±π/2, east or west
        for (let i = 0; i < WINGS; i++) worst = Math.min(worst, angleBetween(wingAngle(d, i), bearing));
      }
      // coast the rest of the way: it should settle on a quarter turn, not wherever the crossing left it
      for (let i = 0; i < 2000; i++) tickRevolvingDoor(d, 0, false, COAST_S / 20);
      expect(d.angle % (Math.PI / 2)).toBeCloseTo(0, 3);
      return worst;
    };

    expect(minClearance(3.6)).toBeGreaterThanOrEqual(MARGIN); // walking
    expect(minClearance(6.5)).toBeGreaterThanOrEqual(MARGIN); // running
  });
});

describe('drumColliders', () => {
  it('leaves the walked-through middle (east and west) open and solid only on the north and south arcs', () => {
    const rects = drumColliders(10, 5);
    expect(rects).toHaveLength(2);
    const [north, south] = rects;
    // both centred on the post, not stuck out to one side
    for (const r of rects) {
      expect(r.minX).toBeGreaterThan(10 - DRUM_RADIUS);
      expect(r.maxX).toBeLessThan(10 + DRUM_RADIUS);
      expect(10 - r.minX).toBeCloseTo(r.maxX - 10, 5); // same distance from the post on each side
    }
    // north sits above the post's z (recall -Z is north), south below
    expect(north.maxZ).toBeLessThanOrEqual(5);
    expect(south.minZ).toBeGreaterThanOrEqual(5);
    // nothing solid along the east/west walking axis, at the post's own z
    for (const r of rects) expect(r.minZ < 5 && r.maxZ > 5).toBe(false);
    // and nothing solid within the drum nearer the post than either arc's inner edge
    for (const r of rects) expect(Math.min(Math.abs(r.minZ - 5), Math.abs(r.maxZ - 5))).toBeGreaterThan(0);
  });

  it('bounds a quarter of the circle each, well inside the full drum', () => {
    const [north] = drumColliders(0, 0);
    // a quarter-circle arc's bounding box is DRUM_RADIUS * cos(45°) wide each way, and spans the outer DRUM_RADIUS
    // * (1 - cos(45°)) in depth
    const half = DRUM_RADIUS * Math.SQRT1_2;
    expect(north.maxX - north.minX).toBeCloseTo(half * 2);
    expect(north.minZ).toBeCloseTo(-DRUM_RADIUS);
    expect(north.maxZ).toBeCloseTo(-half);
    expect(WINGS).toBeGreaterThanOrEqual(3);
  });
});
