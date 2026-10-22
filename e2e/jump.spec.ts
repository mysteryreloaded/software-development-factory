import { enterOffice, expect, test } from './helpers';

// Issue #45: Space jumps on foot (rebindable, Help → Controls); on a touch screen, a Jump button sits right of the
// joystick. world/jump.ts holds the pure arc; Player.tsx exposes it as window.__swarmJump for here, like the
// gamepad probe.

const jumpHeight = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __swarmJump: { height(): number } }).__swarmJump.height());
const jumpAirborne = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __swarmJump: { airborne(): boolean } }).__swarmJump.airborne());

// Each frame advances the jump by its own dt, clamped so a slow frame can't overshoot (world/jump.ts); under
// software WebGL on a busy runner that can mean only a few frames a second (e2e/movement.spec.ts), so landing in
// wall-clock time can take much longer than the jump's own ~0.55s — poll generously, as that spec does.
test('Space jumps and lands within the expected arc', async ({ page }) => {
  await enterOffice(page);
  await page.keyboard.press('Space');
  await expect.poll(() => jumpHeight(page), { message: 'jump height', timeout: 60_000 }).toBeGreaterThan(0.2);
  await expect.poll(() => jumpAirborne(page), { timeout: 60_000, message: 'back on the ground' }).toBe(false);
  expect(await jumpHeight(page)).toBe(0);
});

test('holding Space jumps only once', async ({ page }) => {
  await enterOffice(page);
  await page.keyboard.down('Space');
  try {
    await expect.poll(() => jumpHeight(page), { timeout: 60_000 }).toBeGreaterThan(0.2);
    // Autorepeat keeps firing keydown with repeat: true while held; a second jump would show as airborne again
    // right after this one lands, instead of staying grounded.
    await expect.poll(() => jumpAirborne(page), { timeout: 60_000 }).toBe(false);
    await page.waitForTimeout(300);
    expect(await jumpAirborne(page)).toBe(false);
    expect(await jumpHeight(page)).toBe(0);
  } finally {
    await page.keyboard.up('Space');
  }
});

test.describe('the on-screen Jump button, on a touch phone', () => {
  test.use({ deviceScaleFactor: 3, hasTouch: true, isMobile: true, viewport: { width: 360, height: 780 } });

  test('tapping it jumps', async ({ page }) => {
    // ?touch=1&pocket=0: the 3D office's own touch controls, forced on regardless of the emulated pointer
    // (e2e/touch.spec.ts), not pocket mode (the 2D office a narrow/touch screen gets by default).
    await page.goto('/?touch=1&pocket=0');
    await enterOffice(page, { loaded: true });
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator('.touch-jump').boundingBox();
    if (!box) throw new Error('no .touch-jump');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => jumpHeight(page), { message: 'jump height after tapping Jump' }).toBeGreaterThan(0.2);
  });
});
