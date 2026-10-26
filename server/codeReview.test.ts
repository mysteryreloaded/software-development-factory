import { describe, expect, it } from 'vitest';
import type { AgentCli } from '../shared/types.ts';
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

// A session can only be resumed by the CLI that made it (#105): a dev whose last session was another CLI's than
// theirs starts a fresh one in their own CLI; the QA record keeps which CLI made the dev's session.
describe('a fix for a PR whose dev changed CLI', () => {
  type FixInternals = {
    state: {
      repos: Array<{ id: string }>;
      agents: Array<Record<string, unknown>>;
      qa: Array<Record<string, unknown>>;
    };
    agentRt: Map<string, { log: unknown[]; session: unknown; currentTool: unknown; browserUrl: unknown; screenshot: unknown; shots: unknown; terminal: unknown }>;
    backend: { startSession(opts: { cli?: unknown; resumeSessionId?: unknown; agentId?: unknown }, cb: unknown): unknown };
    runFix(dev: Record<string, unknown>, repo: Record<string, unknown>, rec: Record<string, unknown>): Promise<void>;
  };

  // A full persisted agent, on a machine already (an agent without one drops its sessions when it moves, which this
  // test is not about), whose CLI is no longer the one that made the session the QA record points at.
  const devAgent = (repoId: string) => ({
    id: 'dev-1111',
    name: 'Ruth',
    repoId,
    role: 'agent',
    look: 'masculine',
    task: null,
    desk: 3,
    color: '#3a5a40',
    hair: '#111111',
    skin: '#f0c0a0',
    style: null,
    model: '',
    effort: '',
    cli: 'opencode',
    machine: 'machine-0000',
    status: 'idle',
    issueNumber: null,
    issueTitle: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    startedAt: null,
    endedAt: null,
    costUsd: 0,
    turns: 0,
    sessionId: null,
    sessionCli: null,
    lastError: null,
    logTail: [],
  });

  const qaRecord = (repoId: string, devSessionCli: AgentCli | null) => ({
    repoId,
    prNumber: 6,
    status: 'failed',
    round: 1,
    devAgentId: 'dev-1111',
    qaAgentId: null,
    summary: 'The toolbar overflows on a 375px screen.',
    checks: [{ name: 'Mobile layout (375px)', result: 'fail', details: 'Toolbar overflows horizontally' }],
    commentUrl: null,
    updatedAt: Date.now(),
    issueNumber: 3,
    devSessionId: 'demo-old-session',
    devSessionCli,
    fixInstructions: 'Make the toolbar wrap below 480px.',
    sessionFailures: 0,
    mergeNote: null,
    testedSha: 'a1b2c3d',
    passedSha: null,
    ceoApprovedSha: null,
    fixReason: 'qa',
    mergeFixes: 0,
    retests: 0,
    pendingSince: null,
    mergeRetryAt: null,
    alerted: false,
    preQa: null,
    noChangeSha: null,
    rerunSha: null,
    rerunAt: null,
    blockedRerunAt: null,
    qaChecks: null,
    stuckWhy: null,
    triages: 0,
    escalated: false,
  });

  async function fixIn(devSessionCli: AgentCli | null) {
    const swarm = new Swarm(createDemoBackend());
    const internals = swarm as unknown as FixInternals;
    await swarm.connectRepo('demo-co/pixel-todo');
    const repoId = internals.state.repos[0].id;
    internals.state.agents.push(devAgent(repoId));
    internals.agentRt.set('dev-1111', { log: [], session: null, currentTool: null, browserUrl: null, screenshot: null, shots: [], terminal: null });
    const rec = qaRecord(repoId, devSessionCli);
    internals.state.qa.push(rec);
    const started: Array<{ cli?: unknown; resumeSessionId?: unknown }> = [];
    // The demo's fake session drives the office through timers; a stub that only records what the office asked for.
    internals.backend.startSession = (opts) => {
      if (opts.agentId === 'dev-1111') started.push({ cli: opts.cli, resumeSessionId: opts.resumeSessionId });
      return { send: () => undefined, stop: () => undefined };
    };
    await internals.runFix(internals.state.agents.find((a) => a.id === 'dev-1111')!, internals.state.repos[0], rec);
    return started;
  }

  it('starts a fresh session in the dev\'s own CLI when their session was another CLI\'s', async () => {
    expect(await fixIn('claude')).toEqual([{ cli: 'opencode', resumeSessionId: undefined }]);
  });

  it('resumes the dev\'s session when the dev\'s CLI is the one that made it', async () => {
    expect(await fixIn('opencode')).toEqual([{ cli: 'opencode', resumeSessionId: 'demo-old-session' }]);
  });
});
