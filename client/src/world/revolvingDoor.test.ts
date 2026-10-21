import { describe, expect, it } from 'vitest';
import { COAST_S, createRevolvingDoor, DRUM_RADIUS, drumColliders, PASSAGE, STOPPED, tickRevolvingDoor, WINGS } from './revolvingDoor.ts';

describe('tickRevolvingDoor', () => {
  it('turns faster the faster the player walks it, and not at all when they stand still', () => {
    const stopped = tickRevolvingDoor(createRevolvingDoor(), 0, 1);
    expect(stopped.speed).toBe(0);

    const walking = tickRevolvingDoor(createRevolvingDoor(), 3.6, 1);
    expect(walking.speed).toBeGreaterThan(0);

    const running = tickRevolvingDoor(createRevolvingDoor(), 6.5, 1);
    expect(running.speed).toBeGreaterThan(walking.speed);
  });

  it('turns the wings over time, proportionally to their speed', () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 3.6, 0.5);
    expect(d.angle).toBeCloseTo(d.speed * 0.5);
    expect(d.angle).toBeGreaterThan(0);
  });

  it('coasts to a stop once nobody is walking it', () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 6.5, 1); // get it spinning
    expect(d.speed).toBeGreaterThan(0);
    const spinning = d.speed;
    // nobody's in it any more
    for (let i = 0; i < 400; i++) tickRevolvingDoor(d, 0, COAST_S / 10);
    expect(d.speed).toBeLessThanOrEqual(STOPPED);
    expect(d.speed).toBeLessThan(spinning);
  });

  it('follows a rising speed at once, so the wings never lag behind', () => {
    const d = createRevolvingDoor();
    tickRevolvingDoor(d, 3.6, 1);
    const slower = d.speed;
    tickRevolvingDoor(d, 6.5, 1e-6); // the next instant, running flat out
    expect(d.speed).toBeGreaterThan(slower);
  });
});

describe('drumColliders', () => {
  it('leaves the walked-through middle open and solid only on the drum sides', () => {
    const rects = drumColliders(10, 5, -1);
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.maxX - r.minX).toBeCloseTo(DRUM_RADIUS * 2);
      expect(r.minX).toBeLessThanOrEqual(10);
      expect(r.maxX).toBeLessThanOrEqual(10);
    }
    // nothing solid across the passage itself
    const passage = { minZ: 5 - PASSAGE / 2, maxZ: 5 + PASSAGE / 2 };
    for (const r of rects) expect(r.minZ < passage.maxZ && r.maxZ > passage.minZ).toBe(false);
  });

  it('sits on the wall face given, opening into the building on the other axis', () => {
    const west = drumColliders(-16, 4.5, -1);
    const east = drumColliders(16, 4.5, 1);
    for (const r of west) expect(r.maxX).toBeLessThanOrEqual(-16);
    for (const r of east) expect(r.minX).toBeGreaterThanOrEqual(16);
  });

  it('has WINGS wings turning around the post, well inside the drum', () => {
    expect(WINGS).toBeGreaterThanOrEqual(3);
    expect(PASSAGE).toBeLessThan(DRUM_RADIUS * 2);
  });
});
