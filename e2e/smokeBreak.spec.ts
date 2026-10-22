import { BALCONY, BALCONY_OUT, PLAYER_RADIUS, ROOF, ROOF_EDGE, SMOKE_TABLE, sideSign } from '../client/src/world/layout';
import { LIGHT_MS, NPC_SMOKE, PUFFS, PUFF_MS, ROLL_MS, nook } from '../client/src/world/smokeBreak';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The smoke break (#57): a little table in the gap beyond every balcony bench, and on the roof. Driven through the
// probe (world/smokeBreak.ts's window.__swarmSmokeBreak / __swarmSmokeBreakDo), since the stage machine's timings
// (a roll, a light, eight puffs) are real seconds, not frames; sitting down and one puff go through the real E key,
// and walking both gaps (bench-table, table-rail) through real movement keys too.

type SeatOwner = 'free' | 'you' | `agent:${string}`;

interface SmokeProbe {
  nooks: { id: string; seats: [SeatOwner, SeatOwner]; butts: number }[];
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
 * clip its corner (PLAYER_RADIUS) even at travel()'s worst case: its 0.3 m catch window means "there" can be up to
 * 0.3 m short of the actual target, so the real margin past the table needs PLAYER_RADIUS *and* that 0.3 m, plus a
 * little to spare. This overshoots the bench's own (shorter) end, but nothing stands past it to block the walk. */
const TABLE_CLEAR = SMOKE_TABLE.l / 2 + PLAYER_RADIUS + 0.3 + 0.1;

/** The table-rail (or, on the roof, table-parapet) gap, at 0.7 m the same width as the bench-table one: once the
 * table's and the rail's own PLAYER_RADIUS margins are subtracted, only about 0.1 m of it is clear of *both* at
 * once (collide() pads each rect by a full PLAYER_RADIUS on every side, not a rounded corner), far too little to
 * aim for with travel()'s 0.3 m catch window. Clear of the table only needs PLAYER_RADIUS past its edge, which the
 * rail itself already gives for free: walking until the rail stops you lands well past the table's edge too, so
 * target the rail's own stop, not a midpoint between the two. */
function railGapX(id: 'office-west' | 'roof') {
  if (id === 'roof') return ROOF_EDGE.x - ROOF_EDGE.t - PLAYER_RADIUS;
  const s = sideSign('west');
  const railInner = s * (BALCONY_OUT - BALCONY.railT);
  return railInner - s * PLAYER_RADIUS;
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
    // The 0.3 m catch window matters: closer than that and a tick's worth of walking (up to ~0.36 m at a 100 ms poll
    // interval) can step clean over a narrower one between two polls, so the key never gets released at all.
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

// ---------- an agent's own smoke break (#58): the errand, not the player ----------

interface DemoAgent {
  id: string;
  status: string;
  repoId: string;
}
interface DemoState {
  agents: DemoAgent[];
  repos: { id: string; floor: number }[];
}
interface OutsideProbe {
  doors: { west: { open: number }; east: { open: number } };
}

const FREE_STATUSES = new Set(['idle', 'done', 'stopped']);

/** Someone the errand can actually start for right now (errands.ts's `isFree`), and the floor they're on: read
 * straight from the real REST state (no browser needed), since the demo's own agents come and go on their own. */
async function aFreeAgent(request: import('@playwright/test').APIRequestContext): Promise<{ id: string; floor: number } | null> {
  const s: DemoState = await (await request.get('/api/state')).json();
  const floors = new Map(s.repos.map((r) => [r.id, r.floor]));
  const free = s.agents.find((a) => FREE_STATUSES.has(a.status) && floors.has(a.repoId));
  return free ? { id: free.id, floor: floors.get(free.repoId)! } : null;
}

/** A floor with a free agent on it right now, however long that takes to show up. */
async function floorWithFreeAgent(request: import('@playwright/test').APIRequestContext): Promise<number> {
  let found: { id: string; floor: number } | null = null;
  await expect
    .poll(
      async () => {
        found = await aFreeAgent(request);
        return found;
      },
      { message: 'a free agent somewhere in the demo', timeout: 90_000, intervals: [1000] },
    )
    .not.toBeNull();
  return found!.floor;
}

/**
 * Keeps offering the smoke errand to whoever's free right now (the real REST state, re-checked every second: the
 * demo's own agents come and go on their own, and one that's recalled mid-walk never gets there) until an actual
 * seat is occupied, however many of them that takes. `door` is a side channel: whichever (if any) side door this
 * saw open along the way, since by the time someone's seated it's long shut again.
 */
async function startSmokeAndGetSeated(
  request: import('@playwright/test').APIRequestContext,
  people: (fn: 'list' | 'send', ...args: unknown[]) => Promise<unknown>,
  smoke: () => Promise<SmokeProbe>,
  outside: () => Promise<OutsideProbe>,
  door: { open: number },
): Promise<string> {
  let who: string | null = null;
  await expect
    .poll(
      async () => {
        const o = await outside();
        door.open = Math.max(door.open, o.doors.west.open, o.doors.east.open);
        const seated = (await smoke()).nooks.flatMap((n) => n.seats).find((s) => s.startsWith('agent:'));
        if (seated) {
          who = seated.slice('agent:'.length);
          return who;
        }
        const list = (await people('list')) as { id: string }[];
        const candidate = (await aFreeAgent(request)) ?? (list[0] ? { id: list[0].id } : null);
        if (candidate) await people('send', candidate.id, 'smoke');
        return null;
      },
      { message: 'an agent seated on the smoke errand', timeout: 9 * 60_000, intervals: [1000] },
    )
    .not.toBeNull();
  return who!;
}

test('a free agent on a smoke errand (#58): the door opens for them, their seat shows agent:<id>, and leaving mid-break frees it again', async ({ page, request }) => {
  // The demo's own agents come and go on their own, so finding one that stays free long enough to get there is the
  // slow part (retried every second against the real REST state); once they're seated, the ashtray's stub and
  // coming home the ordinary way are the same end() a work interruption would call (smokeErrand.test.ts covers
  // those directly), so this doesn't wait out the full ~2-minute six-puff round trip — only the mid-break leave.
  test.setTimeout(15 * 60_000);
  const floor = await floorWithFreeAgent(request);
  const other = floor === 1 ? 2 : 1; // any other office floor, just to leave this one
  const spot: SavedView = { floor, x: -4, z: 6, yaw: 0, pitch: 0 };
  await startAt(page, spot);
  await enterOffice(page);

  const people = (fn: 'list' | 'send', ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window as unknown as { __swarmPeople: Record<string, (...x: unknown[]) => unknown> }).__swarmPeople[f](...(a as unknown[])), [fn, args] as const);
  const smoke = () => page.evaluate(() => (window as unknown as { __swarmSmokeBreak: SmokeProbe }).__swarmSmokeBreak);
  const outside = () => page.evaluate(() => (window as unknown as { __swarmOutside: OutsideProbe }).__swarmOutside);
  const goToFloor = async (n: number) => {
    await expect
      .poll(async () => {
        await page.evaluate((f) => (window as unknown as { __swarmRoof: { go(f: number): void } }).__swarmRoof.go(f), n);
        return page.evaluate(() => (window as unknown as { __swarmOutside: { floor: number } }).__swarmOutside.floor);
      }, { timeout: 15_000 })
      .toBe(n);
    await expect(page.locator('.fade-label')).toHaveCount(0);
  };

  const door = { open: 0 };
  const who = await startSmokeAndGetSeated(request, people, smoke, outside, door);

  // on the way there, one of the side doors opened for them (they're not the player); their seat shows 'agent:<id>'
  expect(door.open).toBeGreaterThan(0.5);
  expect((await smoke()).nooks.flatMap((n) => n.seats)).toContain(`agent:${who}`);

  // mid-puff, for the PR: the roll and the light are done by about NPC_SMOKE.roll + NPC_SMOKE.light seconds in
  await page.waitForTimeout((NPC_SMOKE.roll + NPC_SMOKE.light + 1) * 1000);
  await page.screenshot({ path: test.info().outputPath(`smoke-agent-${who}-puff.png`) });

  // away to another floor mid-break, then straight back: the seat is free again, not left stuck as agent:<id>
  await goToFloor(other);
  await goToFloor(floor);
  expect((await smoke()).nooks.flatMap((n) => n.seats)).not.toContain(`agent:${who}`);
});
