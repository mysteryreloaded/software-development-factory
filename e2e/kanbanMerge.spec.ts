import type { APIRequestContext } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Issue #70: clicking Merge on a Ready card must land it straight in 🎉 Merged, never even one frame in 🔍 In QA.
// The demo plays out a whole build → QA cycle for real (fake sessions, but on the same timers as a real one), so
// this is slow: give it room rather than hardcoding a guess at how long that takes.

async function floors(request: APIRequestContext) {
  type State = { repos: { id: string; floor: number; fullName: string }[] };
  const { repos } = (await (await request.get('/api/state')).json()) as State;
  return [...repos].sort((a, b) => a.floor - b.floor);
}

test('Merge on a Ready card goes straight to Merged, never through In QA', async ({ page, request }) => {
  test.setTimeout(10 * 60_000);

  const sorted = await floors(request);
  expect(sorted.length).toBeGreaterThanOrEqual(1);
  const floor1 = sorted[0];

  const spot: SavedView = { floor: floor1.floor, x: 0, z: -7, yaw: 0, pitch: 0.15 };
  await startAt(page, spot);
  await enterOffice(page);
  await expect(page.getByText('Open the Kanban board')).toBeVisible();
  await page.keyboard.press('e');
  await expect(page.locator('.panel-title')).toContainText(`Floor ${floor1.floor}`);

  // A hand-merged floor: turn off auto-merge so the passed PR waits in Ready instead of merging itself.
  const autoMerge = page.getByLabel('Auto-merge when QA and checks pass');
  if (await autoMerge.isChecked()) {
    await autoMerge.click();
    await expect(autoMerge).not.toBeChecked(); // the toggle round-trips through the server before the box reflects it
  }

  // File a fresh issue and hand it straight to a free agent, so we don't depend on what earlier tests left behind.
  const title = `Kanban merge test ${Date.now()}`;
  await page.getByRole('button', { name: '+ New issue' }).click();
  await page.getByLabel('Issue title').fill(title);
  const assignTo = page.getByLabel('Who works on it');
  await assignTo.selectOption({ index: 1 }); // "Give it to <free agent> right away"
  await page.getByRole('button', { name: 'File issue on GitHub' }).click();
  await expect(page.getByLabel('Issue title')).toBeHidden();

  // Wait out the whole build → open PR → QA → passed cycle: a card with our title lands in ✅ Ready to merge.
  const readyCard = page.locator('.kcol-review .kcard', { hasText: title });
  await expect(readyCard).toBeVisible({ timeout: 9 * 60_000 });
  // From here on, record which column holds that PR's card (found by its one-off title, never a substring of another
  // card's PR number) on every DOM change.
  await page.evaluate((cardTitle: string) => {
    const w = window as unknown as { __mergeLog: (string | null)[] };
    const locate = () => {
      for (const col of document.querySelectorAll('.kanban .kcol')) {
        const hit = [...col.querySelectorAll('.kcard-title')].some((el) => el.textContent?.includes(cardTitle));
        if (hit) return [...col.classList].find((c) => c.startsWith('kcol-')) ?? null;
      }
      return null;
    };
    w.__mergeLog = [locate()];
    const obs = new MutationObserver(() => {
      const now = locate();
      if (now !== w.__mergeLog[w.__mergeLog.length - 1]) w.__mergeLog.push(now);
    });
    obs.observe(document.querySelector('.kanban')!, { childList: true, subtree: true, characterData: true });
    (w as unknown as { __mergeObserver: MutationObserver }).__mergeObserver = obs;
  }, title);

  await readyCard.getByRole('button', { name: 'Merge' }).click();
  await page.getByRole('button', { name: 'Squash & merge' }).click();

  const mergedCard = page.locator('.kcol-merged .kcard', { hasText: title });
  await expect(mergedCard).toBeVisible({ timeout: 30_000 });

  await page.screenshot({ path: test.info().outputPath('kanban-merge.png') });

  const log = await page.evaluate(() => (window as unknown as { __mergeLog: (string | null)[] }).__mergeLog);
  expect(log).not.toContain('kcol-qa');
  expect(log[log.length - 1]).toBe('kcol-merged');
});
