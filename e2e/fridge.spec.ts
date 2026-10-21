import { HALF_W } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The kitchenette's fridge and freezer: opening the doors, taking and eating a snack a portion at a time, putting an
// untouched one back, the shelves restocking, and a held ice cream melting into a puddle.

type ToysProbe = { held: { kind: string; left?: number; snack?: string } | null; sipping: boolean };
type FridgeProbe = { fridgeOpen: boolean; freezerOpen: boolean; stock: Record<string, number>; puddles: { x: number; z: number }[] };

const toys = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __swarmToys: ToysProbe }).__swarmToys);
const fridge = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __swarmFridge: FridgeProbe }).__swarmFridge);
const act = (page: import('@playwright/test').Page, op: string, arg?: string | number) =>
  page.evaluate(([o, a]) => (window as unknown as { __swarmFridgeDo(op: string, arg?: string | number): void }).__swarmFridgeDo(o as string, a as string | number), [op, arg] as const);

/** Presses E, waits for the portion to actually come off (`left`, or null once it's the last one and gone), then
 * for the animation to finish. Polling `left` first (not just `sipping`) avoids a race: right after the keypress,
 * sipping may still read false because the frame that starts it hasn't run yet. */
async function eat(page: import('@playwright/test').Page, left: number | null) {
  await page.keyboard.press('e');
  if (left === null) await expect.poll(async () => (await toys(page)).held).toBeNull();
  else await expect.poll(async () => (await toys(page)).held).toMatchObject({ left });
  await expect.poll(async () => (await toys(page)).sipping).toBe(false);
}

// Floor 1's kitchenette (east wall): stand west of the fridge, facing east (+x), looking a little down at its door.
const FRIDGE_SPOT: SavedView = { floor: 1, x: HALF_W - 1.65, z: 9.45, yaw: -Math.PI / 2, pitch: -0.4 };

test('aiming at the fridge and pressing E opens it', async ({ page }) => {
  await startAt(page, FRIDGE_SPOT);
  await enterOffice(page);
  await expect(page.getByText('Open the fridge')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('e');
  await expect.poll(async () => (await fridge(page)).fridgeOpen).toBe(true);
  await expect(page.getByText('Close the fridge')).toBeVisible();
  await page.keyboard.press('e');
  await expect.poll(async () => (await fridge(page)).fridgeOpen).toBe(false);
});

test('a protein bar is three bites, then gone with no puddle', async ({ page }) => {
  // Away from the fridge, so E eats the snack instead of working the door.
  await enterOffice(page);
  await act(page, 'take', 'bar');
  await expect.poll(async () => (await toys(page)).held).toMatchObject({ kind: 'snack', snack: 'bar', left: 3 });
  const before = (await fridge(page)).puddles.length;
  for (const left of [2, 1, null]) await eat(page, left);
  expect((await fridge(page)).puddles.length).toBe(before);
});

test('water is four sips', async ({ page }) => {
  await enterOffice(page);
  await act(page, 'take', 'water');
  await expect.poll(async () => (await toys(page)).held).toMatchObject({ kind: 'snack', snack: 'water', left: 4 });
  for (const left of [3, 2, 1, null]) await eat(page, left);
});

test('ice cream left too long melts into a puddle', async ({ page }) => {
  await enterOffice(page);
  await act(page, 'take', 'icecream');
  await expect.poll(async () => (await toys(page)).held).toMatchObject({ kind: 'snack', snack: 'icecream' });
  const before = (await fridge(page)).puddles.length;
  await act(page, 'age', 61);
  await expect.poll(async () => (await toys(page)).held, { timeout: 10_000 }).toBeNull();
  expect((await fridge(page)).puddles.length).toBe(before + 1);
});

test('a dropped ice cream becomes a puddle; a dropped bar is just gone', async ({ page }) => {
  await enterOffice(page);
  await act(page, 'take', 'icecream');
  const before = (await fridge(page)).puddles.length;
  await page.keyboard.press('g');
  await expect.poll(async () => (await toys(page)).held).toBeNull();
  await expect.poll(async () => (await fridge(page)).puddles.length).toBe(before + 1);

  await act(page, 'take', 'bar');
  await page.keyboard.press('g');
  await expect.poll(async () => (await toys(page)).held).toBeNull();
  expect((await fridge(page)).puddles.length).toBe(before + 1); // unchanged
});

test('an empty shelf is refused, and restocks one at a time', async ({ page }) => {
  await enterOffice(page);
  const stock = async () => (await fridge(page)).stock.candy;
  const full = await stock();
  for (let i = 0; i < full; i++) {
    await act(page, 'take', 'candy');
    await expect.poll(async () => (await toys(page)).held).toMatchObject({ kind: 'snack', snack: 'candy' });
    await eat(page, null); // candy is one go
  }
  await expect.poll(stock).toBe(0);
  await act(page, 'take', 'candy'); // refused: nothing to hold
  expect(await toys(page)).toMatchObject({ held: null });
  await act(page, 'age', 60);
  await expect.poll(stock).toBe(1);
});

test('an untouched snack goes back on the shelf', async ({ page }) => {
  await enterOffice(page);
  const before = (await fridge(page)).stock.bar;
  await act(page, 'take', 'bar');
  await expect.poll(async () => (await fridge(page)).stock.bar).toBe(before - 1);
  await act(page, 'putBack');
  await expect.poll(async () => (await toys(page)).held).toBeNull();
  await expect.poll(async () => (await fridge(page)).stock.bar).toBe(before);
});

test('eating and dropping a snack only makes sounds in the toys group', async ({ page }) => {
  await enterOffice(page);
  type Sfx = { name: string; group: string | null };
  const sounds = () => page.evaluate(() => (window as unknown as { __swarmSfx: Sfx[] }).__swarmSfx);
  await act(page, 'take', 'icecream');
  await eat(page, 2);
  await page.keyboard.press('g'); // the rest melts into a puddle, with a splat
  await expect.poll(async () => (await toys(page)).held).toBeNull();
  const heard = (await sounds()).filter((s) => s.name.startsWith('fridge-') || s.name.startsWith('snack-'));
  expect(heard.length).toBeGreaterThan(0);
  expect(heard.every((s) => s.group === 'toys')).toBe(true);
});
