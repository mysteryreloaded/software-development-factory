import { describe, expect, it } from 'vitest';
import { gesture, pinchDelta, stick, touchUi } from './touch';

describe('touchUi', () => {
  it('?touch=1 turns it on', () => {
    expect(touchUi({ param: '1', coarse: false })).toBe(true);
  });
  it('?touch=0 (or false) turns it off, even on a coarse pointer', () => {
    expect(touchUi({ param: '0', coarse: true })).toBe(false);
    expect(touchUi({ param: 'false', coarse: true })).toBe(false);
  });
  it('with no param, falls back to whether the pointer is coarse', () => {
    expect(touchUi({ param: null, coarse: true })).toBe(true);
    expect(touchUi({ param: null, coarse: false })).toBe(false);
  });
});

describe('stick', () => {
  it('is centred at the middle', () => {
    expect(stick(0, 0, 60)).toEqual({ x: 0, y: 0, run: false });
  });
  it('reads ≈1 and runs at the edge of the ring', () => {
    const s = stick(60, 0, 60);
    expect(s.x).toBeCloseTo(1);
    expect(s.y).toBeCloseTo(0);
    expect(s.run).toBe(true);
  });
  it('clamps beyond the ring', () => {
    const s = stick(180, 0, 60);
    expect(s.x).toBeCloseTo(1);
    expect(s.run).toBe(true);
  });
  it('ignores a small push inside the deadzone', () => {
    const s = stick(3, 0, 60);
    expect(s).toEqual({ x: 0, y: 0, run: false });
  });
  it('keeps y down-positive, like the pad', () => {
    const s = stick(0, 60, 60);
    expect(s.y).toBeCloseTo(1);
  });
  it('does not run for a moderate push', () => {
    const s = stick(30, 0, 60);
    expect(s.x).toBeCloseTo(0.5);
    expect(s.run).toBe(false);
  });
});

describe('gesture', () => {
  it('a short, still touch is a tap', () => {
    expect(gesture(2, 100)).toBe('tap');
  });
  it('right at the tap thresholds is still a tap', () => {
    expect(gesture(9, 349)).toBe('tap');
  });
  it('a still touch held past the long-press threshold is a long press', () => {
    expect(gesture(2, 500)).toBe('longPress');
  });
  it('a still touch in between (too long for a tap, not long enough to hold) is a drag', () => {
    expect(gesture(2, 400)).toBe('drag');
  });
  it('any real movement is a drag, however short', () => {
    expect(gesture(40, 50)).toBe('drag');
  });
});

describe('pinchDelta', () => {
  it('spreading fingers (zooming in) is negative', () => {
    expect(pinchDelta(100, 160)).toBeLessThan(0);
  });
  it('pinching together (zooming out) is positive', () => {
    expect(pinchDelta(160, 100)).toBeGreaterThan(0);
  });
  it('no change is zero', () => {
    expect(pinchDelta(100, 100)).toBe(0);
  });
});
