import type { CDPSession, Page } from '@playwright/test';
import { MANAGER_KIOSK, MANAGER_KIOSK_SPOT } from '../client/src/world/layout';
import { enterOffice, expect, phoneButton, savedView, startAt, test, type SavedView } from './helpers';

// The manager's kiosk (#29): the lobby's mission control wall, in miniature, beside the elevator on every office
// floor. E, click or a tap opens the very same manager's console, on Mission control, exactly as the lobby's wall
// does (console.spec.ts).

const PITCH = -0.15;

/** Standing at the kiosk's front spot, looking back at it (layout.ts turns it to face this way). */
const atKiosk = (floor: number): SavedView => ({ floor, x: MANAGER_KIOSK_SPOT.x, z: MANAGER_KIOSK_SPOT.z, yaw: MANAGER_KIOSK.rotY, pitch: PITCH });

async function opensAndCloses(page: Page, floor: number) {
  await startAt(page, atKiosk(floor));
  await enterOffice(page);
  await expect(page.getByText("Open the manager's console")).toBeVisible(); // the crosshair hint
  await page.keyboard.press('e');
  const panel = page.getByText(/Manager's console/);
  await expect(panel).toBeVisible();
  await expect(page.getByRole('tab', { name: /Mission control/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(phoneButton(page)).toBeVisible();
  expect((await savedView(page))?.floor).toBe(floor); // closing it leaves you on the same floor
}

test("opens with E on floor 1 and closes with Esc, on the Mission control tab", async ({ page }) => {
  await opensAndCloses(page, 1);
});

test('opens the same way on a second office floor', async ({ page }) => {
  await opensAndCloses(page, 2);
});

test('a click opens it too', async ({ page }) => {
  await startAt(page, atKiosk(1));
  await enterOffice(page);
  await page.mouse.click((await page.viewportSize())!.width / 2, (await page.viewportSize())!.height / 2);
  await expect(page.getByText(/Manager's console/)).toBeVisible();
});

// Real touch, driven by CDP (touch.spec.ts): a tap at the crosshair, with the kiosk dead ahead, opens the console.
const S23 = { deviceScaleFactor: 3, hasTouch: true, isMobile: true };

type Pt = { x: number; y: number; id: number };
async function tap(cdp: CDPSession, pt: Pt) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('touch on a real phone', () => {
  test.use({ ...S23, viewport: { width: 360, height: 780 } });

  test('a tap on the kiosk opens the console', async ({ page }) => {
    await startAt(page, atKiosk(1));
    await page.goto('/?touch=1&pocket=0');
    await enterOffice(page, { loaded: true });
    const cdp = await page.context().newCDPSession(page);
    const size = page.viewportSize()!;
    await tap(cdp, { x: size.width / 2, y: size.height / 2, id: 1 });
    await expect(page.getByText(/Manager's console/)).toBeVisible();
  });
});
