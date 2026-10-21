import { ROOF } from '../client/src/world/layout';
import { LIGHT_MS, PUFFS, PUFF_MS, ROLL_MS, nook } from '../client/src/world/smokeBreak';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The smoke break (#57): a little table in the gap beyond every balcony bench, and on the roof. Driven through the
// probe (world/smokeBreak.ts's window.__swarmSmokeBreak / __swarmSmokeBreakDo), since the stage machine's timings
// (a roll, a light, eight puffs) are real seconds, not frames.

interface SmokeProbe {
  nooks: { id: string; seats: ['free' | 'you', 'free' | 'you']; butts: number }[];
  me: { nook: string; seat: 0 | 1; stage: string; puffsLeft: number; lit: boolean } | null;
}

const probe = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __swarmSmokeBreak: SmokeProbe }).__swarmSmokeBreak);
const doIt = (page: import('@playwright/test').Page, action: 'sit' | 'roll' | 'light' | 'puff' | 'up', nookId?: string) =>
  page.evaluate(([a, n]) => (window as unknown as { __swarmSmokeBreakDo: (a: string, n?: string) => void }).__swarmSmokeBreakDo(a, n), [action, nookId] as const);

const PLACES: { name: string; id: 'office-west' | 'roof'; floor: number }[] = [
  { name: 'floor 1 west', id: 'office-west', floor: 1 },
  { name: 'the roof', id: 'roof', floor: ROOF },
];

for (const place of PLACES) {
  test(`smoke break on ${place.name}: sit, roll, light and puff it out`, async ({ page }) => {
    const n = nook(place.id);
    const gap = { x: (n.gap.minX + n.gap.maxX) / 2, z: (n.gap.minZ + n.gap.maxZ) / 2 };
    const start: SavedView = { floor: place.floor, x: gap.x, z: gap.z, yaw: n.yaw, pitch: 0 };
    await startAt(page, start);
    await enterOffice(page);

    // standing in the gap: "Sit down" whatever you're aiming at
    await expect(page.getByText('Sit down')).toBeVisible({ timeout: 90_000 });
    await doIt(page, 'sit', place.id);
    await expect.poll(async () => (await probe(page)).me?.nook).toBe(place.id);
    expect((await probe(page)).me).toMatchObject({ seat: 0, stage: 'empty', lit: false });
    await expect(page.getByText('Roll one')).toBeVisible();

    await doIt(page, 'roll');
    await expect.poll(async () => (await probe(page)).me?.stage).toBe('rolling');
    await expect.poll(async () => (await probe(page)).me?.stage, { timeout: ROLL_MS + 10000 }).toBe('ready');
    await expect(page.getByText('Light it')).toBeVisible();

    await doIt(page, 'light');
    await expect.poll(async () => (await probe(page)).me?.stage).toBe('lighting');
    await expect.poll(async () => (await probe(page)).me?.stage, { timeout: LIGHT_MS + 10000 }).toBe('lit');
    expect((await probe(page)).me).toMatchObject({ lit: true, puffsLeft: PUFFS });
    await expect(page.getByText(`Take a puff · ${PUFFS} left`)).toBeVisible();

    for (let left = PUFFS; left > 1; left--) {
      await doIt(page, 'puff');
      await expect.poll(async () => (await probe(page)).me?.stage).toBe('puffing');
      if (left === PUFFS) await page.screenshot(); // mid-exhale, for the PR's screenshots
      await expect.poll(async () => (await probe(page)).me?.puffsLeft, { timeout: PUFF_MS + 10000 }).toBe(left - 1);
      expect((await probe(page)).me?.stage).toBe('lit');
    }

    const before = (await probe(page)).nooks.find((x) => x.id === place.id)!.butts;
    await doIt(page, 'puff'); // the last one
    await expect.poll(async () => (await probe(page)).me?.stage, { timeout: PUFF_MS + 10000 }).toBe('empty');
    expect((await probe(page)).me).toMatchObject({ stage: 'empty', puffsLeft: PUFFS, lit: false });
    expect((await probe(page)).nooks.find((x) => x.id === place.id)!.butts).toBe(before + 1);

    // stand up part-way through another one: it stubs into the ashtray too
    await doIt(page, 'roll');
    await expect.poll(async () => (await probe(page)).me?.stage, { timeout: ROLL_MS + 10000 }).toBe('ready');
    await doIt(page, 'up');
    await expect.poll(async () => (await probe(page)).me).toBeNull();
    expect((await probe(page)).nooks.find((x) => x.id === place.id)!.butts).toBe(before + 2);
  });
}
