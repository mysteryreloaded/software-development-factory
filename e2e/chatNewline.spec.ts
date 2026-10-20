import { type Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// The phone's CEO chat (#24): a touch keyboard has no Shift+Enter, so on a touch device Enter must add a line
// instead of sending, and only the Send button sends. Desktop keeps Enter-to-send, Shift+Enter-for-a-line.

const box = (page: Page) => page.locator('.chat-input .msg-box');
const sendButton = (page: Page) => page.locator('.chat-input button.btn-good');
const myBubbles = (page: Page) => page.locator('.chat-log .bubble-me .bubble-text');

/** The first-run tour (ui/Tutorial.tsx) can sit over the phone button; turn it off the way its own
 * "Skip tour" button does, rather than fight it for clicks (see e2e/touch.spec.ts). */
async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

async function openChat(page: Page) {
  await skipTour(page);
  // The phone button sits under the 3D canvas, which can grab the click (pointer lock, the camera drag target);
  // its own keyboard shortcut (phone.spec.ts) always reaches it.
  await page.keyboard.press('p');
  await expect(box(page)).toBeVisible();
}

test('touch keyboard: Enter adds a line, Send sends it', async ({ page }) => {
  await page.goto('/?touch=1&pocket=0');
  await enterOffice(page, { loaded: true });
  await openChat(page);
  const before = await myBubbles(page).count();

  await box(page).fill('first');
  await box(page).press('Enter');
  await expect(box(page)).toHaveValue('first\n');
  // No message went out yet: no new bubble of mine.
  await expect(myBubbles(page)).toHaveCount(before);

  await box(page).pressSequentially('second');
  await expect(box(page)).toHaveValue('first\nsecond');

  await sendButton(page).click();
  await expect(box(page)).toHaveValue('');
  await expect(myBubbles(page)).toHaveCount(before + 1);
  await expect(myBubbles(page).last()).toHaveText('first\nsecond');
});

test('desktop keyboard: Enter sends, Shift+Enter adds a line', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  await openChat(page);
  const before = await myBubbles(page).count();

  await box(page).fill('first');
  await box(page).press('Shift+Enter');
  await expect(box(page)).toHaveValue('first\n');
  await expect(myBubbles(page)).toHaveCount(before);

  await box(page).pressSequentially('second');
  await box(page).press('Enter');
  await expect(box(page)).toHaveValue('');
  await expect(myBubbles(page)).toHaveCount(before + 1);
  await expect(myBubbles(page).last()).toHaveText('first\nsecond');
});
