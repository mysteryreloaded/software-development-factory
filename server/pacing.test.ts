import { describe, expect, it } from 'vitest';
import type { AgentCli, AgentRole } from '../shared/types.ts';
import { clampPacingSessions, clock, limitExempt, mayStart, pacingMessage, resumeRefusal, usageLabel, usageView, usesClaude, waived, warningView, type WorkKind } from './pacing.ts';

const NOW = new Date(2026, 8, 28, 12, 0).getTime();
const HOUR = 60 * 60_000;
const at = (over: Partial<Parameters<typeof mayStart>[1]> = {}) => ({ now: NOW, pausedUntil: 0, pacingUntil: 0, running: 0, pacingSessions: 3, ...over });
const KINDS: WorkKind[] = ['issue', 'qa', 'fix', 'ceo'];

describe('mayStart', () => {
  it('starts everything when usage is normal, however much is running', () => {
    for (const kind of KINDS) expect(mayStart(kind, at({ running: 20 }))).toBe(true);
  });

  it('starts new issues while pacing only under the cap', () => {
    expect(mayStart('issue', at({ pacingUntil: NOW + HOUR, running: 2 }))).toBe(true);
    expect(mayStart('issue', at({ pacingUntil: NOW + HOUR, running: 3 }))).toBe(false);
    expect(mayStart('issue', at({ pacingUntil: NOW + HOUR, running: 9, pacingSessions: 10 }))).toBe(true);
  });

  it('keeps starting QA, fixes and CEO jobs while pacing', () => {
    for (const kind of ['qa', 'fix', 'ceo'] as const) expect(mayStart(kind, at({ pacingUntil: NOW + HOUR, running: 12 }))).toBe(true);
  });

  it('starts nothing at all once Claude rejects a session, pacing or not', () => {
    for (const kind of KINDS) {
      expect(mayStart(kind, at({ pausedUntil: NOW + HOUR }))).toBe(false);
      expect(mayStart(kind, at({ pausedUntil: NOW + HOUR, pacingUntil: NOW + 2 * HOUR }))).toBe(false);
    }
  });

  it('stops pacing when it expires', () => {
    expect(mayStart('issue', at({ pacingUntil: NOW, running: 10 }))).toBe(true);
    expect(mayStart('issue', at({ pacingUntil: NOW - 1, pausedUntil: NOW - 1, running: 10 }))).toBe(true);
  });
});

describe('usageView and usageLabel', () => {
  it('is normal, pacing or paused, with the pause first', () => {
    expect(usageView({ now: NOW, pausedUntil: 0, pacingUntil: 0 })).toEqual({ state: 'normal', until: null, warning: null, limits: [] });
    expect(usageView({ now: NOW, pausedUntil: 0, pacingUntil: NOW + HOUR })).toEqual({ state: 'pacing', until: NOW + HOUR, warning: null, limits: [] });
    expect(usageView({ now: NOW, pausedUntil: NOW + HOUR, pacingUntil: NOW + 2 * HOUR })).toEqual({ state: 'paused', until: NOW + HOUR, warning: null, limits: [] });
    expect(usageView({ now: NOW, pausedUntil: NOW, pacingUntil: NOW })).toEqual({ state: 'normal', until: null, warning: null, limits: [] });
  });

  it("carries the last warning's limit, fill and reset for the usage meter", () => {
    const warning = warningView({ resetsAt: NOW + HOUR, rateLimitType: 'seven_day', utilization: 0.91 }, NOW);
    expect(warning).toEqual({ limit: 'weekly limit', pct: 91, resetsAt: NOW + HOUR, at: NOW });
    expect(usageView({ now: NOW, pausedUntil: 0, pacingUntil: NOW + HOUR }, warning)).toEqual({ state: 'pacing', until: NOW + HOUR, warning, limits: [] });
    expect(warningView({ resetsAt: null, rateLimitType: null, utilization: null }, NOW)).toEqual({ limit: null, pct: null, resetsAt: null, at: NOW });
  });

  it('orders live readings 5-hour then weekly, and ignores other limit types', () => {
    const fiveHour = { type: 'five_hour' as const, pct: 40, resetsAt: NOW + HOUR, at: NOW };
    const weekly = { type: 'seven_day' as const, pct: 70, resetsAt: NOW + 2 * HOUR, at: NOW };
    expect(usageView({ now: NOW, pausedUntil: 0, pacingUntil: 0 }, null, { seven_day: weekly, five_hour: fiveHour }).limits).toEqual([fiveHour, weekly]);
    expect(usageView({ now: NOW, pausedUntil: 0, pacingUntil: 0 }, null, { five_hour: fiveHour }).limits).toEqual([fiveHour]);
    expect(usageView({ now: NOW, pausedUntil: 0, pacingUntil: 0 }, null, {}).limits).toEqual([]);
  });

  it('reads as the CEO sees it in company_status', () => {
    expect(usageLabel({ state: 'normal', until: null }, NOW)).toBe('normal');
    expect(usageLabel({ state: 'pacing', until: NOW + 150 * 60_000 }, NOW)).toBe('pacing until 14:30');
    expect(usageLabel({ state: 'paused', until: NOW + 5 * 60_000 }, NOW)).toBe('paused until 12:05');
  });

  it('names the day when the window resets on another day', () => {
    expect(clock(NOW + 3 * 24 * HOUR, NOW)).toMatch(/^[A-Z][a-z]{2} 12:00$/);
  });
});

describe('pacingMessage', () => {
  it('says which limit, how full, until when and how many Claude sessions', () => {
    expect(pacingMessage({ resetsAt: null, rateLimitType: 'five_hour', utilization: 0.82 }, NOW + 150 * 60_000, 3, NOW)).toBe(
      "🐢 Claude's usage is getting high (5-hour limit, 82%). Until 14:30 the office finishes open work first and starts at most 3 Claude sessions at a time; agents on other coding agents carry on.",
    );
  });

  it('copes with a percentage and with missing details', () => {
    expect(pacingMessage({ resetsAt: null, rateLimitType: 'seven_day', utilization: 91 }, NOW + HOUR, 1, NOW)).toContain('(weekly limit, 91%)');
    expect(pacingMessage({ resetsAt: null, rateLimitType: 'seven_day', utilization: 91 }, NOW + HOUR, 1, NOW)).toContain('at most 1 Claude session at a time');
    expect(pacingMessage({ resetsAt: null, rateLimitType: null, utilization: null }, NOW + HOUR, 3, NOW)).toMatch(/^🐢 Claude's usage is getting high\. Until 13:00/);
  });
});

it('clamps the pacing cap to 1-32, default 3', () => {
  expect(clampPacingSessions(5)).toBe(5);
  expect(clampPacingSessions('7')).toBe(7);
  expect(clampPacingSessions(100)).toBe(32);
  expect(clampPacingSessions(0)).toBe(3);
  expect(clampPacingSessions(-4)).toBe(3);
  expect(clampPacingSessions('lots')).toBe(3);
  expect(clampPacingSessions(2.6)).toBe(3);
});

describe('resume full speed', () => {
  it('clears pacing, but never a hard pause and never when there is nothing to clear', () => {
    expect(resumeRefusal({ now: NOW, pausedUntil: 0, pacingUntil: NOW + HOUR })).toBeNull();
    expect(resumeRefusal({ now: NOW, pausedUntil: NOW + 5 * 60_000, pacingUntil: NOW + HOUR })).toBe(
      "Claude turned a session away at the usage limit, so nothing new starts until 12:05. That pause can't be lifted early.",
    );
    expect(resumeRefusal({ now: NOW, pausedUntil: 0, pacingUntil: 0 })).toBe('The office is already running at full speed.');
    expect(resumeRefusal({ now: NOW, pausedUntil: NOW - 1, pacingUntil: NOW })).toBe('The office is already running at full speed.');
  });

  it("ignores later warnings about the window the manager waived, but not another limit's or a new window's", () => {
    const waiver = { until: NOW + 2 * HOUR, limit: 'five_hour' };
    const warn = (rateLimitType: string | null, resetsAt: number | null) => ({ rateLimitType, resetsAt, utilization: 0.85 });
    expect(waived(warn('five_hour', NOW + 2 * HOUR), waiver, NOW)).toBe(true);
    expect(waived(warn('five_hour', NOW + 2 * HOUR + 30_000), waiver, NOW)).toBe(true); // the same reset, reported a little differently
    expect(waived(warn('five_hour', null), waiver, NOW)).toBe(true);
    expect(waived(warn(null, NOW + HOUR), waiver, NOW)).toBe(true);
    expect(waived(warn('seven_day', NOW + 30 * HOUR), waiver, NOW)).toBe(false);
    expect(waived(warn('five_hour', NOW + 7 * HOUR), waiver, NOW)).toBe(false); // the usage was reset: a new window
    expect(waived(warn('five_hour', NOW + 2 * HOUR), waiver, NOW + 2 * HOUR)).toBe(false); // the waived window is over
    expect(waived(warn('five_hour', NOW + 2 * HOUR), null, NOW)).toBe(false);
  });
});

describe('the brake is Claude’s only (#97)', () => {
  it('pauses Claude starts; a non-Claude QA, fix or issue carries on', () => {
    expect(mayStart('issue', at({ pausedUntil: NOW + HOUR, claude: true }))).toBe(false);
    expect(mayStart('ceo', at({ pausedUntil: NOW + HOUR, claude: true }))).toBe(false);
    for (const kind of ['qa', 'fix', 'issue'] as const) {
      expect(mayStart(kind, at({ pausedUntil: NOW + HOUR, claude: false }))).toBe(true);
    }
  });

  it('caps a Claude agent’s new issue by running Claude sessions only; a non-Claude agent’s is not held', () => {
    const capFull = { pacingUntil: NOW + HOUR, pacingSessions: 3, running: 9, runningClaude: 3 };
    expect(mayStart('issue', at({ ...capFull, claude: true }))).toBe(false); // the cap is full of Claude sessions
    expect(mayStart('issue', at({ ...capFull, runningClaude: 2, claude: true }))).toBe(true); // room left in the cap
    expect(mayStart('issue', at({ ...capFull, claude: false }))).toBe(true); // even when the cap is full of Claude sessions
  });

  it('in the terminal runtime: the CEO always uses Claude, an agent its own CLI or the office default', () => {
    const a = (role: AgentRole, cli: AgentCli | '') => ({ role, cli });
    const terminal = true;
    expect(usesClaude(a('ceo', 'opencode'), 'opencode', terminal)).toBe(true); // the CEO always runs Claude
    expect(usesClaude(a('agent', 'claude'), 'opencode', terminal)).toBe(true); // the agent's own CLI
    expect(usesClaude(a('agent', ''), 'claude', terminal)).toBe(true); // the office default
    expect(usesClaude(a('agent', 'opencode'), 'claude', terminal)).toBe(false);
    expect(usesClaude(a('agent', 'codex'), 'claude', terminal)).toBe(false);
    expect(usesClaude(a('agent', ''), 'opencode', terminal)).toBe(false);
  });

  it('in the SDK runtime the Agent SDK runs Claude Code, so an opencode agent uses Claude too', () => {
    const a = (role: AgentRole, cli: AgentCli | '') => ({ role, cli });
    const sdk = false;
    expect(usesClaude(a('agent', 'opencode'), 'claude', sdk)).toBe(true); // the office default is Claude
    expect(usesClaude(a('agent', 'opencode'), 'opencode', sdk)).toBe(true); // even when the office default is opencode
    expect(usesClaude(a('agent', 'codex'), 'claude', sdk)).toBe(true);
    expect(usesClaude(a('ceo', 'opencode'), 'claude', sdk)).toBe(true);
  });

  it('exempts a failure from the strikes only while paused and only for a Claude session', () => {
    expect(limitExempt(true, true)).toBe(true); // a Claude session turned away at the limit: not the PR's or issue's fault
    expect(limitExempt(true, false)).toBe(false); // a non-Claude session that fails during a pause counts as usual
    expect(limitExempt(false, true)).toBe(false); // not paused: counts
    expect(limitExempt(false, false)).toBe(false);
  });
});
