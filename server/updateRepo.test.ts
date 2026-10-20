import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// The CEO code review is a per-floor setting like autoMerge: off by default, changed through updateRepo,
// and shown in the repo view. (issue #9, part 1/3)
type Internals = {
  state: { repos: Array<{ id: string; ceoReview: boolean }> };
};

describe('updateRepo', () => {
  async function office() {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    return { swarm, internals: swarm as unknown as Internals };
  }

  it('is off for a new floor', async () => {
    const { swarm, internals } = await office();
    expect(swarm.updateRepo('demo-co/pixel-todo', {}).ceoReview).toBe(false);
    expect(internals.state.repos.map((r) => r.ceoReview)).toEqual([false]);
  });

  it('stores the switch and shows it in the repo view', async () => {
    const { swarm, internals } = await office();
    expect(swarm.updateRepo('demo-co/pixel-todo', { ceoReview: true }).ceoReview).toBe(true);
    expect(internals.state.repos.map((r) => r.ceoReview)).toEqual([true]);
    expect(swarm.updateRepo('demo-co/pixel-todo', { ceoReview: false }).ceoReview).toBe(false);
    expect(internals.state.repos.map((r) => r.ceoReview)).toEqual([false]);
  });
});
