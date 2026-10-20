import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// A passed, unapproved PR only awaits a code review while its floor's ceoReview is on: switching the floor off
// drops the queued review (no CEO session, no "without a verdict" message). (issue #15)
type CeoJobLike = { kind: string; repoId?: string; prNumber?: number; at: number };
type Internals = {
  state: {
    repos: Array<{ id: string; ceoReview: boolean }>;
    qa: Array<{ repoId: string; prNumber: number; status: string; issueNumber: number | null; passedSha: string | null; ceoApprovedSha: string | null }>;
    ceo: { queue: CeoJobLike[] };
  };
  reviewRecord(job: CeoJobLike): unknown;
};

describe('code review queue', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    return { swarm, internals: swarm as unknown as Internals };
  }

  it('queues a review when the floor switches it on, and drops it when it switches it off', async () => {
    const { swarm, internals } = await office();
    const repoId = internals.state.repos[0].id;
    internals.state.qa.push({ repoId, prNumber: 4, status: 'passed', issueNumber: 1, passedSha: 'head1', ceoApprovedSha: null });

    swarm.updateRepo(repoId, { ceoReview: true });
    const job = internals.state.ceo.queue.find((j) => j.kind === 'code-review');
    expect(job).toMatchObject({ kind: 'code-review', repoId, prNumber: 4 });
    expect(internals.reviewRecord(job!)).toBeDefined();

    swarm.updateRepo(repoId, { ceoReview: false });
    expect(internals.reviewRecord(job!)).toBeUndefined();
  });
});
