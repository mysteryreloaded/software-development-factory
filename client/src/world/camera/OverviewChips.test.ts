import { describe, expect, it, vi } from 'vitest';

// OverviewChips.tsx pulls in the store (sounds need a browser) and react-three-fiber just to reach drawChip.
vi.mock('../../ui/sfx', () => ({ audioUnlocked: () => false, chirp: vi.fn(), cue: vi.fn() }));
vi.mock('../gongRunner', () => ({ gongForMerge: vi.fn(() => 'solo') }));

const { chipFillStyle } = await import('./overviewInfo');
const { drawChip } = await import('./OverviewChips');

/** A stand-in 2D context: records every draw call and property set, in order, so a test can read the pill's fill,
 * the border/dot opacity and the text halo straight off the calls `drawChip` made. */
function mockCtx() {
  const calls: { op: string; args?: unknown[] }[] = [];
  const target: Record<string, unknown> = {
    canvas: { width: 320, height: 72 },
    measureText: (t: string) => ({ width: t.length * 10 }),
    roundRect: (...a: number[]) => calls.push({ op: 'roundRect', args: a }),
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => calls.push({ op: prop, args });
    },
    set(_, prop: string, v) {
      calls.push({ op: `set:${prop}`, args: [v] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('chipFillStyle', () => {
  it('is 80% transparent by default and solid under high contrast', () => {
    expect(chipFillStyle(false)).toBe('rgba(255,253,246,0.2)');
    expect(chipFillStyle(true)).toBe('rgba(255,253,246,1)');
  });
});

describe('drawChip', () => {
  it('fills the pill see-through, keeps the border/dot/text opaque, and halos the text', () => {
    const { ctx, calls } = mockCtx();
    drawChip(ctx, 'Ada', 'working', false);

    const fillOp = calls.findIndex((c) => c.op === 'fill');
    const fillColor = [...calls.slice(0, fillOp)].reverse().find((c) => c.op === 'set:fillStyle')!.args![0];
    expect(fillColor).toBe(chipFillStyle(false));

    const strokeColor = calls.find((c) => c.op === 'set:strokeStyle')!.args![0];
    expect(strokeColor).toBe('#1f1d2b');

    const strokeTextIdx = calls.findIndex((c) => c.op === 'strokeText');
    const fillTextIdx = calls.findIndex((c) => c.op === 'fillText');
    expect(strokeTextIdx).toBeGreaterThanOrEqual(0);
    expect(fillTextIdx).toBeGreaterThan(strokeTextIdx);

    const haloColor = [...calls.slice(0, strokeTextIdx)].reverse().find((c) => c.op === 'set:strokeStyle')!.args![0];
    expect(haloColor).toBe('rgba(255,253,246,0.96)');
    const textColor = [...calls.slice(0, fillTextIdx)].reverse().find((c) => c.op === 'set:fillStyle')!.args![0];
    expect(textColor).toBe('#1f1d2b');

    expect(calls.some((c) => c.op === 'fillText' && (c.args as string[])[0].includes('Ada'))).toBe(true);
  });

  it('is solid under high contrast', () => {
    const { ctx, calls } = mockCtx();
    drawChip(ctx, 'Ada', 'idle', true);
    const fillOp = calls.findIndex((c) => c.op === 'fill');
    const fillColor = [...calls.slice(0, fillOp)].reverse().find((c) => c.op === 'set:fillStyle')!.args![0];
    expect(fillColor).toBe(chipFillStyle(true));
  });
});
