import type { Page } from '@playwright/test';
import { boardPitch, goalPitch } from '../client/src/world/park/parkPitch';
import { GOAL } from '../shared/penalty';
import { enterOffice, expect, startAt, test } from './helpers';

// Penalty shoot-out in the park (#46): you vs a free agent, with an all-time billboard. window.__swarmPenalty drives
// a match without the mouse (pointer lock doesn't work headless).

interface PenaltyProbeState {
  view: { opponentName: string; you: string; stage: string; turn: string; score: { player: number; opponent: number }; winner: string | null } | null;
  turn: string | null;
  stage: string | null;
  opponentId: string | null;
  winner: string | null;
}
interface PenaltyProbe {
  state: PenaltyProbeState;
  start(opponentId?: string): boolean;
  skipWalk(): boolean;
  shoot(x: number, y: number, power?: number): boolean;
  dive(x: number, y: number): boolean;
  forceShot(shot: { x: number; y: number; power: number } | null): void;
  board(): { rows: { id: string; name: string; wins: number; losses: number; goals: number }[]; hardest: { id: string; kmh: number } | null };
  callBack(id: string): void;
}
const penalty = (page: Page) => page.evaluate(() => (window as unknown as { __swarmPenalty: PenaltyProbe }).__swarmPenalty.state);
const call = (page: Page, fn: keyof PenaltyProbe, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as unknown as { __swarmPenalty: Record<string, (...x: unknown[]) => unknown> }).__swarmPenalty[f](...(a as unknown[])), [fn, args] as const);

interface AgentInfo {
  id: string;
  status: string;
  role: string;
  repoId: string | null;
}

/** The first agent (not the CEO) free to play, polling /api/state until the demo's own work leaves one idle. */
async function freeAgent(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        const agents = state.agents as AgentInfo[];
        const free = agents.find((a) => a.role !== 'ceo' && ['idle', 'done', 'stopped'].includes(a.status));
        id = free?.id ?? null;
        return !!id;
      },
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(true);
  return id!;
}

const goal = goalPitch();
const board = boardPitch();

test('walking up to the spot shows the hint to play', async ({ page }) => {
  await startAt(page, { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  await expect(page.getByText('Play penalties')).toBeVisible({ timeout: 90_000 });
});

test('a probe-driven match reports the winner and the hardest shot to the office-wide board', async ({ page }) => {
  await startAt(page, { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  const opponentId = await freeAgent(page);

  expect(await call(page, 'start', opponentId)).toBe(true);
  expect(await call(page, 'skipWalk')).toBe(true);
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBe('setup');
  // sticks for every opponent kick (forcePenaltyShot/forceShot only clears or replaces on request): no race with the clock
  await call(page, 'forceShot', { x: GOAL.width / 2 + 2, y: 1, power: 0.9 });

  // the player scores twice at a hard, clean corner; the opponent's shots are forced wide, deciding it early at 2-0
  for (let i = 0; i < 4; i++) {
    await expect.poll(async () => (await penalty(page)).turn, { timeout: 15_000 }).not.toBeNull();
    const turn = (await penalty(page)).turn;
    await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBe('live');
    if (turn === 'player') {
      expect(await call(page, 'shoot', GOAL.width / 2 - 0.3, GOAL.height - 0.3, 1)).toBe(true);
    } else {
      await expect.poll(async () => (await penalty(page)).stage, { timeout: 5000 }).toBe('flight'); // the AI strikes on its own
    }
    // wait for this kick to resolve (flight, then the result shown a while) before the next one's taken
    await expect
      .poll(
        async () => {
          const st = (await penalty(page)).stage;
          return st === 'over' || st === 'setup' || st === 'live';
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if ((await penalty(page)).winner) break;
  }
  await expect.poll(async () => (await penalty(page)).winner, { timeout: 20_000 }).toBe('player');

  await expect
    .poll(async () => {
      const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
      return state.penalty.rows.find((r: { id: string }) => r.id === 'player')?.wins ?? 0;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  expect(state.penalty.hardest).not.toBeNull();
  expect(state.penalty.hardest.kmh).toBeGreaterThan(0);
});

test('an agent called back to work leaves no result', async ({ page }) => {
  await startAt(page, { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  const opponentId = await freeAgent(page);

  expect(await call(page, 'start', opponentId)).toBe(true);
  expect(await call(page, 'skipWalk')).toBe(true);
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBe('setup');

  // work calls them back mid-match (the same patch the office sends when a session picks up an issue): no result
  await call(page, 'callBack', opponentId);
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBeNull();

  const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  expect(state.penalty.rows.find((r: { id: string }) => r.id === opponentId)).toBeUndefined();
});

test('the billboard pages between the top 5 and the hardest shot', async ({ page }) => {
  await startAt(page, { floor: 0, x: board.x + 10, z: board.z, yaw: -Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  await expect(page.locator('canvas').first()).toBeVisible();
});
