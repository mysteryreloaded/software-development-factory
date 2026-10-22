import { describe, expect, it } from 'vitest';
import { fitSize } from './signFit';

const measure = (text: string) => (size: number) => text.length * size * 0.55;

describe('fitSize', () => {
  it('keeps the starting size when the text already fits', () => {
    expect(fitSize(measure('short-name'), 74, 1000)).toBe(74);
  });

  it('shrinks to the largest size that fits a long name', () => {
    const text = 'a'.repeat(40);
    const size = fitSize(measure(text), 74, 500);
    expect(measure(text)(size)).toBeLessThanOrEqual(500);
    expect(measure(text)(size + 2)).toBeGreaterThan(500);
  });

  it('stops at the floor for an absurdly long name', () => {
    const text = 'a'.repeat(400);
    expect(fitSize(measure(text), 74, 500)).toBe(20);
  });

  it('never returns a size larger than the one it started with', () => {
    expect(fitSize(measure('x'), 74, 1000000)).toBeLessThanOrEqual(74);
    expect(fitSize(measure('x'.repeat(1000)), 74, 1)).toBeLessThanOrEqual(74);
  });
});
