import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { type Page } from '@playwright/test';
import { MANAGER_DESK } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';
import { decodePng } from './png';

// Attaching photos, videos and documents to a CEO chat message (#48): the 📎 picker and paste both add a chip that
// uploads itself; Send waits for them; the server re-checks every file and re-encoded images land resized. Follows
// chatNewline.spec.ts / longMessage.spec.ts for opening the phone's CEO chat.

const box = (page: Page) => page.locator('.chat-input .msg-box');
const sendButton = (page: Page) => page.locator('.chat-input button.btn-good');
// In the manager's office, just in front of the desk, looking down at the computer (-Z is north), as console.spec.ts.
const AT_DESK: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };

async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

async function openChat(page: Page) {
  await skipTour(page);
  await page.keyboard.press('p');
  await expect(box(page)).toBeVisible();
}

// ---------- a PNG fixture, built by hand so the test has no binary file to keep around ----------

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

/** A simple gradient PNG, small enough to compress well (so a re-encode at 2000x1500 can stay PNG, not JPEG). */
function gradientPng(width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // no per-row filter
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
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

let tmpDir: string;
test.beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-attach-e2e-'));
});
test.afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, data: Buffer | string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, data);
  return file;
}

const chip = (page: Page, name: string) => page.locator('.attach-chip', { hasText: name });

test('a 4000×3000 PNG is resized to at most 2000px and 3.75 MB before it leaves the browser', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  await openChat(page);
  const file = writeFixture('big.png', gradientPng(4000, 3000));

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '📎' }).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(file);

  const c = chip(page, 'big.png');
  await expect(c).toBeVisible();
  await expect(c.locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 }); // upload finished
  await expect(c.locator('.attach-chip-warn')).toBeHidden();

  await sendButton(page).click();
  const img = page.locator('.chat-log .bubble-me .bubble-img').last();
  await expect(img).toBeVisible();
  const url: string = await img.getAttribute('src').then((s) => s!);

  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const buf = Buffer.from(await res.body());
  expect(buf.byteLength).toBeLessThanOrEqual(Math.floor(3.75 * 1024 * 1024));
  const png = decodePng(buf);
  expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(2000);
});

test('GET /api/uploads/:id sets X-Content-Type-Options: nosniff', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  const file = writeFixture('small.png', gradientPng(40, 30));
  await openChat(page);

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '📎' }).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(file);
  const c = chip(page, 'small.png');
  await expect(c.locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });

  await sendButton(page).click();
  const img = page.locator('.chat-log .bubble-me .bubble-img').last();
  const url: string = await img.getAttribute('src').then((s) => s!);
  const res = await page.request.get(url);
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});

test('pasting an image into the message box shows a chip', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  await openChat(page);

  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(0, 0, 20, 20);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const file = new File([blob], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector<HTMLTextAreaElement>('.chat-input .msg-box')!;
    el.focus();
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    el.dispatchEvent(event);
  });

  await expect(chip(page, 'pasted.png')).toBeVisible();
});

test('a PDF shows a doc chip, uploads, and downloads from the bubble', async ({ page }) => {
  await page.goto('/');
  await enterOffice(page, { loaded: true });
  await openChat(page);
  const file = writeFixture('report.pdf', '%PDF-1.4\n% a small fake pdf for the e2e test\n%%EOF\n');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '📎' }).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(file);

  const c = chip(page, 'report.pdf');
  await expect(c).toBeVisible();
  await expect(c.locator('.attach-chip-icon')).toHaveText('📄');
  await expect(c.locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });
  await expect(c.locator('.attach-chip-warn')).toBeHidden();

  await sendButton(page).click();
  const docChip = page.locator('.chat-log .bubble-me .bubble-doc-chip').last();
  await expect(docChip).toBeVisible();
  await expect(docChip).toContainText('report.pdf');
});

test('an .exe is refused, in plain words, without ever reaching the CEO', async ({ request }) => {
  const res = await request.post('/api/uploads', { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'virus.exe' }, data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00 not really an executable') });
  expect(res.status()).toBe(415);
  const body = await res.json();
  expect(body.error).toMatch(/virus\.exe/);
});

test("the CEO's log shows the attached file's path once the message reaches it", async ({ page, request }) => {
  const up = await request.post('/api/uploads', { headers: { 'Content-Type': 'text/plain', 'X-File-Name': 'notes.txt' }, data: Buffer.from('hello from the e2e test') });
  expect(up.ok()).toBe(true);
  const view = await up.json();

  const sent = await request.post('/api/ceo/message', { data: { text: 'Please read the attached note.', attachments: [view.id] } });
  expect(sent.ok()).toBe(true);

  await startAt(page, AT_DESK);
  await enterOffice(page);
  await page.keyboard.press('e');
  await page.getByRole('tab', { name: /CEO/ }).click();
  // The manager console's CEO tab shows the agent's own terminal/log, where the queued chat is logged once it starts.
  await expect(page.locator('.ceo-term')).toContainText('Attached files', { timeout: 20_000 });
});
