import { MAX_MUSIC_LEVEL } from '../ui/musicMix';

// The jukebox's own power state, layered over the music level (musicMix.ts): 0 is off (silent, still, unlit), 1 to
// MAX_MUSIC_LEVEL is on at that volume. Pure so these transitions are unit tested without WebAudio or three.js.

export const OFF_LEVEL = 0;

/** Any value as a jukebox level, 0 (off) to MAX_MUSIC_LEVEL (the invalid default). */
export function clampJukeboxLevel(n: unknown): number {
  const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
  return Number.isFinite(v) ? Math.max(OFF_LEVEL, Math.min(MAX_MUSIC_LEVEL, Math.round(v))) : OFF_LEVEL;
}

/** + or wheel up: one step louder; from off, that's on at 1. */
export const louder = (level: number) => clampJukeboxLevel(level + 1);

/** - or wheel down: one step softer; from 1 that's off, and off stays off (no sound). */
export const softer = (level: number) => (level <= OFF_LEVEL ? OFF_LEVEL : clampJukeboxLevel(level - 1));

/** The power button: on → off, off → the last level it played at (musicMix's own default, 3, when there's none). */
export const powerToggle = (level: number, lastLevel: number) => (level > OFF_LEVEL ? OFF_LEVEL : clampJukeboxLevel(lastLevel));

/** E (next song): already on, the level is untouched; off, it switches on at the last level. */
export const nextLevel = (level: number, lastLevel: number) => (level > OFF_LEVEL ? level : clampJukeboxLevel(lastLevel));
