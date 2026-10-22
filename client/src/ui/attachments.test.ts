import { describe, expect, it } from 'vitest';
import { encodeAttempts, resizeDims } from './attachments';

describe('resizeDims', () => {
  it('leaves an image already within the edge alone', () => {
    expect(resizeDims(1200, 800)).toEqual({ width: 1200, height: 800 });
  });

  it('scales the long edge down to the cap, keeping the aspect ratio', () => {
    expect(resizeDims(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(resizeDims(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it('never upscales', () => {
    expect(resizeDims(100, 50, 2000)).toEqual({ width: 100, height: 50 });
  });
});

describe('encodeAttempts', () => {
  it('tries PNG first for a PNG source, then JPEG stepping down', () => {
    const steps = encodeAttempts(true);
    expect(steps[0]).toEqual({ mime: 'image/png', scale: 1 });
    expect(steps.slice(1).every((s) => s.mime === 'image/jpeg')).toBe(true);
    const qualities = steps.slice(1).map((s) => s.quality);
    expect(qualities).toEqual([...qualities].sort((a, b) => (b ?? 0) - (a ?? 0)));
  });

  it('goes straight to JPEG for a non-PNG source, then shrinks as a last resort', () => {
    const steps = encodeAttempts(false);
    expect(steps.every((s) => s.mime === 'image/jpeg')).toBe(true);
    expect(steps.at(-1)!.scale).toBeLessThan(1);
  });
});
