import type { CDPSession, Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// Issue #23: on a narrow screen, the Company tab's project cards kept each project's name and summary on one
// line (white-space: nowrap), which set the overlay's grid column to that text's min-content width — far wider
// than the screen — and pushed the phone (centred in that wide column) mostly off-screen. The chat/Team/Games
// tabs never had long nowrap text, so the bug only showed on Company.
//
// Real touch events over CDP (Input.dispatchTouchEvent), as in e2e/touch.spec.ts, not synthetic PointerEvents:
// the bug is about the browser's own grid layout, but the project is real-device touch throughout its e2e suite.

type Pt = { x: number; y: number; id: number };

async function tap(cdp: CDPSession, point: Omit<Pt, 'id'>) {
  const p = { ...point, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const S23 = { deviceScaleFactor: 3, hasTouch: true, isMobile: true };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function phoneBox(page: Page): Promise<Box> {
  const box = await page.locator('.phone').boundingBox();
  if (!box) throw new Error('no .phone');
  return box;
}

/** The demo's live CEO chatter (a new message) can reflow the chat tab between two reads: poll
 * until two reads 300ms apart agree, so a measurement isn't caught mid-reflow and later blamed on the tab switch. */
async function stableBox(page: Page): Promise<Box> {
  let prev = await phoneBox(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const cur = await phoneBox(page);
    if (cur.x === prev.x && cur.y === prev.y && cur.width === prev.width && cur.height === prev.height) return cur;
    prev = cur;
  }
  return prev;
}

/** The first-run tour (ui/Tutorial.tsx) sits over the phone tabs and swallows the tap meant for Company. */
async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

test.describe('phone layout stays put across tabs', () => {
  test.use(S23);

  for (const [name, viewport] of [
    ['portrait', { width: 360, height: 780 }],
    ['landscape', { width: 780, height: 360 }],
  ] as const) {
    test(`Company tab doesn't push the phone off-screen (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      await page.keyboard.press('p');
      const before = await stableBox(page);
      expect(before.x).toBeGreaterThanOrEqual(0);
      expect(before.x + before.width).toBeLessThanOrEqual(viewport.width);

      const cdp = await page.context().newCDPSession(page);
      const companyTab = page.getByRole('tab', { name: 'Company' });
      // The demo's live CEO chatter can also move the tab out from under the tap between reading its position and
      // the tap landing: re-read the box and retry.
      await expect(async () => {
        const tabBox = await companyTab.boundingBox();
        if (!tabBox) throw new Error('no Company tab');
        await tap(cdp, { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 });
        await expect(companyTab).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
      }).toPass();
      await expect(page.locator('.proj-sum').first()).toBeVisible();

      // A long, realistic summary (demo data's are short): set it directly on the rendered node and wait a frame
      // for layout, as the issue's proof asks.
      await page.locator('.proj-sum').first().evaluate((el) => {
        el.textContent =
          'sharpy.ai, an AI image/video generation SaaS · Laravel (PHP 8.5) + Postgres + Redis/Horizon + MinIO + Paddle, Tailwind/Vue islands';
      });
      const after = await stableBox(page);
      // The bug was horizontal (the grid column growing to the long summary's min-content width): the phone's
      // x and width must stay put and fully on screen.
      expect(after.x).toBe(before.x);
      expect(after.width).toBe(before.width);
      expect(after.x).toBeGreaterThanOrEqual(0);
      expect(after.x + after.width).toBeLessThanOrEqual(viewport.width);

      const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(hasHScroll).toBe(false);
    });
  }
});

test.describe('phone stays bottom-right on desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const tabName of ['Chat', 'Team', 'Company', 'Games'] as const) {
    test(`${tabName} tab`, async ({ page }) => {
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await page.keyboard.press('p');
      if (tabName !== 'Chat') await page.getByRole('tab', { name: tabName }).click();
      const viewport = page.viewportSize()!;
      const box = await stableBox(page);
      // Bottom-right placement: close to the right and bottom edges, within the overlay's padding. (Vertically
      // the chat tab's own hint text can wrap to an extra line and run a little past the edge even on main; that's
      // pre-existing and unrelated to #23, which is about the Company tab pushing the phone sideways.)
      expect(box.x + box.width).toBeGreaterThan(viewport.width - 60);
      expect(box.y + box.height).toBeGreaterThan(viewport.height - 60);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    });
  }
});
