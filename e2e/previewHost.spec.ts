import { expect, test } from '@playwright/test';

// Issue #33: with a `previewAddress` template set, a floor's running app opens on its own public host (so a phone
// behind a tunnel sees it, not a blank localhost frame) instead of the office's. Needs its own Chromium launch
// (playwright.config.ts's `previewHost` project): `--host-resolver-rules` sends every `*.cubefarm.test` host to
// 127.0.0.1, so `office.cubefarm.test` and `floor1.cubefarm.test` both reach this same demo office.
//
// Cross-origin by design (the floor's app answers on its own host), so this doesn't use e2e/helpers.ts: its `page`
// fixture stubs any request outside the single baseURL origin, which would stub out floor1.cubefarm.test too.

const PORT = Number(process.env.E2E_PORT || 4399);
const TEMPLATE = `http://floor{floor}.cubefarm.test:${PORT}`;

test.describe('a floor preview on its own host, under a previewAddress template', () => {
  // The Node-side `request` fixture doesn't go through Chromium's --host-resolver-rules, so it reaches the office
  // over plain 127.0.0.1 (the setting itself doesn't care which Host the request came in on).
  test.afterAll(async ({ request }) => {
    await request.patch(`http://127.0.0.1:${PORT}/api/settings`, { data: { previewAddress: '' } });
  });

  test("floor 1's app opens on floor1.cubefarm.test, and About stays there", async ({ page, request }) => {
    const patched = await request.patch(`http://127.0.0.1:${PORT}/api/settings`, { data: { previewAddress: TEMPLATE } });
    expect(patched.ok()).toBe(true);

    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`http://office.cubefarm.test:${PORT}/?pocket=1&tab=company`);

    const skipSetup = page.getByRole('button', { name: /skip setup/i });
    if (await skipSetup.isVisible().catch(() => false)) await skipSetup.click();

    const floorCard = page.locator('.pk-floor').filter({ has: page.locator('.floor-badge', { hasText: '1' }) });
    await expect(floorCard).toBeVisible({ timeout: 30_000 });
    await floorCard.getByRole('button', { name: 'Board' }).click();

    const viewApp = page.getByTitle("Open this floor's running app");
    await expect(viewApp).toBeVisible();
    await viewApp.click();

    const startMain = page.getByRole('button', { name: '▶ Start main' });
    const iframe = page.locator('iframe.app-frame');
    await expect(startMain.or(iframe)).toBeVisible({ timeout: 30_000 }); // the AppViewer panel lazy-loads
    if (await startMain.isVisible().catch(() => false)) await startMain.click();

    await expect(iframe).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => iframe.getAttribute('src'), { timeout: 30_000 })
      .toMatch(new RegExp(`^http://floor1\\.cubefarm\\.test:${PORT}/`));

    const body = page.frameLocator('iframe.app-frame');
    await expect(body.getByText('A placeholder app served by the demo office.')).toBeVisible({ timeout: 30_000 });

    await body.getByRole('link', { name: 'About' }).click();
    await expect(body.getByText('About this app: a placeholder served by the demo office.')).toBeVisible();
    const aboutFrame = page.frames().find((f) => f.url().includes('/about'));
    expect(aboutFrame?.url()).toMatch(new RegExp(`^http://floor1\\.cubefarm\\.test:${PORT}/about`));
  });
});
