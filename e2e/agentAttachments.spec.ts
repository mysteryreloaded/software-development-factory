import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { type APIRequestContext, type Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// Attaching photos, videos and documents to an agent's message (#49): the same 📎/paste picker, limits, upload
// endpoint and chips as the CEO chat (#48), reused in the 3D office's agent panel (the HUD's "Working" list opens
// it, like faces.spec.ts) and in pocket mode's Team tab. Each file is copied into the agent's own machine temp
// folder, never the worktree, and the manager's text gets a block worded for any CLI (shared/attachments.ts).

interface DemoAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task: string | null;
}

/** The short machine folder name an agent's id maps to (server/machines.ts machineName). */
const machineName = (agentId: string) => agentId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'agent';

/** The demo's agents race ahead on their own clock: whichever one a panel opened to is matched back to its id here,
 * right before it's needed, rather than picked up front and hoped to still be around a minute later. */
async function agentNamed(request: APIRequestContext, name: string): Promise<DemoAgent> {
  const state = (await (await request.get('/api/state')).json()) as { agents: DemoAgent[] };
  const a = state.agents.find((x) => x.role !== 'ceo' && x.name === name);
  if (!a) throw new Error(`no agent named ${name} in the demo`);
  return a;
}

/** Where the demo office's SWARM_HOME lives, set up by playwright.config.ts before any worker starts. */
function attachmentsDir(agentId: string): string {
  const home = process.env.E2E_SWARM_HOME;
  if (!home) throw new Error('E2E_SWARM_HOME is not set');
  return path.join(home, 'machines', machineName(agentId), 'tmp', 'attachments');
}

async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
}

// ---------- a PNG fixture, built by hand so the test has no binary file to keep around (as attachments.spec.ts) ----------

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-agent-attach-e2e-'));
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

async function pastePdf(page: Page, selector: string, name: string) {
  await page.evaluate(
    ([sel, fileName]) => {
      const bytes = new TextEncoder().encode('%PDF-1.4\n% a small fake pdf for the e2e test\n%%EOF\n');
      const file = new File([bytes], fileName, { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector<HTMLTextAreaElement>(sel)!;
      el.focus();
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      el.dispatchEvent(event);
    },
    [selector, name] as const,
  );
}

// The HUD's "Working" list (.workers) hides itself under 500px tall (styles.css), below the suite's default
// 800x450 software-WebGL viewport: taller here so it stays up for faces.spec.ts's click-to-open trick.
test.describe('desktop', () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test('attaching an image and a document to a working agent, from the 3D office panel', async ({ page, request }) => {
    await page.goto('/');
    await enterOffice(page, { loaded: true });
    await skipTour(page);

    // The HUD's "Working" list (faces.spec.ts opens the same way): click whoever's busy to open their panel.
    await expect(page.locator('.wk-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.wk-row').first().dispatchEvent('click');
    await expect(page.locator('.term-input')).toBeVisible();
    const name = (await page.locator('.term-title span').nth(1).textContent())?.trim();
    if (!name) throw new Error("couldn't read the opened panel's agent name");
    const target = await agentNamed(request, name);

    const png = writeFixture('shot.png', gradientPng(40, 30));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '📎' }).click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(png);
    await expect(chip(page, 'shot.png')).toBeVisible();
    await expect(chip(page, 'shot.png').locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });
    await expect(chip(page, 'shot.png').locator('.attach-chip-warn')).toBeHidden();

    await pastePdf(page, '.term-input .msg-box', 'report.pdf');
    await expect(chip(page, 'report.pdf')).toBeVisible();
    await expect(chip(page, 'report.pdf').locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });
    await expect(chip(page, 'report.pdf').locator('.attach-chip-warn')).toBeHidden();

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/agents/${target.id}/message`) && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send' }).click(),
    ]);
    expect(resp.ok()).toBe(true);
    await expect(page.locator('.attach-chips')).toBeHidden();

    // Both files landed in the agent's own machine temp folder, never the worktree.
    const listAttachments = () => {
      try {
        return fs.readdirSync(attachmentsDir(target.id));
      } catch {
        return [];
      }
    };
    await expect
      .poll(listAttachments, { message: 'both files copied to the machine tmp folder', timeout: 10_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('shot.png'), expect.stringContaining('report.pdf')]));
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test('the same flow in pocket mode’s Team tab', async ({ page, request }) => {
    await page.goto('/?pocket=1&tab=team');
    await skipTour(page);

    // Whichever card currently offers a message button: working, or a past session with a branch to follow up on.
    const card = page.locator('.pk-agent').filter({ has: page.getByRole('button', { name: '💬 Message' }) }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const name = (await card.locator('b').first().textContent())?.trim();
    if (!name) throw new Error("couldn't read the card's agent name");
    const target = await agentNamed(request, name);
    await card.getByRole('button', { name: '💬 Message' }).click();

    const png = writeFixture('phone.png', gradientPng(30, 20));
    const chooser = page.waitForEvent('filechooser');
    await card.getByRole('button', { name: '📎' }).click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(png);
    await expect(card.locator('.attach-chip', { hasText: 'phone.png' })).toBeVisible();
    await expect(card.locator('.attach-chip', { hasText: 'phone.png' }).locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });

    await pastePdf(page, '.pk-msg .msg-box', 'memo.pdf');
    await expect(card.locator('.attach-chip', { hasText: 'memo.pdf' })).toBeVisible();
    await expect(card.locator('.attach-chip', { hasText: 'memo.pdf' }).locator('.attach-chip-spin')).toBeHidden({ timeout: 15_000 });

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/agents/${target.id}/message`) && r.request().method() === 'POST'),
      card.locator('.pk-msg button.btn-good').click(),
    ]);
    expect(resp.ok()).toBe(true);

    const listAttachments = () => {
      try {
        return fs.readdirSync(attachmentsDir(target.id));
      } catch {
        return [];
      }
    };
    await expect
      .poll(listAttachments, { message: 'both files copied to the machine tmp folder', timeout: 10_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('phone.png'), expect.stringContaining('memo.pdf')]));
  });
});

test('an .exe is refused, in plain words, without ever reaching an agent', async ({ request }) => {
  const res = await request.post('/api/uploads', { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'virus.exe' }, data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00 not really an executable') });
  expect(res.status()).toBe(415);
  const body = await res.json();
  expect(body.error).toMatch(/virus\.exe/);
});
