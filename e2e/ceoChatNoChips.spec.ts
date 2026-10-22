import { type Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// Issue #69: the CEO chat used to show a row of one-tap "quick reply" chips ("What's everyone working on?",
// "Should a team grow?", "Plan the next milestone for the busiest floor.") above the message box. They must
// never appear, in the phone (desktop and touch) or the pocket Chat tab, on open or after a reload.

const CHIP_TEXTS = ["What's everyone working on?", 'Should a team grow?', 'Plan the next milestone for the busiest floor.'];

const box = (page: Page) => page.locator('.chat-input .msg-box');

/** The first-run tour (ui/Tutorial.tsx) can sit over the phone button; turn it off the way its own
 * "Skip tour" button does, rather than fight it for clicks (see e2e/touch.spec.ts). */
async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

async function skipSetup(page: Page) {
  const skip = page.getByRole('button', { name: /skip setup/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function assertNoChips(page: Page) {
  await expect(box(page)).toBeVisible();
  await expect(page.locator('.quick')).toHaveCount(0);
  await expect(page.locator('.quick-chip')).toHaveCount(0);
  for (const text of CHIP_TEXTS) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
}

test('desktop phone: no chips, before or after reload', async ({ page }) => {
  await page.goto('/?pocket=0');
  await page.setViewportSize({ width: 1280, height: 800 });
  await enterOffice(page, { loaded: true });
  await skipTour(page);
  await page.keyboard.press('p');
  await assertNoChips(page);

  await page.reload();
  await enterOffice(page, { loaded: true });
  await page.keyboard.press('p');
  await assertNoChips(page);
});

test('touch phone: no chips, before or after reload', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/?touch=1&pocket=0');
  await enterOffice(page, { loaded: true });
  await skipTour(page);
  await page.keyboard.press('p');
  await assertNoChips(page);

  await page.reload();
  await enterOffice(page, { loaded: true });
  await page.keyboard.press('p');
  await assertNoChips(page);
});

test('pocket chat tab: no chips, before or after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?pocket=1&tab=chat');
  await skipSetup(page);
  await skipTour(page);
  await assertNoChips(page);

  await page.reload();
  await skipSetup(page);
  await assertNoChips(page);
});
