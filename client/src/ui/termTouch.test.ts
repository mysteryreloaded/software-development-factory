import { describe, expect, it } from 'vitest';
import { pastScrollThreshold, SCROLL_THRESHOLD_PX, touchScrollLines } from './termTouch';

describe('pastScrollThreshold', () => {
  it('is false right at the threshold, true just past it', () => {
    expect(pastScrollThreshold(0, SCROLL_THRESHOLD_PX)).toBe(false);
    expect(pastScrollThreshold(0, SCROLL_THRESHOLD_PX + 0.01)).toBe(true);
  });

  it('counts a diagonal move by its total distance', () => {
    expect(pastScrollThreshold(6, 6)).toBe(true); // hypot ≈ 8.49
    expect(pastScrollThreshold(1, 1)).toBe(false);
  });
});

describe('touchScrollLines', () => {
  it('turns a drag past one row into a line, carrying the remainder', () => {
    const a = touchScrollLines(25, 0, 20);
    expect(a).toEqual({ lines: 1, carryPx: 5 });
    const b = touchScrollLines(25, a.carryPx, 20);
    expect(b).toEqual({ lines: 1, carryPx: 10 });
  });

  it('accumulates small drags below one row until they cross it', () => {
    const a = touchScrollLines(6, 0, 20);
    expect(a).toEqual({ lines: 0, carryPx: 6 });
    const b = touchScrollLines(6, a.carryPx, 20);
    expect(b).toEqual({ lines: 0, carryPx: 12 });
    const c = touchScrollLines(6, b.carryPx, 20);
    expect(c).toEqual({ lines: 0, carryPx: 18 });
    const d = touchScrollLines(6, c.carryPx, 20);
    expect(d).toEqual({ lines: 1, carryPx: 4 });
  });

  it('scrolls the other way for an upward drag', () => {
    expect(touchScrollLines(-25, 0, 20)).toEqual({ lines: -1, carryPx: -5 });
  });

  it('does nothing with no usable line height', () => {
    expect(touchScrollLines(100, 0, 0)).toEqual({ lines: 0, carryPx: 0 });
    expect(touchScrollLines(100, 0, -5)).toEqual({ lines: 0, carryPx: 0 });
  });
});
