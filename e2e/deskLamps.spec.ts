import type { Page } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Desk lamps (#52): a pendant lamp lights up over every busy agent's desk, with a warm pool round it, so the manager
// can count the busy desks at a glance. window.__swarmDeskLamps (world/DeskLamp.tsx) reports which desk slots have a
// lamp mounted and the team sign's busy count.

interface DeskLamps {
  lit: number[];
  busy: number;
}

const lamps = (page: Page) => page.evaluate(() => (window as unknown as { __swarmDeskLamps: DeskLamps }).__swarmDeskLamps);

// Floor 1, on the open wood floor facing the front desk row.
const SPOT: SavedView = { floor: 1, x: -4, z: 8.5, yaw: 0, pitch: -0.1 };

test('lights up over the busy desks, matching the sign, first person and from the overview', async ({ page }, testInfo) => {
  await startAt(page, SPOT);
  await enterOffice(page);

  await expect.poll(async () => (await lamps(page)).lit.length, { timeout: 60_000, message: 'a desk lamp lit' }).toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => {
      const l = await lamps(page);
      return l.lit.length === l.busy ? 'match' : `${l.lit.length} lit vs ${l.busy} busy`;
    }, { timeout: 60_000 })
    .toBe('match');

  await page.screenshot({ path: testInfo.outputPath('deskLamps-first-person.png') });

  await page.keyboard.press('Tab');
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __swarmCamera: { state: () => { mode: string; flying: boolean } } }).__swarmCamera.state())).mode, { timeout: 60_000 }).toBe('overview');
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __swarmCamera: { state: () => { mode: string; flying: boolean } } }).__swarmCamera.state())).flying, { timeout: 60_000 }).toBe(false);

  await page.screenshot({ path: testInfo.outputPath('deskLamps-overview.png') });
});
