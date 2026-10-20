import type { CDPSession, Page } from '@playwright/test';
import { enterOffice, expect, phoneButton, savedView, test, VIEW_KEY, type SavedView } from './helpers';

// Touch on a real phone (reported on a Samsung S23 — 360×780 CSS px, device pixel ratio 3 — running the office as
// an installed home-screen app): the joystick (all four directions) and a one-finger swipe on the open 3D view
// (look around), driven by real touch events over CDP (Input.dispatchTouchEvent) rather than synthetic
// PointerEvents, so the browser's own hit-testing and gesture handling are exercised the way a finger goes through
// them.
//
// Root cause: requestLook() (world/Player.tsx) had no touch check, so entering the office — and the panel-close
// watcher (lookLock.ts) on every panel close — grabbed pointer lock on the canvas. On a touch-only device that
// freezes further touch coordinates on the locked canvas: the stick keeps reading however it was first pushed
// (forward, since that's the first gesture after Enter) no matter which way it's pushed after, and a swipe moves
// nothing. Fixed by never locking (and releasing any lock already held) while touch controls are on.

type Pt = { x: number; y: number; id: number };

async function touchStart(cdp: CDPSession, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
}
async function touchMove(cdp: CDPSession, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
}
async function touchEnd(cdp: CDPSession, points: Pt[] = []) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points });
}

/** A straight drag from `from` to `to`, finger `id`, in a few steps (so it reads as a drag, not a jump). */
async function drag(cdp: CDPSession, id: number, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6) {
  await touchStart(cdp, [{ ...from, id }]);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await touchMove(cdp, [{ x, y, id }]);
  }
  await touchEnd(cdp);
}

async function stickCenter(page: Page) {
  const box = await page.locator('.touch-stick').boundingBox();
  if (!box) throw new Error('no .touch-stick');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A point on the open 3D view, vertically centred and a quarter of the way across: clear of the stick, the
 * buttons, and the HUD cards docked at every edge and corner — including the workers panel, which (above 700px
 * wide, e.g. the S23 landscape) docks top-right and, at a bigger UI scale (zoom, so it grows toward the centre),
 * reaches far enough left to catch a dead-centre swipe's far end: what made a chained 120px swipe land on the
 * panel instead of the canvas. HORIZONTAL_SWIPE_PX keeps the swipe's reach well short of it even so. */
function viewPoint(page: Page) {
  const size = page.viewportSize();
  if (!size) throw new Error('no viewport');
  return { x: size.width * 0.25, y: size.height / 2 };
}

const HORIZONTAL_SWIPE_PX = 60;

/** The office saves the view about once a second (Player.tsx), so right after a gesture, `savedView` can still be
 * mid-catch-up. Waits until two reads 300ms apart agree, so a "before" or "after" snapshot is the settled value,
 * not a stale one that then drifts into the next check and gets blamed on it. */
async function stableView(page: Page): Promise<SavedView> {
  let prev = (await savedView(page))!;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const cur = (await savedView(page))!;
    if (Math.abs(cur.yaw - prev.yaw) < 0.001 && Math.abs(cur.pitch - prev.pitch) < 0.001 && Math.hypot(cur.x - prev.x, cur.z - prev.z) < 0.01) return cur;
    prev = cur;
  }
  return prev;
}

/** Counts calls to HTMLCanvasElement#requestPointerLock, and logs every pointer event on window (capture phase),
 * so a frozen touch path shows up as events that stop arriving rather than a silent timeout. */
async function watchLockAndTouch(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __plCalls: number; __pointerLog: string[] };
    w.__plCalls = 0;
    w.__pointerLog = [];
    const real = HTMLCanvasElement.prototype.requestPointerLock;
    HTMLCanvasElement.prototype.requestPointerLock = function (this: HTMLCanvasElement, ...args: unknown[]) {
      w.__plCalls++;
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof real;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      window.addEventListener(
        type,
        (e) => {
          const pe = e as PointerEvent;
          w.__pointerLog.push(`${type} id=${pe.pointerId} x=${Math.round(pe.clientX)} y=${Math.round(pe.clientY)} target=${(pe.target as HTMLElement)?.className || (pe.target as HTMLElement)?.tagName}`);
        },
        true,
      );
    }
  });
}

const pointerLockCalls = (page: Page) => page.evaluate(() => (window as unknown as { __plCalls: number }).__plCalls);
const pointerLog = (page: Page) => page.evaluate(() => (window as unknown as { __pointerLog: string[] }).__pointerLog);

/** The first-run tour (ui/Tutorial.tsx) sits bottom-left, nearly the full width of a phone screen — right over the
 * joystick and reaching the phone button too. "Skip setup" (enterOffice) always starts it (SetupWizard.tsx), so
 * turn it off through the same settings PATCH its own "Skip tour" button uses, rather than fight it for clicks. */
async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

// The device the bug was reported on.
const S23 = { deviceScaleFactor: 3, hasTouch: true, isMobile: true };

/** Toasts (the demo's CEO chatter, pacing notices, …) dock almost the full width of a phone screen and can land
 * right over the stick mid-test; hide them so this file tests the joystick, not whichever toast is up. */
async function hideToasts(page: Page) {
  await page.addStyleTag({ content: '.toasts { display: none !important; }' });
}

/** Back to the spawn point (clears the remembered spot and reloads): each directional push starts from the same
 * open floor, not wherever the previous push's collision with a wall or a desk happened to leave the player. */
async function resetToSpawn(page: Page) {
  await page.evaluate((key) => localStorage.removeItem(key), VIEW_KEY);
  await page.reload();
  await enterOffice(page, { loaded: true });
  await hideToasts(page);
  await expect.poll(() => savedView(page)).not.toBeNull();
}

test.describe('touch on a real phone', () => {
  test.use(S23);

  for (const [name, viewport] of [
    ['portrait', { width: 360, height: 780 }],
    ['landscape', { width: 780, height: 360 }],
  ] as const) {
    test.describe(name, () => {
      test.use({ viewport });

      test('device is detected as touch', async ({ page }) => {
        // ?pocket=0: this file tests the 3D office's own touch controls, not pocket mode (the 2D office that a
        // narrow/touch screen gets by default, pocket/mode.ts).
        await page.goto('/?pocket=0');
        const coarse = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
        // The emulator should report a coarse pointer; if it doesn't, the office still turns touch controls on
        // via ?touch=1 (used below), which is what the rest of this file relies on.
        test.info().annotations.push({ type: 'coarse pointer', description: String(coarse) });
        await enterOffice(page, { loaded: true });
      });

      test('entering the office, and closing a panel, never locks the pointer', async ({ page }) => {
        await watchLockAndTouch(page);
        await page.goto('/?touch=1&pocket=0');
        await enterOffice(page, { loaded: true });
        await skipTour(page);
        expect(await pointerLockCalls(page)).toBe(0);
        expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(false);
        // Open and close a panel: the panel-close watcher (world/lookLock.ts) re-grabs the mouse on desktop.
        await phoneButton(page).click();
        await page.keyboard.press('Escape');
        expect(await pointerLockCalls(page)).toBe(0);
        expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(false);
      });

      for (const uiScale of [100, 125] as const) {
        test(`stick walks in all four directions, swipe turns the view, tap does not (UI scale ${uiScale}%)`, async ({ page }) => {
          test.setTimeout(240_000); // 4 directional pushes each reset to spawn, plus 3 swipes under software WebGL
          // Settings → Accessibility → UI scale, set the way the app itself saves it (ui/a11y.ts).
          if (uiScale !== 100) await page.addInitScript(([key, scale]) => localStorage.setItem(key, JSON.stringify({ uiScale: scale })), ['cubefarm:a11y', uiScale] as const);
          await watchLockAndTouch(page);
          await page.goto('/?touch=1&pocket=0');
          await enterOffice(page, { loaded: true });
          await skipTour(page);
          await hideToasts(page);
          await expect.poll(() => savedView(page)).not.toBeNull();
          const cdp = await page.context().newCDPSession(page);
          const center = await stickCenter(page);

          // --- stick: up walks forward, down walks back, left/right strafe; yaw never changes. ---
          const walked = async (dx: number, dy: number) => {
            await resetToSpawn(page);
            const from = (await savedView(page))!;
            await touchStart(cdp, [{ x: center.x, y: center.y, id: 1 }]);
            await touchMove(cdp, [{ x: center.x + dx, y: center.y + dy, id: 1 }]);
            try {
              await expect
                .poll(
                  async () => {
                    const at = await savedView(page);
                    return at ? Math.hypot(at.x - from.x, at.z - from.z) : 0;
                  },
                  { message: 'metres walked', timeout: 30_000 },
                )
                .toBeGreaterThan(0.1);
            } catch (e) {
              console.log('pointer log:', JSON.stringify(await pointerLog(page)));
              throw e;
            }
            await touchEnd(cdp);
            const to = (await savedView(page))!;
            expect(to.yaw).toBeCloseTo(from.yaw, 1);
            return { from, to };
          };

          const forward = await walked(0, -35);
          const back = await walked(0, 35);
          const left = await walked(-35, 0);
          const right = await walked(35, 0);
          // Opposite pushes should move opposite ways, not all forward (the bug: "only walks forward").
          const fDir = { x: forward.to.x - forward.from.x, z: forward.to.z - forward.from.z };
          const bDir = { x: back.to.x - back.from.x, z: back.to.z - back.from.z };
          const lDir = { x: left.to.x - left.from.x, z: left.to.z - left.from.z };
          const rDir = { x: right.to.x - right.from.x, z: right.to.z - right.from.z };
          expect(fDir.x * bDir.x + fDir.z * bDir.z).toBeLessThan(0); // forward vs back: opposing
          expect(lDir.x * rDir.x + lDir.z * rDir.z).toBeLessThan(0); // left vs right: opposing
          // strafe is roughly perpendicular to forward/back
          expect(Math.abs(fDir.x * lDir.x + fDir.z * lDir.z)).toBeLessThan(Math.max(Math.hypot(fDir.x, fDir.z) * Math.hypot(lDir.x, lDir.z), 0.01) * 0.6);

          // --- a one-finger swipe on the open view turns it: left/right changes yaw, up/down changes pitch. ---
          // Software WebGL under load can take a while to render the frame that applies a touch's deltas and the
          // next frame that saves it; give that more room than the suite's default 30s poll.
          const SWIPE_TIMEOUT = 60_000;
          const vp = viewPoint(page);
          // Each snapshot used as the *next* step's baseline must be settled (stableView), not just past the
          // poll's threshold: sampling mid-flight made the second swipe's baseline still include some of the
          // first swipe's catching-up motion, so the "opposite direction" check compared against a moving target.
          const beforeYaw = await stableView(page);
          await drag(cdp, 2, vp, { x: vp.x + HORIZONTAL_SWIPE_PX, y: vp.y });
          try {
            await expect
              .poll(
                async () => {
                  const at = await savedView(page);
                  return at ? Math.abs(at.yaw - beforeYaw.yaw) : 0;
                },
                { timeout: SWIPE_TIMEOUT },
              )
              .toBeGreaterThan(0.05);
          } catch (e) {
            console.log('swipe pointer log:', JSON.stringify(await pointerLog(page)));
            throw e;
          }
          const afterSwipeRight = await stableView(page);

          await drag(cdp, 3, { x: vp.x + HORIZONTAL_SWIPE_PX, y: vp.y }, vp);
          try {
            await expect
              .poll(
                async () => {
                  const at = await savedView(page);
                  return at ? Math.abs(at.yaw - afterSwipeRight.yaw) : 0;
                },
                { timeout: SWIPE_TIMEOUT },
              )
              .toBeGreaterThan(0.05);
          } catch (e) {
            console.log('swipe pointer log:', JSON.stringify(await pointerLog(page)));
            throw e;
          }
          const afterSwipeLeft = await stableView(page);
          // left and right swipes turn opposite ways
          expect(Math.sign(afterSwipeRight.yaw - beforeYaw.yaw)).not.toBe(0);
          expect(Math.sign(afterSwipeLeft.yaw - afterSwipeRight.yaw)).toBe(-Math.sign(afterSwipeRight.yaw - beforeYaw.yaw));

          const beforePitch = await stableView(page);
          await drag(cdp, 4, vp, { x: vp.x, y: vp.y + 120 });
          await expect
            .poll(
              async () => {
                const at = await savedView(page);
                return at ? Math.abs(at.pitch - beforePitch.pitch) : 0;
              },
              { timeout: SWIPE_TIMEOUT },
            )
            .toBeGreaterThan(0.05);

          // --- a quick tap on the view doesn't turn it. ---
          // Back to spawn: the previous swipes left the view aimed wherever they landed, and if that happens to
          // aim at something interactable, a tap would act on it (a real effect of tapping, not a look change,
          // but one this check shouldn't have to account for).
          await resetToSpawn(page);
          const beforeTap = await stableView(page);
          await touchStart(cdp, [{ x: vp.x, y: vp.y, id: 5 }]);
          await touchEnd(cdp);
          const afterTap = await stableView(page);
          expect(afterTap.yaw).toBeCloseTo(beforeTap.yaw, 2);
          expect(afterTap.pitch).toBeCloseTo(beforeTap.pitch, 2);

          expect(await pointerLockCalls(page)).toBe(0);
        });
      }

      test('thumb on the stick plus a second finger swiping walks and turns at the same time', async ({ page }) => {
        await watchLockAndTouch(page);
        await page.goto('/?touch=1&pocket=0');
        await enterOffice(page, { loaded: true });
        await skipTour(page);
        await hideToasts(page);
        await expect.poll(() => savedView(page)).not.toBeNull();
        const cdp = await page.context().newCDPSession(page);
        const center = await stickCenter(page);
        const vp = viewPoint(page);
        const from = (await savedView(page))!;

        await touchStart(cdp, [{ x: center.x, y: center.y, id: 10 }]);
        await touchMove(cdp, [{ x: center.x, y: center.y - 35, id: 10 }]);
        await touchStart(cdp, [
          { x: center.x, y: center.y - 35, id: 10 },
          { x: vp.x, y: vp.y, id: 11 },
        ]);
        for (let i = 1; i <= 6; i++) {
          await touchMove(cdp, [
            { x: center.x, y: center.y - 35, id: 10 },
            { x: vp.x + (120 * i) / 6, y: vp.y, id: 11 },
          ]);
        }
        await touchEnd(cdp, [{ x: center.x, y: center.y - 35, id: 10 }]);

        await expect
          .poll(async () => {
            const at = await savedView(page);
            return at ? Math.hypot(at.x - from.x, at.z - from.z) : 0;
          })
          .toBeGreaterThan(0.1);
        await expect
          .poll(async () => {
            const at = await savedView(page);
            return at ? Math.abs(at.yaw - from.yaw) : 0;
          })
          .toBeGreaterThan(0.05);

        await touchEnd(cdp);
        expect(await pointerLockCalls(page)).toBe(0);
      });
    });
  }
});
