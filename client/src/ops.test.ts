import { describe, expect, it } from 'vitest';
import type { OpsAlarm, UsageLimitView, UsageView } from '../../shared/types';
import { EMPTY_NUMBERS, fmtDuration, fmtPct, fmtUsd, newAlarms, signLine, usageChip, usageMeter } from './ops';

const NOW = new Date(2026, 8, 28, 12, 0).getTime();
const MIN = 60_000;
const TUESDAY = new Date(2026, 8, 29, 0, 0).getTime();

describe('formatting', () => {
  it('says durations the short way', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(12 * MIN)).toBe('12m');
    expect(fmtDuration(102 * MIN)).toBe('1h 42m');
    expect(fmtDuration(120 * MIN)).toBe('2h');
    expect(fmtDuration(51 * 60 * MIN)).toBe('2d 3h');
  });

  it('percentages and dollars', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(0.917)).toBe('92%');
    expect(fmtUsd(4.2)).toBe('$4.20');
    expect(fmtUsd(123.4)).toBe('$123');
  });

  it("puts a floor's numbers on one line for its sign", () => {
    expect(signLine({ ...EMPTY_NUMBERS, mergedToday: 3, leadMs: 102 * MIN, ciPass: 0.92, costToday: 4.2 })).toBe('🚀 3 today · ⏱ 1h 42m lead · ✅ CI 92% · 💵 ~$4.20');
  });
});

describe('usage', () => {
  const warning = { limit: 'weekly limit', pct: 91, resetsAt: TUESDAY, at: NOW - MIN };
  const fiveHour: UsageLimitView = { type: 'five_hour', pct: 40, resetsAt: NOW + 2 * 60 * MIN, at: NOW - MIN };
  const weekly: UsageLimitView = { type: 'seven_day', pct: 91, resetsAt: TUESDAY, at: NOW - MIN };
  const pacing: UsageView = { state: 'pacing', until: TUESDAY, warning, limits: [fiveHour, weekly] };

  it('shows the chip only while new work is held back', () => {
    expect(usageChip({ state: 'normal', until: null, warning, limits: [] }, 3, NOW)).toBeNull();
    expect(usageChip(pacing, 3, NOW)).toMatch(/^🐢 Paced until [A-Z][a-z]{2} 00:00: new issues start when fewer than 3 sessions run$/);
    expect(usageChip(pacing, 1, NOW)).toMatch(/fewer than 1 session run$/);
    expect(usageChip({ state: 'paused', until: NOW + 5 * MIN, warning: null, limits: [] }, 3, NOW)).toBe("⏸ Paused until 12:05: at Claude's usage limit, nothing new starts");
  });

  it("reads the meter: the state, and the last warning's limit, fill and reset", () => {
    expect(usageMeter(pacing, NOW)).toMatchObject({ state: 'Pacing', tone: 'warn', limit: 'weekly limit · 91%', pct: 91 });
    expect(usageMeter(pacing, NOW).resets).toMatch(/00:00$/);
    expect(usageMeter({ state: 'normal', until: null, warning: null, limits: [] }, NOW)).toMatchObject({ state: 'Normal', tone: 'good', limit: 'No usage warnings', pct: null, resets: null });
    // after Resume full speed the warning is still shown, with its window's reset
    expect(usageMeter({ state: 'normal', until: null, warning, limits: [] }, NOW)).toMatchObject({ state: 'Normal', limit: 'weekly limit · 91%' });
    expect(usageMeter({ state: 'normal', until: null, warning: { ...warning, resetsAt: NOW - MIN }, limits: [] }, NOW).resets).toBeNull();
    expect(usageMeter({ state: 'paused', until: NOW + 5 * MIN, warning: null, limits: [] }, NOW)).toMatchObject({ state: 'Paused', tone: 'bad', resets: '12:05' });
  });

  it('carries one row per live reading, with its fill, tone, reset and as-of', () => {
    const m = usageMeter(pacing, NOW);
    expect(m.limits).toEqual([
      { label: '5-hour', pct: 40, tone: 'good', resets: expect.stringMatching(/^reset at \d{2}:\d{2}$/), asOf: expect.any(String) },
      { label: 'Weekly', pct: 91, tone: 'bad', resets: expect.stringContaining('reset at'), asOf: expect.any(String) },
    ]);
    expect(m.noReadings).toBeNull();
  });

  it('shows no reading since once a reading\'s reset has passed', () => {
    const past: UsageLimitView = { type: 'five_hour', pct: 82, resetsAt: NOW - MIN, at: NOW - 10 * MIN };
    const row = usageMeter({ state: 'normal', until: null, warning: null, limits: [past] }, NOW).limits[0];
    expect(row.pct).toBeNull();
    expect(row.resets).toContain('no reading since');
  });

  it('says so when there are no readings at all', () => {
    expect(usageMeter({ state: 'normal', until: null, warning: null, limits: [] }, NOW).noReadings).toBe('No reading yet: it comes with the next Claude session');
  });

  it('copes with a day recorded before live readings existed, with no limits field at all', () => {
    const old = { state: 'normal', until: null, warning: null } as UsageView;
    expect(usageMeter(old, NOW)).toMatchObject({ limits: [], noReadings: 'No reading yet: it comes with the next Claude session' });
  });
});

describe('newAlarms', () => {
  const alarm = (id: string): OpsAlarm => ({ id, kind: 'pr', repoId: 'o/a', floor: 1, prNumber: 1, agentId: null, text: '', since: NOW });
  it('sounds only for alarms that just appeared', () => {
    expect(newAlarms([], [alarm('a')]).map((a) => a.id)).toEqual(['a']);
    expect(newAlarms([alarm('a')], [alarm('a'), alarm('b')]).map((a) => a.id)).toEqual(['b']);
    expect(newAlarms([alarm('a'), alarm('b')], [alarm('b')])).toEqual([]);
  });
});
