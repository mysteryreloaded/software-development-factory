import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// Issue #72: tapping an image in the CEO chat used to open <a href=".." target="_blank">, which on a phone
// installed to the home screen navigates the whole standalone window away with no back button. Every image now
// opens in a centred "Preview" modal instead (ui/ImagePreview.tsx): nothing navigates, no tab or window opens.
// Covers the phone panel (desktop) and pocket mode's chat tab (phone-sized, real touch), both built on the same
// <Chat> component and BubbleAttachment (ui/Phone.tsx).

// ---------- a PNG fixture, built by hand (as e2e/attachments.spec.ts does) ----------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A 2400x1600 gradient, well bigger than any test viewport, so the preview always has to scale it down. */
function gradientPng(width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = x % 256;
      raw[o + 1] = y % 256;
      raw[o + 2] = (x + y) % 256;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 1 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

let tmpDir: string;
test.beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-imgpreview-e2e-'));
});
test.afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A PNG fixture under its own name, so each mode's send is unambiguous in the office's shared chat history. */
function fixture(name: string): string {
  const file = path.join(tmpDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, gradientPng(2400, 1600));
  return file;
}

// ---------- shared steps ----------

async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

async function skipSetup(page: Page) {
  const skip = page.getByRole('button', { name: /skip setup/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

interface Mode {
  name: string;
  touch: boolean;
  viewport: { width: number; height: number };
  goto: string;
}

const MODES: Mode[] = [
  { name: 'desktop phone panel', touch: false, viewport: { width: 1280, height: 800 }, goto: '/?pocket=0' },
  { name: 'pocket chat, portrait', touch: true, viewport: { width: 390, height: 844 }, goto: '/?pocket=1&tab=chat' },
  { name: 'pocket chat, landscape', touch: true, viewport: { width: 844, height: 390 }, goto: '/?pocket=1&tab=chat' },
];

/** Opens the CEO chat, attaches the fixture image, sends it, and returns the sent thumbnail button. */
async function sendImage(page: Page, mode: Mode) {
  await page.goto(mode.goto);
  await skipSetup(page);
  if (!mode.touch) {
    await enterOffice(page, { loaded: true });
    await skipTour(page);
    await page.keyboard.press('p');
  }
  const box = page.locator('.chat-input .msg-box');
  await expect(box).toBeVisible();

  // A name of its own per mode: the three modes share one demo office, so their sent images must stay tellable
  // apart in its chat history (and from the unrelated images e2e/attachments.spec.ts sends there in the same run).
  const name = `preview-${mode.name.replace(/[^a-z0-9]+/gi, '-')}.png`;
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '📎' }).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(fixture(name));
  const chip = page.locator('.attach-chip', { hasText: name });
  await expect(chip).toBeVisible();
  await expect(chip.locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });

  await page.locator('.chat-input button.btn-good').click();
  const sent = page.locator('.chat-log .bubble-me .bubble-img-link', { has: page.locator(`img[alt="${name}"]`) }).last();
  await expect(sent).toBeVisible();
  // A locator keyed by its own src, immune to any later message changing what ".last()" would resolve to.
  const src = (await sent.locator('img').getAttribute('src'))!;
  const thumb = page.locator(`.chat-log .bubble-me .bubble-img-link:has(img[src="${src}"])`);
  await expect(thumb).toBeVisible();
  return thumb;
}

// On touch viewports, Playwright's own tap()/touchscreen.tap() dispatch real touch input through the browser's
// input pipeline (the same CDP Input domain e2e/touch.spec.ts and e2e/phoneLayout.spec.ts drive by hand), and
// additionally wait for the target to be stable and scrolled into view first — unlike a one-shot manual CDP tap,
// which can land on stale coordinates while the chat log is still settling after a send.
async function tap(mode: Mode, locator: ReturnType<Page['locator']>) {
  if (mode.touch) await locator.tap();
  else await locator.click();
}

/** Taps/clicks a viewport point directly, for the backdrop (outside the centred box). */
async function tapPoint(page: Page, mode: Mode, x: number, y: number) {
  if (mode.touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

for (const mode of MODES) {
  test.describe(mode.name, () => {
    test.use({ viewport: mode.viewport, hasTouch: mode.touch, isMobile: mode.touch });

    test('tapping the thumbnail opens a centred Preview modal with just the image and a close button', async ({ page, context }, testInfo) => {
      const newPages: Page[] = [];
      context.on('page', (p) => newPages.push(p));
      const thumb = await sendImage(page, mode);
      const thumbSrc = (await thumb.locator('img').getAttribute('src'))!;
      const urlBefore = page.url();

      await tap(mode, thumb);

      const dialog = page.getByRole('dialog', { name: 'Preview' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.image-preview-head')).toHaveText('Preview✕');

      const imgs = dialog.locator('img');
      await expect(imgs).toHaveCount(1);
      await expect(imgs).toHaveAttribute('src', thumbSrc);

      const buttons = dialog.locator('button');
      await expect(buttons).toHaveCount(1);
      await expect(dialog.locator('a')).toHaveCount(0);

      // Nothing navigated and nothing new opened.
      expect(page.url()).toBe(urlBefore);
      expect(newPages).toEqual([]);

      // Centred, and the image fills most of the box (no cropping, no scrollbars needed).
      const dialogBox = (await dialog.boundingBox())!;
      const headBox = (await dialog.locator('.image-preview-head').boundingBox())!;
      const imgBox = (await imgs.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
      expect(dialogBox.width).toBeLessThanOrEqual(viewport.width * 0.92 + 1);
      expect(dialogBox.height).toBeLessThanOrEqual(viewport.height * 0.88 + 1);
      const contentHeight = dialogBox.height - headBox.height;
      const ratioW = imgBox.width / dialogBox.width;
      const ratioH = imgBox.height / contentHeight;
      expect(Math.max(ratioW, ratioH)).toBeGreaterThanOrEqual(0.7);
      expect(dialogBox.height).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath('preview-open.png') });

      // Tapping the image itself doesn't close it.
      await tap(mode, imgs);
      await expect(dialog).toBeVisible();

      // Tapping the dimmed backdrop, outside the box, closes it. The box is centred with margin, so a corner is
      // always clear of it.
      await tapPoint(page, mode, 5, 5);
      await expect(dialog).toBeHidden();
      await expect(page.locator('.chat-input .msg-box')).toBeVisible(); // the chat is still right there

      // Reopen; the ✕ closes it.
      await tap(mode, thumb);
      await expect(dialog).toBeVisible();
      await tap(mode, page.getByRole('button', { name: 'Close preview' }));
      await expect(dialog).toBeHidden();

      // Reopen; Esc closes it, and the chat underneath stays open.
      await tap(mode, thumb);
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator('.chat-input .msg-box')).toBeVisible();
    });
  });
}
