import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';
import type { PullInfo } from '../shared/types.ts';

// A QA-passed PR whose checks all failed because GitHub Actions never started the jobs (a billing or spending-limit
// block) waits for Actions instead of burning a developer fix round, and the floor is told about it once. (#93)
type QaLike = {
  repoId: string;
  prNumber: number;
  status: string;
  mergeFixes: number;
  passedSha: string | null;
  updatedAt: number;
  rerunSha: string | null;
  rerunAt: number | null;
  blockedRerunAt: number | null;
  pendingSince: number | null;
  alerted: boolean;
  mergeRetryAt: number | null;
};

type RepoLike = { id: string; fullName: string; autoMerge: boolean; defaultBranch: string; ceoReview: boolean };

type Internals = {
  state: { repos: RepoLike[]; qa: QaLike[]; messages: Array<{ text: string }> };
  repoRt: Map<string, { pulls: PullInfo[]; fetchedAt?: number; merging: boolean }>;
  advanceMerges(repo: RepoLike): Promise<void>;
  backend: {
    neverStartedJobs: (fullName: string, jobIds: string[]) => Promise<Set<string>>;
    rerunFailedJobs: (fullName: string, runIds: number[]) => Promise<void>;
  };
};

const blockedPull = (number: number, headSha: string): PullInfo => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/demo/repo/pull/${number}`,
  headRefName: `swarm/issue-${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  closesIssues: [],
  createdAt: '',
  mergedAt: null,
  additions: 1,
  deletions: 0,
  checks: 'failing',
  headSha,
  mergeState: 'CLEAN',
  failedChecks: [{ name: 'build', url: `https://github.com/demo/repo/actions/runs/${number}/job/${number}` }],
  pendingChecks: [],
  checkRun: null,
});

describe('GitHub Actions billing/spending-limit block', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    // connectRepo kicks off a background sync of its own; let it settle before this test takes the repo over.
    await new Promise((r) => setTimeout(r, 20));
    return swarm as unknown as Internals;
  }

  it("waits instead of sending the PRs back, never reaches needs-human, and tells the floor only once", async () => {
    const internals = await office();
    const repo = internals.state.repos[0];
    internals.backend.neverStartedJobs = async (_fullName, jobIds) => new Set(jobIds); // GitHub confirms every job it's asked about never started
    internals.backend.rerunFailedJobs = async () => {}; // the block is still on: the re-run changes nothing

    for (const n of [101, 102]) {
      internals.state.qa.push({
        repoId: repo.id,
        prNumber: n,
        status: 'passed',
        mergeFixes: 0,
        passedSha: `sha${n}`,
        updatedAt: 0,
        rerunSha: null,
        rerunAt: null,
        blockedRerunAt: null,
        pendingSince: null,
        alerted: false,
        mergeRetryAt: null,
      });
    }
    const rt = internals.repoRt.get(repo.id)!;
    rt.pulls = [blockedPull(101, 'sha101'), blockedPull(102, 'sha102')];
    rt.fetchedAt = Date.now();

    await internals.advanceMerges(repo);
    await internals.advanceMerges(repo); // a later sync, still blocked

    expect(internals.state.qa.filter((q) => [101, 102].includes(q.prNumber))).toEqual([
      expect.objectContaining({ prNumber: 101, status: 'passed', mergeFixes: 0 }),
      expect.objectContaining({ prNumber: 102, status: 'passed', mergeFixes: 0 }),
    ]);
    const billingMessages = internals.state.messages.filter((m) => m.text.includes("isn't starting jobs"));
    expect(billingMessages).toHaveLength(1);
  });
});
