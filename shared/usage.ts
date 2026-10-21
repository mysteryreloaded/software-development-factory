// How Claude's usage reads, on the server (phone messages, the CEO's company status) and in the office (the usage
// meter, the HUD's pacing chip): clock times and the names of Claude's limits.

/** "14:30", with the weekday when it isn't today. */
export function clock(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
};

/** A rate limit type as Claude reports it ("five_hour"), as people say it ("5-hour limit"). */
export const limitName = (type: string) => LIMIT_NAMES[type] ?? type.replace(/_/g, ' ');

/** How full a limit is, 0-100: Claude reports a fraction (0.82) or a percentage (82). */
export const usedPercent = (utilization: number) => Math.round(utilization <= 1 ? utilization * 100 : utilization);

/** A limit never used_percentage below is a warning; 100 or more stays as-is (the hard limit). */
export const USAGE_WARN_PCT = 90;

/** One of Claude's rate_limits entries read from a status line, rounded for display. */
export interface UsageReading {
  type: string;
  pct: number; // 0-100, rounded
  resetsAt: number | null; // epoch ms
  maxedOut: boolean; // used_percentage was 100 or more
}

interface RawLimit {
  used_percentage?: unknown;
  resets_at?: unknown;
}

/** What `SessionCallbacks.usageReading` reports: one limit's live reading. */
export type UsageReadingInfo = Pick<UsageReading, 'type' | 'pct' | 'resetsAt'>;

/** A newly-crossed usage warning (first time a limit reaches USAGE_WARN_PCT but under 100). */
export interface RateLimitWarning {
  resetsAt: number | null;
  rateLimitType: string;
  utilization: number; // 0-1
}

/**
 * Claude's status line rate_limits, parsed: every finite reading, and (tracked in `warned`, mutated in place so it
 * stays sticky across status lines) which limits newly crossed USAGE_WARN_PCT.
 */
export function parseRateLimits(limits: Record<string, RawLimit | null | undefined> | undefined, warned: Set<string>): { readings: UsageReading[]; warnings: RateLimitWarning[] } {
  const readings: UsageReading[] = [];
  const warnings: RateLimitWarning[] = [];
  for (const [type, l] of Object.entries(limits ?? {})) {
    const used = Number(l?.used_percentage);
    if (!Number.isFinite(used)) continue;
    const resetsAt = Number(l?.resets_at) > 0 ? Number(l?.resets_at) * 1000 : null;
    readings.push({ type, pct: Math.round(used), resetsAt, maxedOut: used >= 100 });
    if (used >= USAGE_WARN_PCT && used < 100 && !warned.has(type)) {
      warned.add(type);
      warnings.push({ resetsAt, rateLimitType: type, utilization: used / 100 });
    }
  }
  return { readings, warnings };
}
