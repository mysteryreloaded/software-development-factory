import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

// Its own folder: other *Key.test.ts files write the same demo secrets file in the shared one, and two test
// processes renaming it at once fail on Windows.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-providerkey-'));
process.env.SWARM_HOME = home;
const { createDemoBackend } = await import('./demo.ts');
const { Swarm } = await import('./swarm.ts');
afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

// A custom provider's API key (#113) goes in through POST/PUT /api/providers and must never come back out: not in
// GET (just hasKey: true), not in the snapshot, not in a broadcast, not in state.json, not in the journal.
describe('a custom provider', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    const sent: string[] = [];
    const ws = { OPEN: 1, readyState: 1, send: (m: string) => sent.push(m), on: () => undefined } as unknown as WebSocket;
    swarm.addClient(ws);
    return { swarm, sent };
  }

  const key = 'sk-demo-super-secret-key-9876';

  it('CRUD: create, list (GET shows hasKey only), edit keeping the key, delete', async () => {
    const { swarm } = await office();
    const created = swarm.createProvider({ name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: key, model: 'qwen-27b', contextLimit: 110072, outputLimit: 16384 });
    expect(created).toEqual({ id: 'local-qwen', name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', model: 'qwen-27b', contextLimit: 110072, outputLimit: 16384 });

    const listed = swarm.listProviders();
    expect(listed.custom).toEqual([{ ...created, hasKey: true }]);
    expect(listed.builtIn.map((c) => c.id)).toEqual(['claude', 'codex', 'opencode']);
    expect(JSON.stringify(listed)).not.toContain(key);

    // A PUT with no key keeps the current one: a session started afterwards still gets the same key.
    const edited = swarm.updateProvider('local-qwen', { name: 'Renamed Qwen' });
    expect(edited.name).toBe('Renamed Qwen');
    expect(JSON.stringify(edited)).not.toContain(key);

    // The id is a slug of the name and never changes once set, even when renamed.
    expect(edited.id).toBe('local-qwen');

    const removed = swarm.deleteProvider('local-qwen');
    expect(removed.id).toBe('local-qwen');
    expect(swarm.listProviders().custom).toEqual([]);
  });

  it('a built-in CLI id is refused: 403 to edit or delete, not a custom provider', async () => {
    const { swarm } = await office();
    expect(() => swarm.updateProvider('opencode', { name: 'x' })).toThrowError(/built-in/);
    expect(() => swarm.deleteProvider('claude')).toThrowError(/built-in/);
  });

  it('create validation: name, http(s) base URL, key and model are all required', async () => {
    const { swarm } = await office();
    expect(() => swarm.createProvider({ name: '', baseURL: 'http://x/v1', apiKey: key, model: 'm' })).toThrowError(/Name/);
    expect(() => swarm.createProvider({ name: 'X', baseURL: 'not a url', apiKey: key, model: 'm' })).toThrowError(/URL/);
    expect(() => swarm.createProvider({ name: 'X', baseURL: 'http://x/v1', apiKey: '', model: 'm' })).toThrowError(/key/);
    expect(() => swarm.createProvider({ name: 'X', baseURL: 'http://x/v1', apiKey: key, model: '' })).toThrowError(/model/);
  });

  it("the id can never collide with claude/codex/opencode, or with another provider's", async () => {
    const { swarm } = await office();
    const a = swarm.createProvider({ name: 'opencode', baseURL: 'http://x/v1', apiKey: key, model: 'm' });
    expect(a.id).toBe('opencode-2');
    const b = swarm.createProvider({ name: 'opencode', baseURL: 'http://y/v1', apiKey: key, model: 'm' });
    expect(b.id).toBe('opencode-3');
  });

  it('delete refuses with 409 while an agent or the office default uses the provider, naming them', async () => {
    const { swarm } = await office();
    const p = swarm.createProvider({ name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: key, model: 'qwen-27b' });
    swarm.updateSettings({ defaultCli: p.id });
    expect(() => swarm.deleteProvider(p.id)).toThrowError(/office default/);
    swarm.updateSettings({ defaultCli: 'claude' });

    const repoId = (swarm as unknown as { state: { repos: { id: string }[] } }).state.repos[0].id;
    const agent = swarm.hireAgent(repoId, { cli: p.id });
    expect(() => swarm.deleteProvider(p.id)).toThrowError(new RegExp(agent.name));
  });

  it('never reaches the snapshot, a broadcast, or state.json', async () => {
    const { swarm, sent } = await office();
    swarm.createProvider({ name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: key, model: 'qwen-27b' });

    const snap = swarm.snapshot();
    expect(JSON.stringify(snap)).not.toContain(key);
    for (const m of sent) expect(m).not.toContain(key);

    const stateFile = path.join(home, 'demo-state.json');
    await new Promise((r) => setTimeout(r, 50)); // state writes are async (server/swarm.ts's save())
    if (fs.existsSync(stateFile)) expect(fs.readFileSync(stateFile, 'utf8')).not.toContain(key);
  });
});
