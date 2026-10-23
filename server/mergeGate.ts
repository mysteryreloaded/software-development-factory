import type { PullInfo } from '../shared/types.ts';

// Auto-merge: fixes for failing checks or conflicts before a PR needs the manager, how long checks may run before
// the manager hears about it, and how long to wait before retrying a merge GitHub refused. Failing checks are first
// re-run once per head commit (a flake or an outage shouldn't cost a fix), and a re-run's old result is ignored for
// a while, since GitHub's rollup can still show it just after the re-run starts.
export const MAX_MERGE_FIXES = 5;
export const CHECKS_ALERT_MS = 30 * 60_000;
export const MERGE_RETRY_MS = 10 * 60_000;
export const RERUN_GRACE_MS = 2 * 60_000;
// GitHub Actions billing/spending-limit blocks can last a while: re-run the blocked jobs this often instead of
// burning a developer fix, so the PR merges by itself once Actions runs again.
export const BLOCKED_RERUN_MS = 30 * 60_000;

export const BLOCKED_NOTE = "GitHub Actions didn't start the jobs (billing or spending limit): waiting";

/** The parts of a QA record the merge gate reads. */
export interface MergeRecord {
  passedSha: string | null;
  ceoApprovedSha: string | null; // the head commit the CEO approved: on floors with it on, merging waits for it
  mergeFixes: number;
  pendingSince: number | null;
  mergeRetryAt: number | null;
  alerted: boolean;
  rerunSha: string | null; // the head commit whose failed checks the office re-ran
  rerunAt: number | null; // when it did
  blockedRerunAt: number | null; // next time it's due to re-run jobs GitHub Actions never started
}

/** Bookkeeping the caller writes onto the record as it is (it doesn't count as a change to the record). */
export type MergeBookkeeping = Partial<Pick<MergeRecord, 'passedSha' | 'pendingSince' | 'alerted' | 'blockedRerunAt'>>;

export type MergePull = Pick<PullInfo, 'isDraft' | 'mergeable' | 'mergeState' | 'headSha' | 'checks' | 'failedChecks' | 'pendingChecks'>;

/** What auto-merge does next with a QA-passed PR. */
export type MergeStep = { set: MergeBookkeeping } & (
  | { do: 'wait'; note?: string; alert?: boolean; blocked?: boolean } // no note: leave the card as it is; alert: tell the manager checks are slow; blocked: GitHub Actions never started the failed jobs
  | { do: 'details' } // GitHub hasn't worked out mergeability: ask about the PR itself, then decide again with `detailed`
  | { do: 'requeue' } // commits arrived after QA's sign-off: QA tests them too
  | { do: 'rerun'; runIds: number[]; reason: 'checks'; instructions: string; needsHuman: boolean } // re-run these Actions runs' failed jobs; the rest is the send-back if that can't be done
  | { do: 'rerun-blocked'; runIds: number[] } // same, but the jobs never started (billing/spending limit): never a send-back, never counts as a fix
  | { do: 'send-back'; reason: 'checks' | 'conflict'; instructions: string; needsHuman: boolean } // needsHuman: the fix budget ran out
  | { do: 'update-branch' } // the repo only merges up-to-date branches
  | { do: 'merge' }
);

/** The GitHub Actions job id behind a failed check's log URL (`/actions/runs/<run>/job/<job>`), if it has one. */
function jobIdOf(url: string | null): string | null {
  return url?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1] ?? null;
}

/** The failed checks that are GitHub Actions jobs the caller has confirmed never started. */
export function neverStartedNames(failed: MergePull['failedChecks'], neverStarted: ReadonlySet<string>): string[] {
  return failed.filter((c) => { const id = jobIdOf(c.url); return !!id && neverStarted.has(id); }).map((c) => c.name);
}

/** Every failed check is a GitHub Actions job the caller has confirmed never started. */
function allNeverStarted(failed: MergePull['failedChecks'], neverStarted: ReadonlySet<string>): boolean {
  return failed.length > 0 && neverStartedNames(failed, neverStarted).length === failed.length;
}

/**
 * Decide the next step toward merging a PR QA has passed. Pure: advanceMerge (swarm.ts) does the talking to GitHub
 * and the office. `detailed` means the PR's mergeability has already been asked for, so UNKNOWN is waited out.
 * `neverStarted`: job ids (from failed checks' log URLs) the caller has confirmed GitHub Actions never started
 * (billing or a spending limit), cached per head commit and job.
 */
export function mergeStep(
  pr: MergePull,
  rec: MergeRecord,
  now: number,
  opts: { base: string; detailed?: boolean; ceoReview?: boolean; neverStarted?: ReadonlySet<string> },
): MergeStep {
  if (pr.isDraft) return { do: 'wait', note: 'a draft: waiting', set: {} };
  if (!opts.detailed && (pr.mergeable === 'UNKNOWN' || pr.mergeState === 'UNKNOWN')) return { do: 'details', set: {} };
  const set: MergeBookkeeping = {};
  if (rec.passedSha == null) set.passedSha = pr.headSha; // signed off before the office tracked commits
  if (pr.headSha !== (set.passedSha ?? rec.passedSha)) return { do: 'requeue', set };
  const needsHuman = rec.mergeFixes >= MAX_MERGE_FIXES;
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') {
    return { do: 'send-back', reason: 'conflict', instructions: `It conflicts with ${opts.base}.`, needsHuman, set };
  }
  const rerun = rec.rerunSha === pr.headSha;
  if (pr.checks === 'failing') {
    const instructions = pr.failedChecks.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n');
    const runIds = failedRunIds(pr.failedChecks);
    if (allNeverStarted(pr.failedChecks, opts.neverStarted ?? EMPTY_SET)) {
      const due = rec.blockedRerunAt == null || now >= rec.blockedRerunAt;
      if (due && runIds.length) return { do: 'rerun-blocked', runIds, set: { ...set, blockedRerunAt: now + BLOCKED_RERUN_MS } };
      return { do: 'wait', note: BLOCKED_NOTE, blocked: true, set };
    }
    if (!rerun && runIds.length) return { do: 'rerun', runIds, reason: 'checks', instructions, needsHuman, set };
    if (rerun && rec.rerunAt != null && now - rec.rerunAt < RERUN_GRACE_MS) return { do: 'wait', note: 're-running a failed check', set };
    return { do: 'send-back', reason: 'checks', instructions, needsHuman, set };
  }
  if (pr.checks === 'pending') {
    const since = rec.pendingSince ?? now;
    if (rec.pendingSince == null) set.pendingSince = since;
    const alert = now - since > CHECKS_ALERT_MS && !rec.alerted;
    if (alert) set.alerted = true;
    const running = pr.pendingChecks.join(', ') || 'running';
    return { do: 'wait', note: rerun ? `re-running a failed check: ${running}` : `waiting for checks: ${running}`, alert, set };
  }
  set.pendingSince = null;
  if (opts.ceoReview && rec.ceoApprovedSha !== pr.headSha) return { do: 'wait', note: "waiting for the CEO's code review", set };
  if (pr.mergeable === 'UNKNOWN') return { do: 'wait', note: 'GitHub is checking it can merge', set };
  if (pr.mergeState === 'BEHIND') return { do: 'update-branch', set };
  if (rec.mergeRetryAt && now < rec.mergeRetryAt) return { do: 'wait', set };
  return { do: 'merge', set };
}

/** Hand-merge floors: the QA-passed records whose open swarm PR got new commits after the sign-off (they go back to QA). */
export function movedSincePass<R extends { prNumber: number; status: string; passedSha: string | null; updatedAt: number }>(
  recs: readonly R[],
  pulls: readonly Pick<PullInfo, 'number' | 'state' | 'headRefName' | 'headSha'>[],
  fetchedAt: number,
): R[] {
  return recs.filter((rec) => {
    if (rec.status !== 'passed' || rec.passedSha == null || fetchedAt < rec.updatedAt) return false;
    const pull = pulls.find((p) => p.number === rec.prNumber);
    return !!pull && pull.state === 'OPEN' && pull.headRefName.startsWith('swarm/') && !!pull.headSha && pull.headSha !== rec.passedSha;
  });
}

/** The GitHub Actions runs behind failed checks (from their log URLs), once each. Other checks can't be re-run from here. */
export function failedRunIds(failed: MergePull['failedChecks']): number[] {
  const ids = failed.map((c) => c.url?.match(/\/actions\/runs\/(\d+)/)?.[1]).filter((id): id is string => !!id);
  return [...new Set(ids)].map(Number);
}

/** The GitHub Actions job ids behind failed checks (from their log URLs), once each: what to ask GitHub about. */
export function failedJobIds(failed: MergePull['failedChecks']): string[] {
  return [...new Set(failed.map((c) => jobIdOf(c.url)).filter((id): id is string => !!id))];
}

const EMPTY_SET: ReadonlySet<string> = new Set();
