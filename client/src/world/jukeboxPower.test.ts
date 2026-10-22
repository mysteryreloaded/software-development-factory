import { describe, expect, it } from 'vitest';
import { MAX_MUSIC_LEVEL } from '../ui/musicMix';
import { clampJukeboxLevel, louder, nextLevel, OFF_LEVEL, powerToggle, softer } from './jukeboxPower';

describe('jukeboxPower', () => {
  it('starts off', () => {
    expect(OFF_LEVEL).toBe(0);
  });

  it('+ turns it on from off, one step at a time', () => {
    expect(louder(0)).toBe(1);
    expect(louder(1)).toBe(2);
    expect(louder(MAX_MUSIC_LEVEL)).toBe(MAX_MUSIC_LEVEL); // never past the top
  });

  it('- turns it off from 1, and off stays off (no sound either way for the caller to decide)', () => {
    expect(softer(1)).toBe(0);
    expect(softer(4)).toBe(3);
    expect(softer(0)).toBe(0);
  });

  it('the power button: off → on at the last level, on → off', () => {
    expect(powerToggle(3, 5)).toBe(0);
    expect(powerToggle(0, 5)).toBe(5);
    expect(powerToggle(0, 3)).toBe(3); // the default last level
  });

  it('next (E): off → on at the last level; already on, the level is untouched', () => {
    expect(nextLevel(0, 5)).toBe(5);
    expect(nextLevel(3, 5)).toBe(3);
  });

  it('never leaves 0..MAX_MUSIC_LEVEL', () => {
    expect(clampJukeboxLevel(-5)).toBe(0);
    expect(clampJukeboxLevel(99)).toBe(MAX_MUSIC_LEVEL);
    expect(clampJukeboxLevel('not a number')).toBe(0);
    expect(clampJukeboxLevel(undefined)).toBe(0);
  });
});
