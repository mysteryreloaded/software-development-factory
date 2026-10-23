import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// Releasing held issues frees a whole floor at once instead of a hand assign per issue (issue #92, part 2/2).
type Internals = {
  state: { held: { repoId: string; issue: number; pr: number }[] };
  readyIssues(repo: { id: string }): { issue: { number: number } }[];
  repo(id: string): { id: string };
};

describe('releaseHeld', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    await swarm.connectRepo('demo-co/weather-api');
    await swarm.syncRepo('demo-co/pixel-todo');
    await swarm.syncRepo('demo-co/weather-api');
    const internals = swarm as unknown as Internals;
    internals.state.held.push(
      { repoId: 'demo-co/pixel-todo', issue: 1, pr: 10 },
      { repoId: 'demo-co/pixel-todo', issue: 2, pr: 10 },
      { repoId: 'demo-co/weather-api', issue: 1, pr: 20 },
    );
    return { swarm, internals };
  }

  it('clears every held entry on that floor and counts them', async () => {
    const { swarm, internals } = await office();
    expect(swarm.releaseHeld('demo-co/pixel-todo')).toBe(2);
    expect(internals.state.held).toEqual([{ repoId: 'demo-co/weather-api', issue: 1, pr: 20 }]);
  });

  it('leaves other floors untouched', async () => {
    const { swarm, internals } = await office();
    swarm.releaseHeld('demo-co/pixel-todo');
    expect(internals.state.held.some((h) => h.repoId === 'demo-co/weather-api')).toBe(true);
  });

  it('returns 0 and changes nothing when the floor has no held issues', async () => {
    const { swarm, internals } = await office();
    expect(swarm.releaseHeld('demo-co/weather-api')).toBe(1);
    const before = internals.state.held.length;
    expect(swarm.releaseHeld('demo-co/weather-api')).toBe(0);
    expect(internals.state.held.length).toBe(before);
  });

  it('lets the scheduler pick up a released issue again', async () => {
    const { swarm, internals } = await office();
    const repo = internals.repo('demo-co/pixel-todo');
    expect(internals.readyIssues(repo).map((r) => r.issue.number)).not.toContain(1);
    swarm.releaseHeld('demo-co/pixel-todo');
    expect(internals.readyIssues(repo).map((r) => r.issue.number)).toContain(1);
  });
});
