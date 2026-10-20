import { describe, expect, it } from 'vitest';
import { enterSends } from './MessageBox';

describe('enterSends', () => {
  it('sends on a plain Enter on desktop', () => {
    expect(enterSends({ touch: false, shiftKey: false, isComposing: false })).toBe(true);
  });

  it('adds a line on touch devices, even without Shift', () => {
    expect(enterSends({ touch: true, shiftKey: false, isComposing: false })).toBe(false);
  });

  it('adds a line on Shift+Enter on desktop', () => {
    expect(enterSends({ touch: false, shiftKey: true, isComposing: false })).toBe(false);
  });

  it('never sends while an IME composition is active', () => {
    expect(enterSends({ touch: false, shiftKey: false, isComposing: true })).toBe(false);
  });
});
