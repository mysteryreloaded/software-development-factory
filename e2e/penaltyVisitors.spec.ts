import type { Page } from '@playwright/test';
import { goalPitch } from '../client/src/world/park/parkPitch';
import { GOAL } from '../shared/penalty';
import { enterOffice, expect, startAt, test } from './helpers';

// A visitor takes an agent's place in the park's penalty shoot-out (#47): the server referees every kick, so two
// browsers (and a third just watching) see the same match. window.__swarmPenalty drives it without the mouse, as
// e2e/penalty.spec.ts does for the single-player match; two pages, as e2e/presence.spec.ts:24 does.

interface PenaltyProbeState {
  stage: string | null;
  turn: string | null;
  winner: string | null;
  visitor: boolean;
  view: { score: { player: number; opponent: number } } | null;
  kicks: { side: string; scored: boolean; kmh: number }[];
}
interface PenaltyProbe {
  state: PenaltyProbeState;
  start(opponentId?: string): boolean;
  skipWalk(): boolean;
  shoot(x: number, y: number, power?: number): boolean;
  dive(x: number, y: number): boolean;
  takeover(): void;
}
// A backgrounded tab's rAF (so its own clock: world/park/penaltyState.ts tickPenalty, run every frame from
// ParkOpponent.tsx) is throttled hard by Chrome; bringToFront() before touching a page keeps its match ticking.
// A backgrounded tab's rAF (so its own clock: world/park/penaltyState.ts tickPenalty, run every frame from
// ParkOpponent.tsx) is throttled hard by Chrome; bringToFront() before touching a page keeps its match ticking.
const penalty = async (page: Page) => {
  await page.bringToFront();
  return page.evaluate(() => (window as unknown as { __swarmPenalty: PenaltyProbe }).__swarmPenalty.state);
};
const call = async (page: Page, fn: keyof PenaltyProbe, ...args: unknown[]) => {
  await page.bringToFront();
  return page.evaluate(([f, a]) => (window as unknown as { __swarmPenalty: Record<string, (...x: unknown[]) => unknown> }).__swarmPenalty[f](...(a as unknown[])), [fn, args] as const);
};

interface AgentInfo {
  id: string;
  status: string;
  role: string;
}

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

/** Sets this page's presence name, before it enters the office. */
async function withName(page: Page, name: string) {
  await page.addInitScript(([key, profile]) => localStorage.setItem(key, profile), ['cubefarm:profile', JSON.stringify({ name, color: '#118ab2', appear: true })] as const);
}

/** Waits for this page's own pose to have reached the server (world/presence/presenceState.ts), so a pk-join it
 * sends right after lands on a peer the server already has as 'visible' on floor 0 (server/presence.ts). */
async function waitPresent(page: Page) {
  await page.bringToFront();
  await expect
    .poll(async () => {
      await page.bringToFront(); // a backgrounded tab's own presence sync (rAF-driven) never gets there otherwise
      return page.evaluate(() => (window as unknown as { __swarmPresence: { me(): { mode: string } } }).__swarmPresence.me().mode);
    }, { timeout: 30_000 })
    .toBe('pose');
}

type PresenceProbe = { me(): { id: string }; roster(): { id: string; floor: number }[] };
const myId = (page: Page) => page.evaluate(() => (window as unknown as { __swarmPresence: PresenceProbe }).__swarmPresence.me().id);
const theirRoster = (page: Page) => page.evaluate(() => (window as unknown as { __swarmPresence: PresenceProbe }).__swarmPresence.roster());

/** waitPresent only confirms a page's own BELIEF it's sending poses - not that the server has actually received and
 * broadcast one yet. A pk-join sent before the server has that peer as 'visible' on floor 0 is silently rejected
 * (server/presence.ts's `peer.mode !== 'visible'` check), breaking the whole join/live handshake with no error -
 * which reads exactly like "the visitor flag never turns true". Confirm each side shows up in the OTHER's own
 * roster (populated only from the server's own 'visitors' broadcast) before either one calls takeover(). */
async function waitSeesEachOther(a: Page, b: Page) {
  const [aId, bId] = await Promise.all([myId(a), myId(b)]);
  await expect
    .poll(async () => {
      const [ra, rb] = await Promise.all([theirRoster(a), theirRoster(b)]);
      return ra.some((v) => v.id === bId && v.floor === 0) && rb.some((v) => v.id === aId && v.floor === 0);
    }, { timeout: 30_000 })
    .toBe(true);
}

const goal = goalPitch();
const spot: { floor: number; x: number; z: number; yaw: number; pitch: number } = { floor: 0, x: goal.spotX, z: goal.z, yaw: Math.PI / 2, pitch: 0 };
/** A clean, unguarded corner: a shot there scores unless the keeper dives right to it. */
const CORNER = { x: GOAL.width / 2 - 0.3, y: GOAL.height - 0.3 };

/** Drives the match to the end (or `maxKicks`): whichever page's probe says it's their turn shoots. Once, the
 * keeper dives early to CORNER just before the shooter strikes there too, to show an early guess saves a hard shot.
 * Returns pageA's own decisive snapshot (captured the instant `winner` was first seen, not re-read afterward). */
async function playMatch(pageA: Page, pageB: Page, maxKicks = 20): Promise<PenaltyProbeState> {
  let triedDive = false;
  for (let i = 0; i < maxKicks; i++) {
    // `stage` alone can't tell "this kick landed" from "still waiting on the last one": a page reads 'live' both
    // before its own kick has been struck and once the next one has started, so sampling it right after shoot()
    // can pass instantly while the server (busy with the rest of the demo office) hasn't resolved this kick yet -
    // kicksBefore pins what actually has to change (a new kick recorded, or the match decided).
    const kicksBefore = (await penalty(pageA)).kicks.length;
    // re-reads turn/stage right before acting: switching focus between the two pages (bringToFront) costs a
    // little real time, and the 15 s shot clock (server/penaltyMatch.ts) waits for nobody: more, quicker attempts
    // fit inside that window than fewer slow ones - 5 attempts at up to 5 s each can alone exceed 15 s, timing the
    // kick out before ever landing a real shot (and enough of those in a row turns the deliberate miss/dive this
    // match is scripted around into noise, which can leave a shoot-out tied forever in sudden death).
    let shot = false;
    for (let attempt = 0; attempt < 10 && !shot; attempt++) {
      let turnA: string | null = null;
      await expect
        .poll(async () => {
          const s = await penalty(pageA);
          turnA = s.turn;
          return s.stage;
        }, { timeout: 30_000 })
        .toBe('live');
      const shooter = turnA === 'player' ? pageA : pageB;
      const keeper = turnA === 'player' ? pageB : pageA;
      // pageA's own view can briefly disagree with the other page's (events don't land on both tabs at once under
      // load): confirm the page we're about to act as shooter on actually agrees it's live and their turn too,
      // rather than firing blind and having probe.shoot() reject it.
      const shooterAgrees = await expect
        .poll(async () => {
          const s = await penalty(shooter);
          return s.stage === 'live' && s.turn === 'player';
        }, { timeout: 2_000 })
        .toBe(true)
        .then(() => true)
        .catch(() => false);
      if (!shooterAgrees) continue;
      if (i === 0) {
        shot = (await call(shooter, 'shoot', 0, GOAL.height + 1, 0.5)) as boolean; // kick 1: a clean, guaranteed miss
      } else if (i === 2) {
        // once, the keeper guesses right before the shooter even strikes: an early dive saves a hard shot there.
        // Best-effort (its own turn-check can race the same focus-switch): every other kick scores regardless.
        // On the SAME side as kick 1's guaranteed miss (alternating turns put kick 3 back with it, not the other
        // side): a save here stacks onto that side's existing deficit instead of cancelling it out - the other
        // arrangement (dived on the very next kick, the opposite side's) ties 2-2 after regulation whenever the
        // dive actually lands in time, and with nothing to break a tie afterward (every later kick is identical,
        // undefended), sudden death then never decides either - a shoot-out that gets MORE likely to hang the
        // better-behaved the dive timing is, the opposite of what "best-effort" was meant to buy here.
        if (!triedDive) {
          triedDive = true;
          await call(keeper, 'dive', CORNER.x, CORNER.y);
        }
        shot = (await call(shooter, 'shoot', CORNER.x, CORNER.y, 1)) as boolean;
      } else {
        shot = (await call(shooter, 'shoot', CORNER.x, CORNER.y, 1)) as boolean;
      }
    }
    expect(shot).toBe(true);
    // Wait not just for this kick to land (kicks.length grows) but for the clock to move past judging it ('result'
    // lasts RESULT_MS): `winner` is only set on the way out of 'result', a tick after kicks.length already grew, so
    // stopping as soon as kicks.length grows can capture `winner` still null on the very kick that decided it - then
    // the next loop iteration waits forever for a next kick that was never coming. Capture the snapshot that settles
    // this as a side effect too: a decided match self-clears OVER_MS after `winner` is set (a hard deadline
    // regardless of focus), so re-reading state afterward instead of using what the poll already saw risks the race.
    let snap: PenaltyProbeState | null = null;
    await expect
      .poll(async () => {
        snap = await penalty(pageA);
        if (snap.winner !== null) return true; // decided
        return snap.kicks.length > kicksBefore && snap.stage !== 'result'; // landed, and past judging it: genuinely continuing
      }, { timeout: 30_000 })
      .toBe(true);
    if (snap!.winner) return snap!;
  }
  throw new Error(`playMatch: no winner after ${maxKicks} kicks`);
}

test('page B takes the agent\'s place: the server referees a shared match with a matching score', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const pageA = page;
  const other = await pageA.context().newPage();
  await other.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await withName(pageA, 'Ada');
  await withName(other, 'Bo');
  await startAt(pageA, spot);
  await startAt(other, { ...spot, x: spot.x - 1 });
  await enterOffice(pageA);
  await enterOffice(other);

  const opponentId = await freeAgent(pageA);
  expect(await call(pageA, 'start', opponentId)).toBe(true);
  await call(pageA, 'skipWalk'); // best-effort: a slow, heavily-loaded run can have the agent already walk up and arrive on its own
  await expect.poll(async () => (await penalty(pageA)).stage, { timeout: 30_000 }).not.toBe('walkup');

  // Bo takes Ada's agent's place: both browsers end up in the same server-refereed match.
  await waitPresent(pageA);
  await waitPresent(other);
  await waitSeesEachOther(pageA, other);
  await call(other, 'takeover');
  await expect.poll(async () => (await penalty(pageA)).visitor, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await penalty(other)).visitor, { timeout: 30_000 }).toBe(true);

  const a = await playMatch(pageA, other);
  expect(a.winner).toBeTruthy();
  // other's own copy of the same decided match, lagging a little behind pageA's (WS delivery isn't simultaneous):
  // poll for it rather than a single read, but only briefly - it self-clears OVER_MS after `winner` is set there too.
  await expect.poll(async () => (await penalty(other)).winner, { timeout: 30_000 }).toBeTruthy();
  const b = await penalty(other);
  // each browser is always its own "player": the scores mirror each other exactly.
  expect(a.view!.score).toEqual({ player: b.view!.score.opponent, opponent: b.view!.score.player });
  expect(a.kicks.some((k) => !k.scored)).toBe(true); // the early dive's save (or the deliberate over-the-bar miss)

  await expect
    .poll(async () => {
      const state = await pageA.evaluate(() => fetch('/api/state').then((r) => r.json()));
      return state.penalty.rows.map((r: { id: string }) => r.id);
    }, { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['v:ada', 'v:bo']));
});

test('a third browser on floor 0 sees the same kicks and the billboard updates for everyone', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const pageA = page;
  const other = await pageA.context().newPage();
  const watcher = await pageA.context().newPage();
  for (const p of [other, watcher]) await p.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await withName(pageA, 'Em');
  await withName(other, 'Fi');
  await startAt(pageA, spot);
  await startAt(other, { ...spot, x: spot.x - 1 });
  await startAt(watcher, { ...spot, x: spot.x + 4, z: spot.z + 4 });
  await enterOffice(pageA);
  await enterOffice(other);
  await enterOffice(watcher);
  // each page's own presence sync (world/presence/presenceState.ts) runs off rAF, which a backgrounded tab's
  // browser throttles hard: give the watcher its own undisturbed turn in front before anyone else steals focus.
  await waitPresent(watcher);

  const opponentId = await freeAgent(pageA);
  expect(await call(pageA, 'start', opponentId)).toBe(true);
  await call(pageA, 'skipWalk'); // best-effort: a slow, heavily-loaded run can have the agent already walk up and arrive on its own
  await expect.poll(async () => (await penalty(pageA)).stage, { timeout: 30_000 }).not.toBe('walkup');
  await waitPresent(pageA);
  await waitPresent(other);
  await waitSeesEachOther(pageA, other);
  await call(other, 'takeover');
  await expect.poll(async () => (await penalty(pageA)).visitor, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await penalty(other)).visitor, { timeout: 30_000 }).toBe(true);

  // the watcher never plays, but gets the same pk-state/pk-kick (server/presence.ts toFloorZero) and ends up with
  // the same match too (penaltyState.ts applyPkState, a bystander's point of view): the same stage and kicks so far.
  await expect.poll(async () => (await penalty(watcher)).visitor, { timeout: 30_000 }).toBe(true);
  const [a0, w0] = await Promise.all([penalty(pageA), penalty(watcher)]);
  expect(w0.kicks).toEqual(a0.kicks);

  const a = await playMatch(pageA, other);
  expect(a.winner).toBeTruthy();
  await expect.poll(async () => (await penalty(watcher)).winner, { timeout: 30_000 }).toBeTruthy();
  const w = await penalty(watcher);
  expect(w.kicks.length > 0).toBe(true);

  // the billboard (the live match while it runs, the all-time board once it's done) is store.penalty for everyone.
  await expect
    .poll(async () => {
      const state = await watcher.evaluate(() => fetch('/api/state').then((r) => r.json()));
      return state.penalty.rows.map((r: { id: string }) => r.id);
    }, { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['v:em', 'v:fi']));
});

test('closing page A mid-match leaves no result', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const pageA = page;
  const other = await pageA.context().newPage();
  await other.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await withName(pageA, 'Cy');
  await withName(other, 'Di');
  await startAt(pageA, spot);
  await startAt(other, { ...spot, x: spot.x - 1 });
  await enterOffice(pageA);
  await enterOffice(other);

  const opponentId = await freeAgent(pageA);
  expect(await call(pageA, 'start', opponentId)).toBe(true);
  await call(pageA, 'skipWalk'); // best-effort: a slow, heavily-loaded run can have the agent already walk up and arrive on its own
  await expect.poll(async () => (await penalty(pageA)).stage, { timeout: 30_000 }).not.toBe('walkup');
  await waitPresent(pageA);
  await waitPresent(other);
  await waitSeesEachOther(pageA, other);
  await call(other, 'takeover');
  await expect.poll(async () => (await penalty(other)).visitor, { timeout: 30_000 }).toBe(true);

  const before = await pageA.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const countBefore = before.penalty.rows.filter((r: { id: string }) => r.id === 'v:cy' || r.id === 'v:di').length;

  await pageA.close();
  await expect.poll(async () => (await penalty(other)).stage, { timeout: 30_000 }).toBeNull();

  const state = await other.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const countAfter = state.penalty.rows.filter((r: { id: string }) => r.id === 'v:cy' || r.id === 'v:di').length;
  expect(countAfter).toBe(countBefore);
});
