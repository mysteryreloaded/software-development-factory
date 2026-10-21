import { BALCONY, BALCONY_OUT, PLAYER_RADIUS, ROOF, ROOF_EDGE, SMOKE_TABLE, sideSign } from '../client/src/world/layout';
import { LIGHT_MS, PUFFS, PUFF_MS, ROLL_MS, nook } from '../client/src/world/smokeBreak';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The smoke break (#57): a little table in the gap beyond every balcony bench, and on the roof. Driven through the
// probe (world/smokeBreak.ts's window.__swarmSmokeBreak / __swarmSmokeBreakDo), since the stage machine's timings
// (a roll, a light, eight puffs) are real seconds, not frames; sitting down and one puff go through the real E key,
// and walking both gaps (bench-table, table-rail) through real movement keys too.

interface SmokeProbe {
  nooks: { id: string; seats: ['free' | 'you', 'free' | 'you']; butts: number }[];
  me: { nook: string; seat: 0 | 1; stage: string; puffsLeft: number; lit: boolean } | null;
}

interface CameraProbe {
  state(): { pose: { x: number; z: number } };
}

type Page = import('@playwright/test').Page;

const probe = (page: Page) => page.evaluate(() => (window as unknown as { __swarmSmokeBreak: SmokeProbe }).__swarmSmokeBreak);
const doIt = (page: Page, action: 'sit' | 'roll' | 'light' | 'puff' | 'up', nookId?: string) =>
  page.evaluate(([a, n]) => (window as unknown as { __swarmSmokeBreakDo: (a: string, n?: string) => void }).__swarmSmokeBreakDo(a, n), [action, nookId] as const);
const pose = async (page: Page) => (await page.evaluate(() => (window as unknown as { __swarmCamera: CameraProbe }).__swarmCamera.state().pose));

const PLACES: { name: string; id: 'office-west' | 'roof'; floor: number }[] = [
  { name: 'floor 1 west', id: 'office-west', floor: 1 },
  { name: 'the roof', id: 'roof', floor: ROOF },
];

/** Past the table's shorter ends (it's half the bench's length), far enough that a step across to the rail doesn't
 * clip its corner (PLAYER_RADIUS), with a little to spare before the bench's own end. */
const TABLE_CLEAR = SMOKE_TABLE.l / 2 + PLAYER_RADIUS + 0.1;

/** The table-rail (or, on the roof, table-parapet) gap: the same width as the bench-table one, on the far side of
 * the table. Its x, centred between the table and the rail's inner face. */
function railGapX(id: 'office-west' | 'roof') {
  const n = nook(id);
  if (id === 'roof') return (n.table.maxX + (ROOF_EDGE.x - ROOF_EDGE.t)) / 2;
  const s = sideSign('west');
  const railInner = s * (BALCONY_OUT - BALCONY.railT);
  return (n.table.minX + railInner) / 2;
}

/** Holds a movement key until `axis` ('x' or 'z') reaches `to`, picking whichever of `keys` actually closes the
 * distance (A/D's or W/S's sense of x/z flips with the view's yaw, which differs between west, east and the roof). */
async function travel(page: Page, axis: 'x' | 'z', to: number, keys: readonly [string, string]) {
  const read = async () => (await pose(page))[axis];
  let key = keys[0];
  for (const tryKey of keys) {
    // Each key's own starting point, not the overall one: trying the first key can itself move you, and judging the
    // second key against a stale "before" (further away now) makes a key that's actually closing the distance look
    // like it isn't.
    const from = await read();
    await page.keyboard.down(tryKey);
    const moved = await page
      .waitForFunction(([a, startV]) => Math.abs((window as unknown as { __swarmCamera: CameraProbe }).__swarmCamera.state().pose[a as 'x' | 'z'] - startV) > 0.2, [axis, from] as const, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.up(tryKey);
    const now = await read();
    if (moved && Math.abs(now - to) < Math.abs(from - to)) {
      key = tryKey;
      break;
    }
  }
  await page.keyboard.down(key);
  try {
    await expect.poll(async () => Math.abs((await read()) - to), { message: `travelling ${axis} to ${to.toFixed(2)}`, timeout: 60_000, intervals: [100] }).toBeLessThan(0.3);
  } finally {
    await page.keyboard.up(key);
  }
}

for (const place of PLACES) {
  test(`smoke break on ${place.name}: sit, roll, light and puff it out`, async ({ page }) => {
    test.setTimeout(180_000); // a full roll/light/8-puff session plus three real walks, in software-rendered Chromium
    const n = nook(place.id);
    const gap = { x: (n.gap.minX + n.gap.maxX) / 2, z: (n.gap.minZ + n.gap.maxZ) / 2 };
    const start: SavedView = { floor: place.floor, x: gap.x, z: gap.z, yaw: n.yaw, pitch: 0 };
    await startAt(page, start);
    await enterOffice(page);

    // standing in the gap: "Sit down" whatever you're aiming at, and E really does sit you down
    await expect(page.getByText('Sit down')).toBeVisible({ timeout: 90_000 });
    await page.keyboard.press('e');
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

    // the first puff, with the real E key, mid-exhale shot for the PR
    await page.keyboard.press('e');
    await expect.poll(async () => (await probe(page)).me?.stage).toBe('puffing');
    await page.screenshot({ path: test.info().outputPath(`smoke-${place.id}-exhale.png`) });
    await expect.poll(async () => (await probe(page)).me?.puffsLeft, { timeout: PUFF_MS + 10000 }).toBe(PUFFS - 1);
    expect((await probe(page)).me?.stage).toBe('lit');

    for (let left = PUFFS - 1; left > 1; left--) {
      await doIt(page, 'puff');
      await expect.poll(async () => (await probe(page)).me?.stage).toBe('puffing');
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

    // walk both gaps: along the bench-table one to a point clear of the table, across to the table-rail one (or, on
    // the roof, table-parapet), and back along its length
    const bz = (n.gap.minZ + n.gap.maxZ) / 2;
    await travel(page, 'z', bz + TABLE_CLEAR, ['a', 'd']);
    expect(Math.abs((await pose(page)).x - gap.x)).toBeLessThan(0.5); // the gap kept you in its own narrow lane
    const railX = railGapX(place.id);
    await travel(page, 'x', railX, ['w', 's']); // clear of the table at this z, past its shorter ends
    await travel(page, 'z', bz - TABLE_CLEAR, ['a', 'd']);
    expect(Math.abs((await pose(page)).x - railX)).toBeLessThan(0.5);
  });
}
