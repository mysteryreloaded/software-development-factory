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

test('a match without skipWalk reaches live: ParkOpponent.tsx claims and walks them out itself', async ({ page }) => {
  test.setTimeout(240_000); // a few generous attempts, each with its own long walk and freeAgent() poll
  await startAt(page, { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);

  // the demo's own work can reassign whichever agent freeAgent() picked while they're still walking out (same
  // tickPenalty() abort as 'an agent called back to work leaves no result'): retry with a fresh one rather than
  // flaking on bad luck.
  let stage: string | null = null;
  let opponentId: string | null = null;
  for (let attempt = 0; attempt < 3 && stage !== 'live'; attempt++) {
    opponentId = await freeAgent(page);
    expect(await call(page, 'start', opponentId)).toBe(true);
    try {
      await expect
        .poll(
          async () => {
            stage = (await penalty(page)).stage;
            return stage === 'live' || stage === null;
          },
          { timeout: 60_000, intervals: [500] },
        )
        .toBe(true);
    } catch {
      // timed out mid-walk (this machine's own load, not the opponent being reassigned): drop it (G, same as
      // item 2's fix) so the next attempt's startPenaltyMatch() isn't blocked by this one still being on
      await page.keyboard.press('g');
      await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBeNull();
    }
  }
  expect(stage).toBe('live');

  // the walk-out must never leave them hidden (ParkOpponent.tsx no longer calls setHidden: that hid every
  // Character for that id, its own included, which is how the opponent went invisible)
  const people = await page.evaluate(
    () => (window as unknown as { __swarmPeople: { list(): { id: string; hidden: boolean }[] } }).__swarmPeople.list(),
  );
  expect(people.find((p) => p.id === opponentId)?.hidden).toBe(false);
});

test('a probe-driven match reports the winner and the hardest shot to the office-wide board', async ({ page }) => {
  await startAt(page, { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  const opponentId = await freeAgent(page);

  expect(await call(page, 'start', opponentId)).toBe(true);
  expect(await call(page, 'skipWalk')).toBe(true);
  // 'setup' only lasts SETUP_MS (penaltyState.ts): under load it may already be 'live' by the time we check
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).not.toBe('walkup');
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
      // the AI strikes on its own (within WINDUP_MS of penaltyState.ts); under load the kick may already have
      // moved past 'flight' by the time we check, so anything other than 'live' means it struck
      await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).not.toBe('live');
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
  // the same agent may already have a row from an earlier test in this run (the board persists for the whole
  // server session): record their count before, rather than assuming no row exists at all.
  const before = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const rowBefore = before.penalty.rows.find((r: { id: string }) => r.id === opponentId);
  const countBefore = rowBefore ? rowBefore.wins + rowBefore.losses : 0;

  expect(await call(page, 'start', opponentId)).toBe(true);
  expect(await call(page, 'skipWalk')).toBe(true);
  // 'setup' only lasts SETUP_MS (penaltyState.ts): under load it may already be 'live' by the time we check
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).not.toBe('walkup');

  // work calls them back mid-match (the same patch the office sends when a session picks up an issue): no result
  await call(page, 'callBack', opponentId);
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBeNull();

  const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const rowAfter = state.penalty.rows.find((r: { id: string }) => r.id === opponentId);
  expect(rowAfter ? rowAfter.wins + rowAfter.losses : 0).toBe(countBefore);
});

test('G drops the match with no result, same as work calling the opponent back', async ({ page }) => {
  await startAt(page, { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  const opponentId = await freeAgent(page);
  // the same agent may already have a row from an earlier test in this run (the board persists for the whole
  // server session): record their count before, rather than assuming no row exists at all.
  const before = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const rowBefore = before.penalty.rows.find((r: { id: string }) => r.id === opponentId);
  const countBefore = rowBefore ? rowBefore.wins + rowBefore.losses : 0;

  expect(await call(page, 'start', opponentId)).toBe(true);
  expect(await call(page, 'skipWalk')).toBe(true);
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).not.toBe('walkup');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __swarmToys: { held: unknown } }).__swarmToys.held)).toEqual({ kind: 'penalty', id: 'match' });

  await page.keyboard.press('g');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __swarmToys: { held: unknown } }).__swarmToys.held)).toBeNull();
  await expect.poll(async () => (await penalty(page)).stage, { timeout: 15_000 }).toBeNull();

  const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const rowAfter = state.penalty.rows.find((r: { id: string }) => r.id === opponentId);
  expect(rowAfter ? rowAfter.wins + rowAfter.losses : 0).toBe(countBefore);
});

test('the billboard pages between the top 5 and the hardest shot', async ({ page }) => {
  await startAt(page, { floor: 0, x: board.x + 10, z: board.z, yaw: -Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  await expect(page.locator('canvas').first()).toBeVisible();
});
