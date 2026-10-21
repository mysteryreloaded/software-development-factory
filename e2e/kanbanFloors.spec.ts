import type { APIRequestContext } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Issue #39: ‹ › arrows and ← → flip the Kanban panel between every floor's board, like a photo gallery, without
// closing it. The demo has two floors (demo-co/pixel-todo and demo-co/weather-api), but don't hardcode that: ask
// the office for the floors it actually has and derive the expected names/order from them.

async function floors(request: APIRequestContext) {
  type State = { repos: { id: string; floor: number; fullName: string }[] };
  const { repos } = (await (await request.get('/api/state')).json()) as State;
  return [...repos].sort((a, b) => a.floor - b.floor);
}

function shortName(fullName: string) {
  return fullName.split('/')[1] ?? fullName;
}

test('‹ › and ← → flip through every floor\'s Kanban board, wrapping around', async ({ page, request }) => {
  const sorted = await floors(request);
  expect(sorted.length).toBeGreaterThanOrEqual(2);
  const floor1 = sorted[0];
  const floor2 = sorted[1];
  const top = sorted[sorted.length - 1];

  const spot: SavedView = { floor: floor1.floor, x: 0, z: -7, yaw: 0, pitch: 0.15 };
  await startAt(page, spot);
  await enterOffice(page);
  await expect(page.getByText('Open the Kanban board')).toBeVisible();
  await page.keyboard.press('e');

  const panelTitle = page.locator('.panel-title');
  await expect(panelTitle).toContainText(shortName(floor1.fullName));
  await expect(panelTitle).toContainText(`Floor ${floor1.floor}`);

  const next = page.getByRole('button', { name: 'Next floor' });
  const prev = page.getByRole('button', { name: 'Previous floor' });

  await next.click();
  await expect(panelTitle).toContainText(shortName(floor2.fullName));
  await expect(panelTitle).toContainText(`Floor ${floor2.floor}`);
  await expect(page.locator('.panel')).toBeVisible(); // the panel never closed
  await expect(next).toBeFocused();

  await prev.click();
  await expect(panelTitle).toContainText(shortName(floor1.fullName));

  await prev.click(); // wraps past floor 1 to the top floor
  await expect(panelTitle).toContainText(shortName(top.fullName));
  await expect(panelTitle).toContainText(`Floor ${top.floor}`);

  // ArrowRight switches floors; wraps from the top back to floor 1.
  await page.keyboard.press('ArrowRight');
  await expect(panelTitle).toContainText(shortName(floor1.fullName));

  // But not while a text field has focus, like the new-issue title.
  await page.getByRole('button', { name: '+ New issue' }).click();
  const issueTitle = page.getByLabel('Issue title');
  await expect(issueTitle).toBeVisible();
  await issueTitle.click();
  await page.keyboard.press('ArrowLeft');
  await expect(panelTitle).toContainText(shortName(floor1.fullName));
  await expect(issueTitle).toBeVisible(); // the form is still open: the key did nothing

  // Switching floors (via the arrow button this time) closes an open draft.
  await next.click();
  await expect(panelTitle).toContainText(shortName(floor2.fullName));
  await expect(page.getByLabel('Issue title')).toBeHidden();

  await page.keyboard.press('Escape');
});

test('pocket mode has no floor-flipping arrows', async ({ page, request }) => {
  const sorted = await floors(request);
  expect(sorted.length).toBeGreaterThanOrEqual(2);

  await page.goto('/?pocket=1&tab=kanban');
  const skipSetup = page.getByRole('button', { name: /skip setup/i });
  if (await skipSetup.isVisible().catch(() => false)) await skipSetup.click();

  await expect(page.locator('.kanban, .kanban-embedded').first()).toBeVisible();
  await expect(page.locator('.kanban-arrow')).toHaveCount(0);
});
