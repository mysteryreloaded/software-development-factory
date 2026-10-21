import { describe, expect, it } from 'vitest';
import { clock, limitName, parseRateLimits, usedPercent } from './usage';

describe('clock', () => {
  it('shows HH:MM, and the weekday when it is another day', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    expect(clock(now + 5 * 60_000, now)).toBe('12:05');
    expect(clock(now + 3 * 24 * 60 * 60_000, now)).toMatch(/^[A-Z][a-z]{2} 12:00$/);
  });
});

describe('limitName and usedPercent', () => {
  it("names Claude's limits for people", () => {
    expect(limitName('five_hour')).toBe('5-hour limit');
    expect(limitName('seven_day')).toBe('weekly limit');
    expect(limitName('something_else')).toBe('something else');
  });

  it('reads a fraction or a percentage the same way', () => {
    expect(usedPercent(0.82)).toBe(82);
    expect(usedPercent(82)).toBe(82);
  });
});

describe('parseRateLimits', () => {
  it('reads every finite reading, rounded, with its reset', () => {
    const { readings } = parseRateLimits({ five_hour: { used_percentage: 41.6, resets_at: 1000 }, seven_day: { used_percentage: 70, resets_at: 2000 } }, new Set());
    expect(readings).toEqual([
      { type: 'five_hour', pct: 42, resetsAt: 1_000_000, maxedOut: false },
      { type: 'seven_day', pct: 70, resetsAt: 2_000_000, maxedOut: false },
    ]);
  });

  it('skips entries without a finite used_percentage, and drops a reset at or before zero', () => {
    const { readings } = parseRateLimits({ five_hour: { used_percentage: 'n/a' }, seven_day: { used_percentage: 50, resets_at: 0 } }, new Set());
    expect(readings).toEqual([{ type: 'seven_day', pct: 50, resetsAt: null, maxedOut: false }]);
  });

  it('marks a limit at 100% or more as maxed out', () => {
    const { readings } = parseRateLimits({ five_hour: { used_percentage: 100, resets_at: 5000 } }, new Set());
    expect(readings).toEqual([{ type: 'five_hour', pct: 100, resetsAt: 5_000_000, maxedOut: true }]);
  });

  it('warns the first time a limit crosses 90%, once per type, and never for the hard limit', () => {
    const warned = new Set<string>();
    expect(parseRateLimits({ five_hour: { used_percentage: 91 } }, warned).warnings).toEqual([{ resetsAt: null, rateLimitType: 'five_hour', utilization: 0.91 }]);
    // the same type, still over 90%: no second warning
    expect(parseRateLimits({ five_hour: { used_percentage: 95 } }, warned).warnings).toEqual([]);
    // 100% is the hard limit, not a warning
    expect(parseRateLimits({ seven_day: { used_percentage: 100 } }, warned).warnings).toEqual([]);
    // a different type still warns
    expect(parseRateLimits({ seven_day_opus: { used_percentage: 92 } }, warned).warnings).toEqual([{ resetsAt: null, rateLimitType: 'seven_day_opus', utilization: 0.92 }]);
  });
});
