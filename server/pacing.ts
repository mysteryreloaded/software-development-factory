import type { AgentCli, AgentRole, UsageLimitView, UsageView, UsageWarningView } from '../shared/types.ts';
import { clock, limitName, usedPercent } from '../shared/usage.ts';

export { clock };

// Pacing new work on Claude's usage warnings (#40). Every agent shares one subscription. When Claude warns that
// usage is getting high, the office slows down instead of running into the hard limit: finishing beats starting.
// The brake is Claude's: it holds Claude sessions (and the CEO, who always runs Claude), while agents on other
// coding agents carry on. A session uses Claude when, in the terminal runtime, the CEO runs it or the agent's next
// session runs the `claude` CLI (the same rule as the swarm's sessionRuntime); in the SDK runtime the Agent SDK
// runs Claude Code, so every session does. QA, QA fixes and CEO jobs start as normal; new issues from Claude
// agents only while fewer than settings.pacingSessions Claude sessions run; new issues from other agents always.

/** How long pacing lasts when Claude doesn't say when the window resets. */
export const PACING_MS = 60 * 60_000;
export const DEFAULT_PACING_SESSIONS = 3;

/** What a session is started for. Only new issues are held back while pacing. */
export type WorkKind = 'issue' | 'qa' | 'fix' | 'ceo';

export interface UsageClock {
  now: number;
  pausedUntil: number; // Claude rejected a session for the usage limit: nothing new starts before this
  pacingUntil: number; // Claude warned about usage: new issues are paced until this
}

/**
 * Whether a session uses Claude. In the terminal runtime, the CEO always runs Claude, an agent their own CLI or the
 * office's default (the same rule as the swarm's sessionRuntime). In the SDK runtime the Agent SDK runs Claude Code,
 * so every session is Claude's whatever CLI the agent has (`inTerminal` false). Only these sessions draw on Claude's
 * shared subscription.
 */
export function usesClaude(facts: { role: AgentRole; cli: AgentCli | '' }, defaultCli: AgentCli, inTerminal: boolean): boolean {
  if (!inTerminal) return true;
  return (facts.role === 'ceo' ? 'claude' : facts.cli || defaultCli) === 'claude';
}

/**
 * May work of this kind start now, as far as Claude's usage goes? A rejection pauses Claude sessions (the others
 * carry on); pacing caps new issues from Claude agents at `pacingSessions` running Claude sessions. A session is
 * taken as Claude's when `claude` isn't given (an all-Claude office behaves exactly as before).
 */
export function mayStart(
  kind: WorkKind,
  c: UsageClock & { running: number; runningClaude?: number; pacingSessions: number; claude?: boolean },
): boolean {
  const isClaude = c.claude ?? true;
  if (c.now < c.pausedUntil) return !isClaude;
  if (kind === 'issue' && c.now < c.pacingUntil) return isClaude ? (c.runningClaude ?? c.running) < c.pacingSessions : true;
  return true;
}

/**
 * A finished session's failure is the usage limit's fault, not the PR's or the issue's: only while the office is
 * paused, and only for sessions that used Claude. A non-Claude session that fails during a pause counts as usual.
 */
export function limitExempt(limited: boolean, usedClaude: boolean): boolean {
  return limited && usedClaude;
}

/** 5-hour first, then weekly: the usage meter's row order. */
const LIMIT_ORDER: UsageLimitView['type'][] = ['five_hour', 'seven_day'];

/** The usage state for the snapshot, with the last warning's details and the live readings for the usage meter. */
export function usageView(c: UsageClock, warning: UsageWarningView | null = null, readings: Partial<Record<UsageLimitView['type'], UsageLimitView>> = {}): UsageView {
  const limits = LIMIT_ORDER.map((t) => readings[t]).filter((r): r is UsageLimitView => !!r);
  if (c.now < c.pausedUntil) return { state: 'paused', until: c.pausedUntil, warning, limits };
  if (c.now < c.pacingUntil) return { state: 'pacing', until: c.pacingUntil, warning, limits };
  return { state: 'normal', until: null, warning, limits };
}

/** company.usage for the CEO: "normal", "pacing until 14:30" or "paused until 14:30". */
export function usageLabel(u: Pick<UsageView, 'state' | 'until'>, now: number): string {
  return u.state === 'normal' || u.until === null ? 'normal' : `${u.state} until ${clock(u.until, now)}`;
}

/** Clamp the pacing cap from the settings (1-32, default 3). */
export function clampPacingSessions(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(32, n) : DEFAULT_PACING_SESSIONS;
}

/** A usage warning as the SDK reports it. utilization may be a fraction (0.82) or a percentage (82). */
export interface UsageWarning {
  resetsAt: number | null; // epoch ms
  rateLimitType: string | null;
  utilization: number | null;
}

/** The phone message when pacing starts: the cap holds Claude sessions, agents on other coding agents carry on. */
export function pacingMessage(w: UsageWarning, until: number, sessions: number, now: number): string {
  const v = warningView(w, now);
  const what = [v.limit, v.pct === null ? null : `${v.pct}%`].filter(Boolean).join(', ');
  return `🐢 Claude's usage is getting high${what ? ` (${what})` : ''}. Until ${clock(until, now)} the office finishes open work first and starts at most ${sessions} Claude session${sessions === 1 ? '' : 's'} at a time; agents on other coding agents carry on.`;
}

/** A warning as the usage meter shows it: which limit, how full (0-100) and when it resets. */
export function warningView(w: UsageWarning, at: number): UsageWarningView {
  return { limit: w.rateLimitType ? limitName(w.rateLimitType) : null, pct: w.utilization === null ? null : usedPercent(w.utilization), resetsAt: w.resetsAt, at };
}

// ---------- resume full speed (#216) ----------

/** Why "Resume full speed" can't clear pacing right now, or null when it can. A hard pause is never lifted early. */
export function resumeRefusal(c: UsageClock): string | null {
  if (c.now < c.pausedUntil) return `Claude turned a session away at the usage limit, so nothing new starts until ${clock(c.pausedUntil, c.now)}. That pause can't be lifted early.`;
  if (c.now >= c.pacingUntil) return 'The office is already running at full speed.';
  return null;
}

/** Pacing the manager waived with "Resume full speed": when that usage window ends, and which limit it was (Claude's type). */
export interface Waiver {
  until: number;
  limit: string | null;
}

// Two reports of the same window's reset can differ by a little.
const SAME_WINDOW_MS = 60_000;

/**
 * Whether a usage warning is about the window the manager already waived, so it paces nothing: the same limit, a reset
 * no later than that window's. A warning about another limit, or a new window (the usage was reset), paces as usual.
 */
export function waived(w: UsageWarning, waiver: Waiver | null, now: number): boolean {
  if (!waiver || now >= waiver.until) return false;
  if (waiver.limit && w.rateLimitType && waiver.limit !== w.rateLimitType) return false;
  return w.resetsAt === null || w.resetsAt <= waiver.until + SAME_WINDOW_MS;
}
