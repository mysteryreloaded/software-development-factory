import { type Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// A message to the CEO can be up to 60,000 characters and arrives whole (#37); over that it's refused with a 400,
// never cut silently. Follows chatNewline.spec.ts for opening the phone's CEO chat.

const box = (page: Page) => page.locator('.chat-input .msg-box');
const sendButton = (page: Page) => page.locator('.chat-input button.btn-good');
const myBubbles = (page: Page) => page.locator('.chat-log .bubble-me .bubble-text');

async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

async function openChat(page: Page) {
  await skipTour(page);
  await page.keyboard.press('p');
  await expect(box(page)).toBeVisible();
}

test('a 10,000-character message to the CEO arrives whole', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  await openChat(page);
  const before = await myBubbles(page).count();

  const marker = 'MARKER-END-OF-MESSAGE';
  const long = `${'a'.repeat(10_000 - marker.length)}${marker}`;
  await box(page).fill(long);
  await sendButton(page).click();

  await expect(myBubbles(page)).toHaveCount(before + 1);
  const sent = await myBubbles(page).last().innerText();
  expect(sent).toContain(marker);
  expect(sent.length).toBeGreaterThanOrEqual(10_000);
});

test('the chat box caps input at 60,000 characters', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  await openChat(page);
  await expect(box(page)).toHaveAttribute('maxlength', '60000');
});

test('over 60,000 characters is refused with a 400', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  const res = await page.request.post('/api/ceo/message', { data: { text: 'x'.repeat(60_001) } });
  expect(res.status()).toBe(400);
  const body = await res.text();
  expect(body).toContain('limit is 60,000');
});
