import type { Page } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Jukebox power (#55): volume 0 is off (silent, still, unlit), and every jukebox starts off when the office opens.
// Pressed via __swarmJukeboxDo, since pointer lock doesn't work headless.

interface Still {
  neon: string;
  record: number;
  bounce: number;
  window: boolean;
}
interface Snapshot {
  on: boolean;
  floor: number | null;
  volume: number | null;
  time: number | null;
  nodes: { chain: number; notes: number };
  still: Still;
}

const jukebox = (page: Page) => page.evaluate(() => (window as unknown as { __swarmJukebox: Snapshot }).__swarmJukebox);
const press = (page: Page, op: string) => page.evaluate((o) => (window as unknown as { __swarmJukeboxDo(op: string): void }).__swarmJukeboxDo(o), op);

/** Rides the elevator to floor `n` (the roof's own probe rides it to any floor) and waits for the jukebox to follow. */
async function goToFloor(page: Page, n: number) {
  // go() is dropped while the store is mid-travel (client/src/store.ts), so poll-and-repeat until it lands.
  await expect
    .poll(
      async () => {
        await page.evaluate((f) => (window as unknown as { __swarmRoof: { go(n: number): void } }).__swarmRoof.go(f), n);
        return (await jukebox(page)).floor;
      },
      { timeout: 15000 },
    )
    .toBe(n);
  await expect(page.locator('.fade-label')).toHaveCount(0);
}

const spot: SavedView = { floor: 1, x: 0, z: -7, yaw: 0, pitch: 0.15 };

test('a fresh office is off, silent and still on every floor', async ({ page }) => {
  await startAt(page, spot);
  await enterOffice(page);

  for (const floor of [1, 0]) {
    if (floor !== 1) await goToFloor(page, floor);
    const j = await jukebox(page);
    expect(j.floor).toBe(floor);
    expect(j.on).toBe(false);
    expect(j.volume).toBe(0);
    expect(j.time).toBeNull();
    expect(j.nodes.chain).toBe(0);
    const before = j.still;
    await page.waitForTimeout(2000);
    expect((await jukebox(page)).still).toEqual(before);
  }
});

test('+ turns it on, - turns it off, the power button restores the last level', async ({ page }) => {
  await startAt(page, spot);
  await enterOffice(page);

  await press(page, 'vol+');
  let j = await jukebox(page);
  expect(j.on).toBe(true);
  expect(j.volume).toBe(1);
  await expect.poll(async () => (await jukebox(page)).time).not.toBeNull();
  const t1 = (await jukebox(page)).time!;
  await page.waitForTimeout(300);
  expect((await jukebox(page)).time!).toBeGreaterThan(t1);

  await press(page, 'vol-');
  j = await jukebox(page);
  expect(j.on).toBe(false);
  expect(j.volume).toBe(0);
  expect(j.nodes.chain).toBe(0);
  const still = j.still;
  await page.waitForTimeout(500);
  expect((await jukebox(page)).still).toEqual(still);

  await press(page, 'toggle');
  j = await jukebox(page);
  expect(j.on).toBe(true);
  expect(j.volume).toBe(1); // the last level it played at
});

test('reload starts it off again, even after it was turned on', async ({ page }) => {
  await startAt(page, spot);
  await enterOffice(page);
  await press(page, 'vol+');
  expect((await jukebox(page)).on).toBe(true);

  await page.reload();
  await enterOffice(page, { loaded: true });
  const j = await jukebox(page);
  expect(j.on).toBe(false);
  expect(j.volume).toBe(0);
});

test('turning it on stays on this floor only, and doesn’t follow you to another', async ({ page }) => {
  await startAt(page, spot);
  await enterOffice(page);
  await press(page, 'vol+');
  expect((await jukebox(page)).on).toBe(true);

  await goToFloor(page, 0);
  expect((await jukebox(page)).on).toBe(false); // the lobby's own jukebox, still off

  await goToFloor(page, 1);
  expect((await jukebox(page)).on).toBe(true); // floor 1's jukebox, still on
});
