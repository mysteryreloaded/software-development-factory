import type { CDPSession, Page } from '@playwright/test';
import { expect, test } from './helpers';

// A swipe on an agent's live terminal (LiveTerminal.tsx): xterm 6's viewport only answers the mouse wheel, so
// without this the scrollback is stuck on the last screenful on a phone. Driven by real emulated touch (CDP
// Input.dispatchTouchEvent, as touch.spec.ts does), not synthetic events, so the browser's own touch-to-gesture
// plumbing is exercised the way a finger goes through it.
//
// Reached through pocket mode (the 2D office a phone gets by default), which opens the very same LiveTerminal as
// the 3D office's agent panel (ui/TerminalView.tsx renders it either way) without paying for three.js.

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

/** A straight vertical drag at `x`, from `fromY` to `toY`, in a few steps (so it reads as a drag, not a jump). */
async function dragY(cdp: CDPSession, id: number, x: number, fromY: number, toY: number, steps = 8) {
  await touchStart(cdp, [{ x, y: fromY, id }]);
  for (let i = 1; i <= steps; i++) await touchMove(cdp, [{ x, y: fromY + ((toY - fromY) * i) / steps, id }]);
  await touchEnd(cdp);
}

// The device the sibling bug (#21/#19) was reported on.
const S23 = { deviceScaleFactor: 3, hasTouch: true, isMobile: true };

/** Pocket mode's Team tab, waiting for a working agent (the demo starts busy) and opening their terminal. */
async function openWorkingAgentTerminal(page: Page) {
  await page.goto('/?pocket=1&tab=team');
  const card = page.locator('.pk-agent').filter({ has: page.locator('.status-working') }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Terminal' }).click();
  await expect(page.locator('.live-term-screen')).toBeVisible();
  await expect(page.locator('.xterm-rows')).toBeVisible();
}

/** Enough printable, space-separated numbers to overflow any phone-sized terminal many times over (no `\r`/`\n`:
 * the demo's fake CLI only treats a literal `\r` as Enter, so plain text just wraps into many rows). */
const OVERFLOW_TEXT = Array.from({ length: 2000 }, (_, i) => i).join(' ');
const LAST_TOKEN = '1999';
const FIRST_TOKENS = ' 0 1 2 3 4 ';

async function allRowsText(page: Page) {
  return (await page.locator('.xterm-rows > div').allTextContents()).join('');
}

test.describe('touch on a real phone', () => {
  test.use(S23);

  for (const [name, viewport] of [
    ['portrait', { width: 360, height: 780 }],
    ['landscape', { width: 780, height: 360 }],
  ] as const) {
    test.describe(name, () => {
      test.use({ viewport });

      test('a tap with no movement focuses the terminal for typing', async ({ page }) => {
        await openWorkingAgentTerminal(page);
        const cdp = await page.context().newCDPSession(page);
        const box = (await page.locator('.live-term-screen').boundingBox())!;
        const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
        await touchStart(cdp, [pt]);
        await touchEnd(cdp);
        await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
      });

      test('a one-finger swipe scrolls the scrollback, both directions', async ({ page }) => {
        test.setTimeout(60_000);
        await openWorkingAgentTerminal(page);
        await page.locator('.live-term-screen').click(); // focus, so the typed overflow text goes into the terminal
        await page.keyboard.insertText(OVERFLOW_TEXT);
        await expect.poll(() => allRowsText(page)).toContain(LAST_TOKEN);
        expect(await allRowsText(page)).not.toContain(FIRST_TOKENS);

        const cdp = await page.context().newCDPSession(page);
        const box = (await page.locator('.live-term-screen').boundingBox())!;
        const x = box.x + box.width / 2;
        const topY = box.y + box.height * 0.3;
        const botY = box.y + box.height * 0.8;

        // Swipe down: the finger moves down, earlier output scrolls into view.
        await dragY(cdp, 2, x, topY, botY);
        await expect.poll(() => allRowsText(page)).not.toContain(LAST_TOKEN);

        // Swipe up, repeatedly (one drag only covers the panel's own height in lines): back at the latest line.
        for (let i = 0; i < 8; i++) await dragY(cdp, 3 + i, x, botY, topY);
        await expect.poll(() => allRowsText(page)).toContain(LAST_TOKEN);
      });
    });
  }
});

test('desktop: the mouse wheel still scrolls the terminal', async ({ page }) => {
  await openWorkingAgentTerminal(page);
  await page.locator('.live-term-screen').click();
  await page.keyboard.insertText(OVERFLOW_TEXT);
  await expect.poll(() => allRowsText(page)).toContain(LAST_TOKEN);

  const box = (await page.locator('.live-term-screen').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => allRowsText(page)).not.toContain(LAST_TOKEN);
});
