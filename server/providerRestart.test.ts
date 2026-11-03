import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Its own folder: other *Key.test.ts / *.test.ts files that set SWARM_HOME write their own state/secrets files, and
// two test processes touching the same one at once fail on Windows.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-provider-restart-'));
process.env.SWARM_HOME = home;
const { createDemoBackend } = await import('./demo.ts');
const { Swarm } = await import('./swarm.ts');
afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

type Internals = { state: { repos: { id: string }[]; agents: { id: string; cli: string }[] } };

// An agent hired onto a custom provider (#113) must still run it after the office restarts: a fresh Swarm reads
// state.json before its own customProviders is loaded, so the agent's cli must survive that, not be reset to ''.
describe('a custom provider survives a restart', () => {
  it("keeps an agent's cli as the provider id across a fresh Swarm + init()", async () => {
    const swarm1 = new Swarm(createDemoBackend());
    await swarm1.connectRepo('demo-co/pixel-todo');
    const repoId = (swarm1 as unknown as Internals).state.repos[0].id;
    const provider = swarm1.createProvider({ name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: 'sk-restart-secret', model: 'qwen-27b' });
    const agent = swarm1.hireAgent(repoId, { cli: provider.id });
    expect(agent.cli).toBe(provider.id);
    await swarm1.shutdown(); // flushes state.json (and the provider's key to secrets.json)

    const swarm2 = new Swarm(createDemoBackend());
    await swarm2.init();
    const reloaded = (swarm2 as unknown as Internals).state.agents.find((a) => a.id === agent.id);
    expect(reloaded?.cli).toBe(provider.id);
  });
});
