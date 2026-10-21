import { MANAGER_DESK } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The usage meter (#32): Mission control's "🤖 Claude usage" card shows both of Claude's live readings, and a
// simulated warning moves the weekly meter.

const AT_DESK: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };

test('Mission control shows both live meters, and simulating a warning moves the weekly one', async ({ page }) => {
  await startAt(page, AT_DESK);
  await enterOffice(page);
  await page.keyboard.press('e');
  await page.getByRole('tab', { name: /Mission control/ }).click();

  const fiveHour = page.getByRole('meter', { name: 'Claude 5-hour usage' });
  const weekly = page.getByRole('meter', { name: 'Claude weekly usage' });
  await expect(fiveHour).toBeVisible();
  await expect(weekly).toBeVisible();
  await expect.poll(async () => Number(await fiveHour.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await expect.poll(async () => Number(await weekly.getAttribute('aria-valuenow'))).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Simulate a usage warning' }).click();
  await expect.poll(async () => Number(await weekly.getAttribute('aria-valuenow'))).toBe(91);
});
