import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Its own folder: other *Key.test.ts files write the same demo secrets file in the shared one, and two test
// processes renaming it at once fail on Windows.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-looktool-'));
process.env.SWARM_HOME = home;
const { createDemoBackend } = await import('./demo.ts');
const { Swarm } = await import('./swarm.ts');
afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

// The look tool's floor switch (RepoView.lookTool) and its model picker (SwarmSettings.lookProvider), #123.
describe('the look tool floor switch', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    return { swarm };
  }

  it('defaults to off for a new floor', async () => {
    const { swarm } = await office();
    expect(swarm.updateRepo('demo-co/pixel-todo', {}).lookTool).toBe(false);
  });

  it('is patched on and off, and shown in the repo view', async () => {
    const { swarm } = await office();
    expect(swarm.updateRepo('demo-co/pixel-todo', { lookTool: true }).lookTool).toBe(true);
    expect(swarm.snapshot().repos[0].lookTool).toBe(true);
    expect(swarm.updateRepo('demo-co/pixel-todo', { lookTool: false }).lookTool).toBe(false);
  });
});

describe('the look tool model (SwarmSettings.lookProvider)', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    return { swarm };
  }

  it('defaults to null', async () => {
    const { swarm } = await office();
    expect(swarm.snapshot().settings.lookProvider).toBeNull();
  });

  it('is set to a known custom provider, and cleared with null', async () => {
    const { swarm } = await office();
    const p = swarm.createProvider({ name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: 'sk-demo', model: 'qwen-27b' });
    swarm.updateSettings({ lookProvider: p.id });
    expect(swarm.snapshot().settings.lookProvider).toBe(p.id);
    swarm.updateSettings({ lookProvider: null });
    expect(swarm.snapshot().settings.lookProvider).toBeNull();
  });

  it('refuses an id that is not a known custom provider', async () => {
    const { swarm } = await office();
    expect(() => swarm.updateSettings({ lookProvider: 'no-such-provider' })).toThrowError(/no-such-provider/i);
  });

  it('is cleared when the provider it points at is deleted', async () => {
    const { swarm } = await office();
    const p = swarm.createProvider({ name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: 'sk-demo', model: 'qwen-27b' });
    swarm.updateSettings({ lookProvider: p.id });
    swarm.deleteProvider(p.id);
    expect(swarm.snapshot().settings.lookProvider).toBeNull();
  });
});
