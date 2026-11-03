import { describe, expect, it } from 'vitest';
import type { AgentCli, AgentStatus } from '../shared/types.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// #112: a full coding agent must hold only its own agents back, never a free agent on a different one.
interface TestAgent {
  id: string;
  cli: AgentCli | '';
  status: AgentStatus;
  sessionId: string | null;
  sessionCli: AgentCli | null;
  branch: string | null;
  task: 'issue' | 'qa' | 'fix' | null;
}

type Internals = {
  state: { settings: { sessionLimits: Partial<Record<AgentCli, number>> }; agents: TestAgent[] };
  agentRt: Map<string, { session: unknown; cli?: AgentCli }>;
  schedule(): void;
  hireAgent(repoId: string, opts: { cli?: string }): { id: string };
};

async function office(autoAssign = false) {
  const swarm = new Swarm(createDemoBackend());
  await swarm.connectRepo('demo-co/pixel-todo', { autoAssign });
  await swarm.syncRepo('demo-co/pixel-todo');
  const internals = swarm as unknown as Internals;
  // connectRepo always seeds one agent of its own (ensureAgent); stop it so each test's own agents are the only
  // free ones the scheduler sees.
  internals.state.agents[0].status = 'stopped';
  return { swarm, internals };
}

describe('per-coding-agent session limits in the scheduler (#112)', () => {
  it('a full Claude Code does not block a free OpenCode agent; a second Claude agent waits', async () => {
    const { internals } = await office(true);
    internals.state.settings.sessionLimits = { claude: 1 };

    const busyClaude = internals.hireAgent('demo-co/pixel-todo', { cli: 'claude' });
    const idleOpencode = internals.hireAgent('demo-co/pixel-todo', { cli: 'opencode' });
    const idleClaude = internals.hireAgent('demo-co/pixel-todo', { cli: 'claude' });
    internals.state.agents.find((a) => a.id === busyClaude.id)!.status = 'working'; // Claude Code's one slot is taken

    internals.schedule();

    expect(internals.state.agents.find((a) => a.id === idleOpencode.id)!.status).not.toBe('idle'); // started its issue
    expect(internals.state.agents.find((a) => a.id === idleClaude.id)!.status).toBe('idle'); // waits for the Claude slot
  });

  it("assign()'s 429 names the coding agent only when THAT one is full", async () => {
    const { swarm, internals } = await office();
    internals.state.settings.sessionLimits = { claude: 1 };

    const busyClaude = internals.hireAgent('demo-co/pixel-todo', { cli: 'claude' });
    const idleClaude = internals.hireAgent('demo-co/pixel-todo', { cli: 'claude' });
    const idleOpencode = internals.hireAgent('demo-co/pixel-todo', { cli: 'opencode' });
    internals.state.agents.find((a) => a.id === busyClaude.id)!.status = 'working';

    await expect(swarm.assign(idleClaude.id, 1)).rejects.toThrow(/Claude Code session slots are busy/);
    await expect(swarm.assign(idleOpencode.id, 2)).resolves.toBeDefined(); // OpenCode has no limit, so it isn't full
  });

  it("a typed follow-up resuming in its old CLI counts against that CLI, not the agent's current one", async () => {
    const { swarm, internals } = await office();
    internals.state.settings.sessionLimits = { claude: 1 };

    // Claude Code's one slot is already taken by another agent.
    const busyClaude = internals.hireAgent('demo-co/pixel-todo', { cli: 'claude' });
    internals.state.agents.find((a) => a.id === busyClaude.id)!.status = 'working';

    // This agent's own CLI is now OpenCode, but their resumable session was made by Claude Code (resumeChoice
    // only resumes a session in the CLI that made it) and they're following up live (typed at the terminal).
    const resuming = internals.hireAgent('demo-co/pixel-todo', { cli: 'opencode' });
    const agent = internals.state.agents.find((a) => a.id === resuming.id)!;
    Object.assign(agent, { sessionId: 'old-claude-session', sessionCli: 'claude', branch: 'swarm/issue-1-x', task: 'issue' });

    await expect(swarm.message(resuming.id, 'go on', true)).rejects.toThrow(/Claude Code session slots are busy/);
    // Not live (e.g. a dictated message, not typed at the terminal): drops the old session and starts fresh on
    // their own CLI (OpenCode), which has no limit.
    await expect(swarm.message(resuming.id, 'go on', false)).resolves.toBeUndefined();
  });

  it('a busy session counts against the CLI it is actually running on, not the agent’s current cli field', async () => {
    const { internals } = await office(true);
    internals.state.settings.sessionLimits = { claude: 1 };
    const busy = internals.hireAgent('demo-co/pixel-todo', { cli: 'opencode' });
    const a = internals.state.agents.find((x) => x.id === busy.id)!;
    a.status = 'working';
    internals.agentRt.set(busy.id, { session: {}, cli: 'claude' }); // resumed in Claude Code: its session's own CLI

    // A second Claude agent must see Claude Code as full even though the busy agent's own `cli` field says OpenCode.
    const secondClaude = internals.hireAgent('demo-co/pixel-todo', { cli: 'claude' });
    internals.schedule();
    expect(internals.state.agents.find((x) => x.id === secondClaude.id)!.status).toBe('idle');
  });
});
