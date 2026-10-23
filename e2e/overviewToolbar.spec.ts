import type { Page } from '@playwright/test';
import { enterOffice, expect, test } from './helpers';

// Issue #86: the overview/building toolbar (.cam-bar, CameraHud.tsx) gets the same see-through treatment issue
// #85 gave the top HUD: its own background (and its buttons') fades to 20% opacity so the 3D view shows through,
// while the title, button labels, kbd keys, border and shadow stay fully opaque. High contrast (an accessibility
// setting) keeps today's solid background. This spec presses Tab to reach the overview (and again for the
// building view) and reads getComputedStyle(...).backgroundColor to check the alpha channel.

function alphaOf(color: string): number {
  // A color-mix() background can serialize as `color(srgb r g b / a)` instead of `rgba(r, g, b, a)` (Chromium).
  const fn = color.match(/color\([^)]*\/\s*([\d.]+)\s*\)/);
  if (fn) return Number(fn[1]);
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not a color: ${color}`);
  const parts = m[1].split(',').map((s) => s.trim());
  return parts.length > 3 ? Number(parts[3]) : 1;
}

async function setHighContrast(page: Page, on: boolean) {
  await page.evaluate((on) => (window as unknown as { __swarmA11y: { set: (p: { highContrast: boolean }) => void } }).__swarmA11y.set({ highContrast: on }), on);
}

async function enterOverview(page: Page) {
  await page.keyboard.press('Tab');
  await expect(page.locator('.cam-bar')).toBeVisible();
}

for (const [name, viewport] of [
  ['desktop 1280x800', { width: 1280, height: 800 }],
  ['phone 390x844', { width: 390, height: 844 }],
] as const) {
  test(`overview toolbar fades to 20% opacity, high contrast keeps it solid (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?pocket=0');
    await enterOffice(page, { loaded: true });
    await enterOverview(page);

    const bar = page.locator('.cam-bar');
    const back = page.locator('.cam-bar .btn-good', { hasText: 'Back' });
    const turnLeft = page.locator('.cam-bar .btn', { hasText: '⟲' });

    expect(alphaOf(await bar.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);
    expect(alphaOf(await turnLeft.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);
    expect(alphaOf(await back.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);

    // Text and border stay fully opaque (only the background fades).
    expect(alphaOf(await page.locator('.cam-title').evaluate((el) => getComputedStyle(el).color))).toBe(1);
    expect(alphaOf(await back.evaluate((el) => getComputedStyle(el).color))).toBe(1);
    expect(alphaOf(await bar.evaluate((el) => getComputedStyle(el).borderColor))).toBe(1);

    await setHighContrast(page, true);
    expect(alphaOf(await bar.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
    expect(alphaOf(await turnLeft.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
    expect(alphaOf(await back.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
    await setHighContrast(page, false);
  });
}

test('the building view toolbar gets the same fade, and every button still works', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?pocket=0');
  await enterOffice(page, { loaded: true });
  await enterOverview(page);

  const bar = page.locator('.cam-bar');
  await expect(bar).toContainText('🗺️ Overview');

  // Turn left/right still work (don't throw, the bar stays up).
  await page.locator('.cam-bar .btn', { hasText: '⟲' }).click();
  await page.locator('.cam-bar .btn', { hasText: '⟳' }).click();
  await expect(bar).toBeVisible();

  // Building: Tab again (CameraHud.tsx's enterBuilding also flips the title/buttons).
  await bar.getByRole('button', { name: /Building/ }).click();
  await expect(bar).toContainText('🏢 The building');
  expect(alphaOf(await bar.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);

  // This floor: back down to the overview.
  await bar.getByRole('button', { name: /This floor/ }).click();
  await expect(bar).toContainText('🗺️ Overview');

  // Back: returns to first person, hiding the toolbar.
  await bar.getByRole('button', { name: /Back/ }).click();
  await expect(bar).toBeHidden();
});
