import { GROUNDS } from '../client/src/world/outside/grounds';
import { HALF_W, SIDE_OPENINGS, WALL_T } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test } from './helpers';

// The lobby's grounds (#41): out through the west revolving door onto the plaza, across the paved street, to the
// fenced park next door. Keys only (no pointer lock headless). window.__swarmOutside (world/doors.ts) reports the
// player's spot and the revolving door's live angle and speed.

interface Outside {
  floor: number;
  x: number;
  z: number;
  out: boolean;
  revolving: { angle: number; speed: number };
}

const outsideOf = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __swarmOutside: Outside }).__swarmOutside);

const door = SIDE_OPENINGS.lobby.west.door;
const wall = -(HALF_W + WALL_T / 2);
// inside the lobby, facing the west door (yaw π/2 faces -x)
const START = { floor: 0, x: wall + 3, z: door, yaw: Math.PI / 2, pitch: 0 };

test('walks out through the spinning door onto the grounds, and back in', async ({ page }) => {
  await startAt(page, START);
  await enterOffice(page);

  await expect.poll(async () => (await outsideOf(page)).floor, { timeout: 60_000 }).toBe(0);

  // out: the wings spin up as you walk through, and you clear the building
  const seenSpeed: number[] = [];
  await page.keyboard.down('w');
  try {
    await expect
      .poll(
        async () => {
          const o = await outsideOf(page);
          seenSpeed.push(o.revolving.speed);
          return o.x;
        },
        { message: 'walking out onto the grounds', timeout: 60_000, intervals: [100] },
      )
      .toBeLessThan(-16.5);
  } finally {
    await page.keyboard.up('w');
  }
  expect(Math.max(...seenSpeed)).toBeGreaterThan(0);
  expect((await outsideOf(page)).out).toBe(true);

  // it coasts to a stop once you've left
  await expect.poll(async () => (await outsideOf(page)).revolving.speed, { timeout: 55_000 }).toBeLessThan(0.1);

  // and back in, backwards
  await page.keyboard.down('s');
  try {
    await expect
      .poll(async () => (await outsideOf(page)).out, { message: 'walking back in', timeout: 60_000, intervals: [100] })
      .toBe(false);
  } finally {
    await page.keyboard.up('s');
  }
});

test('running through the door spins the wings faster than walking', async ({ page }) => {
  await startAt(page, START);
  await enterOffice(page);
  await expect.poll(async () => (await outsideOf(page)).floor, { timeout: 60_000 }).toBe(0);

  const walkPeak = { v: 0 };
  await page.keyboard.down('w');
  try {
    await expect
      .poll(
        async () => {
          const o = await outsideOf(page);
          walkPeak.v = Math.max(walkPeak.v, o.revolving.speed);
          return o.x;
        },
        { timeout: 60_000, intervals: [50] },
      )
      .toBeLessThan(-16.5);
  } finally {
    await page.keyboard.up('w');
  }

  // back in, then run straight out
  await page.keyboard.down('s');
  await expect.poll(async () => (await outsideOf(page)).out, { timeout: 60_000 }).toBe(false);
  await page.keyboard.up('s');
  await expect.poll(async () => (await outsideOf(page)).revolving.speed, { timeout: 55_000 }).toBeLessThan(0.1);

  const runPeak = { v: 0 };
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  try {
    await expect
      .poll(
        async () => {
          const o = await outsideOf(page);
          runPeak.v = Math.max(runPeak.v, o.revolving.speed);
          return o.x;
        },
        { timeout: 60_000, intervals: [50] },
      )
      .toBeLessThan(-16.5);
  } finally {
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
  }
  expect(runPeak.v).toBeGreaterThan(walkPeak.v);
});

test('the fence and the plaza edge stop you; the park and the paved street never do', async ({ page }) => {
  // start already out on the plaza, well clear of the door, facing west towards the park
  await startAt(page, { floor: 0, x: wall - 4, z: door, yaw: Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  await expect.poll(async () => (await outsideOf(page)).out, { timeout: 60_000 }).toBe(true);

  await page.keyboard.down('w');
  try {
    await expect
      .poll(async () => (await outsideOf(page)).x, { message: 'walking west to the fence', timeout: 60_000, intervals: [100] })
      .toBeLessThan(GROUNDS.minX + 1);
  } finally {
    await page.keyboard.up('w');
  }
  // settle, then confirm it holds: a little more W doesn't push past the fence
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down('w');
    await page.waitForTimeout(50);
    await page.keyboard.up('w');
  }
  expect((await outsideOf(page)).x).toBeGreaterThanOrEqual(GROUNDS.minX - 0.5);
});

test('the plaza edge stops you walking north, well short of the street', async ({ page }) => {
  // out on the plaza, north of the building, facing north (yaw 0). outsideAt() only tracks the east/west
  // sides (the north wall has no door of its own), so there's no "out" flag to wait for here: just the floor.
  await startAt(page, { floor: 0, x: 0, z: -(16 + 2), yaw: 0, pitch: 0 });
  await enterOffice(page);
  await expect.poll(async () => (await outsideOf(page)).floor, { timeout: 60_000 }).toBe(0);

  await page.keyboard.down('w');
  try {
    await expect
      .poll(async () => (await outsideOf(page)).z, { message: 'walking north to the plaza edge', timeout: 60_000, intervals: [100] })
      .toBeLessThan(GROUNDS.minZ + 1);
  } finally {
    await page.keyboard.up('w');
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down('w');
    await page.waitForTimeout(50);
    await page.keyboard.up('w');
  }
  const z = (await outsideOf(page)).z;
  expect(z).toBeGreaterThanOrEqual(GROUNDS.minZ - 0.5);
  expect(z).toBeLessThan(-16); // stops well short of the street beyond, never reaching it
});

test('shows the park and the building from outside', async ({ page }) => {
  // in the park, facing +x (yaw -π/2), back towards the building
  await startAt(page, { floor: 0, x: -60, z: 0, yaw: -Math.PI / 2, pitch: 0 });
  await enterOffice(page);
  await page.waitForTimeout(300);
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/grounds-park-view.png' });
});
