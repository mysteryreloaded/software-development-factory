import type { CliId, CliView } from '../../../shared/types';

// Per-coding-agent session counts (#112): the server sends how many sessions are busy on each CLI
// (store.ts's sessionsRunning) and the manager's limits (settings.sessionLimits); these turn the two into the
// short label the HUD, Phone and lobby show instead of one office-wide count.

/** Total busy sessions across every coding agent. */
export function sessionsTotal(running: Partial<Record<CliId, number>>): number {
  return Object.values(running).reduce((n: number, v) => n + (v ?? 0), 0);
}

/**
 * "3/5 Claude Code" for every coding agent worth mentioning (running, or with a limit set), most active first;
 * '0' when nothing is running and nothing is capped.
 */
export function sessionsLabel(clis: CliView[], running: Partial<Record<CliId, number>>, limits: Partial<Record<CliId, number>>): string {
  const parts = clis
    .map((c) => ({ c, r: running[c.id] ?? 0, lim: limits[c.id] }))
    .filter(({ r, lim }) => r || lim)
    .sort((a, b) => b.r - a.r)
    .map(({ c, r, lim }) => (lim ? `${r}/${lim} ${c.label}` : `${r} ${c.label}`));
  return parts.length ? parts.join(' · ') : '0';
}
