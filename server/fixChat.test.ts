import { describe, expect, it, vi } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// A manager's chat with a developer whose fix session has already ended resumes that same session (the fix's CLI
// stays at its prompt), so the chat's end lands in onFixFinished (#108). It is the fix only while the QA record still
// waits on that developer; otherwise the chat leaves the record untouched (no second QA round, no failed-session
// strike) and the developer is simply done, or has hit a problem.

type LogLine = { kind: string; text: string };
type Session = { opts: Record<string, unknown>; cb: { finished(r: Record<string, unknown>): void } };
type Internals = {
  state: {
    repos: Array<{ id: string; fullName: string; defaultBranch: string }>;
    agents: Array<Record<string, unknown>>;
    qa: Array<Record<string, unknown>>;
  };
  agentRt: Map<string, { log: LogLine[]; session: unknown; currentTool: unknown; browserUrl: unknown; screenshot: unknown; shots: unknown; terminal: unknown }>;
  backend: {
    startSession(opts: Record<string, unknown>, cb: { finished(r: Record<string, unknown>): void }): unknown;
    deskExists(dir: string): boolean;
    prDetails(fullName: string, number: number): Promise<Record<string, unknown>>;
  };
  message(id: string, text: string, typed?: boolean, ids?: string[]): Promise<unknown>;
  onFixFinished(a: Record<string, unknown>, repo: Record<string, unknown>, result: Record<string, unknown>): Promise<void>;
};

// The developer: their fix session ended, so the record's session is theirs to resume for the chat.
const devAgent = (repoId: string, status: string): Record<string, unknown> => ({
  id: 'dev-1111',
  name: 'Ruth',
  repoId,
  role: 'agent',
  look: 'masculine',
  task: 'fix',
  desk: 3,
  color: '#3a5a40',
  hair: '#111111',
  skin: '#f0c0a0',
  style: null,
  model: '',
  effort: '',
  cli: 'claude',
  machine: 'machine-0000',
  status,
  issueNumber: 3,
  issueTitle: 'Toolbar overflow',
  branch: 'fix/issue-3-niklaus',
  prNumber: 6,
  prUrl: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  turns: 0,
  sessionId: 'demo-fix-1',
  sessionCli: 'claude',
  lastError: null,
  logTail: [],
});

const qaRecord = (repoId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repoId,
  prNumber: 6,
  status: 'fixing',
  round: 1,
  devAgentId: 'dev-1111',
  qaAgentId: 'qa-2222',
  summary: 'The toolbar overflows on a 375px screen.',
  checks: [{ name: 'Mobile layout (375px)', result: 'fail', details: 'Toolbar overflows horizontally' }],
  commentUrl: null,
  updatedAt: Date.now(),
  issueNumber: 3,
  devSessionId: 'demo-fix-1',
  devSessionCli: 'claude',
  fixInstructions: 'Make the toolbar wrap below 480px.',
  sessionFailures: 0,
  mergeNote: null,
  testedSha: 'h1',
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
  qaChecks: 'failing',
  stuckWhy: null,
  triages: 0,
  escalated: false,
  ...over,
});

async function office() {
  const swarm = new Swarm(createDemoBackend());
  await swarm.connectRepo('demo-co/pixel-todo');
  return { swarm, internals: swarm as unknown as Internals };
}

// The demo's fake session would drive the office on timers; a stub that only records what the office asked for.
const stubSessions = (internals: Internals): Session[] => {
  const sessions: Session[] = [];
  internals.backend.startSession = (opts, cb) => {
    sessions.push({ opts, cb });
    return { send: () => undefined, stop: () => undefined };
  };
  return sessions;
};
const chatSessions = (sessions: Session[]) => sessions.filter((s) => s.opts.agentId === 'dev-1111');

describe('a manager chat with a finished fix (#108)', () => {
  const okResult = { ok: true, text: '', costUsd: 0.2, turns: 5, errors: [] };
  const badResult = { ok: false, text: '', costUsd: 0.1, turns: 2, errors: ['the session crashed'] };

  const officeWithChat = async (over: Record<string, unknown>) => {
    const { swarm, internals } = await office();
    const repo = internals.state.repos[0];
    const dev = devAgent(repo.id, 'done');
    internals.state.agents.push(dev);
    internals.agentRt.set('dev-1111', { log: [], session: null, currentTool: null, browserUrl: null, screenshot: null, shots: [], terminal: null });
    const rec = qaRecord(repo.id, over);
    internals.state.qa.push(rec);
    const before = { ...rec };
    const sessions = stubSessions(internals);
    internals.backend.deskExists = () => true; // the dev's desk is still there, so the chat's session starts at once
    return { swarm, internals, dev, rec, before, sessions };
  };

  for (const status of ['queued', 'testing']) {
    it(`leaves the record untouched when it is '${status}' and the chat ends well`, async () => {
      const { swarm, internals, dev, rec, before, sessions } = await officeWithChat({ status, round: 2, retests: 1 });
      await swarm.message('dev-1111', 'Are you done with this task?');
      await vi.waitFor(() => expect(chatSessions(sessions)).toHaveLength(1));
      // The chat resumes the fix's session, in the CLI that made it.
      expect(chatSessions(sessions).at(-1)!.opts).toMatchObject({ task: 'fix', resumeSessionId: 'demo-fix-1' });

      chatSessions(sessions).at(-1)!.cb.finished(okResult);
      await vi.waitFor(() => expect(dev.status).toBe('done'));
      // No second QA round (round and retests), no strike, and the record is still where the chat found it.
      expect(rec).toEqual(before);
      expect(chatSessions(sessions)).toHaveLength(1); // the chat's session only: no second session for the fix
      const log = internals.agentRt.get('dev-1111')!.log;
      expect(log.some((l) => l.text === 'Chat about PR #6 finished.')).toBe(true);
    });
  }

  it('reports a failed chat as a problem for the dev, without a strike on the record', async () => {
    const { swarm, dev, rec, before, sessions } = await officeWithChat({ status: 'queued', round: 2, retests: 1 });
    await swarm.message('dev-1111', 'Are you done with this task?');
    await vi.waitFor(() => expect(chatSessions(sessions)).toHaveLength(1));

    chatSessions(sessions).at(-1)!.cb.finished(badResult);
    await vi.waitFor(() => expect(dev.status).toBe('error'));
    expect(dev.lastError).toBe('the session crashed');
    expect(rec).toEqual(before); // no 'failed' on the record, no strike, no needs-human
  });

  // The guard must not swallow the real fix: a fix that pushed nothing is still asked once more, and the second
  // no-push ends in a strike exactly as before the chat was recognized.
  it('a fix that pushed nothing is still asked once more, and the second no-push ends in a strike', async () => {
    const { internals } = await office();
    const repo = internals.state.repos[0];
    const dev = devAgent(repo.id, 'working');
    internals.state.agents.push(dev);
    internals.agentRt.set('dev-1111', { log: [], session: null, currentTool: null, browserUrl: null, screenshot: null, shots: [], terminal: null });
    const rec = qaRecord(repo.id, { testedSha: 'h1' });
    internals.state.qa.push(rec);
    const before = { ...rec };
    const sessions = stubSessions(internals);
    internals.backend.deskExists = () => true;
    internals.backend.prDetails = async () => ({
      number: 6,
      title: 'Fix the toolbar overflow',
      body: '',
      url: 'https://github.com/demo-co/pixel-todo/pull/6',
      headRefName: 'fix/issue-3-niklaus',
      headSha: 'h1',
      isCrossRepository: false,
      closesIssues: [3],
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeState: 'CLEAN',
      checks: 'failing',
      checkNames: [],
      failedChecks: [],
      pendingChecks: [],
    });

    await internals.onFixFinished(dev, repo, okResult);
    // The no-push nudge: the record still waits on this developer, and the session is asked once more.
    expect(rec).toEqual(before);
    await vi.waitFor(() => expect(chatSessions(sessions)).toHaveLength(1));
    const log = internals.agentRt.get('dev-1111')!.log;
    expect(log.some((l) => l.text === 'No new commits were pushed for PR #6; asking Ruth once more.')).toBe(true);

    // The nudge ends without pushing again: now it is the fix's second no-push, and a strike it is.
    chatSessions(sessions).at(-1)!.cb.finished(okResult);
    await vi.waitFor(() => expect(rec.status).toBe('failed'));
    expect(rec.sessionFailures).toBe(1);
    expect(dev.status).toBe('error');
  });
});
