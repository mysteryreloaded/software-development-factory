import type { Page } from '@playwright/test';
import { MANAGER_DESK } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Issue #62: the Settings tab's cards, paired two to a row, with both cards in a row the same height and a tall
// card never beside a much shorter one.

// In the manager's office, just in front of the desk, looking down at the computer (-Z is north).
const AT_DESK: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };

const CARD_ORDER = ['🧠 Agents', '🔔 Notifications', '🧠 The CEO', '👤 Profile', '🏢 Company', '🎉 Themes', '🌦️ Weather', '🔊 Voice'];

async function openSettings(page: Page) {
  await startAt(page, AT_DESK);
  await page.goto('/?pocket=0'); // a narrow viewport would otherwise start pocket mode, which has no console
  await enterOffice(page, { loaded: true });
  await page.keyboard.press('e');
  await page.getByRole('tab', { name: /Settings/ }).click();
  await expect(page.locator('.settings-grid')).toBeVisible();
}

function cardHeadings(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.settings-grid > *')).map((c) => c.querySelector('h3')?.textContent ?? ''));
}

interface CardBox {
  top: number;
  height: number;
  /** where the card's last child ends, relative to the card's own top: how much of the card its content fills. */
  contentBottom: number;
}

function cardBoxes(page: Page): Promise<CardBox[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.settings-grid > *')).map((c) => {
      const r = c.getBoundingClientRect();
      const last = c.lastElementChild;
      const lastRect = last?.getBoundingClientRect();
      return { top: r.top, height: r.height, contentBottom: lastRect ? lastRect.bottom - r.top : r.height };
    }),
  );
}

test('at 1280x800, the 8 cards come in order, pair up into even rows, and no row pairs a tall card with a much shorter one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSettings(page);

  expect(await cardHeadings(page)).toEqual(CARD_ORDER);

  const boxes = await cardBoxes(page);
  expect(boxes).toHaveLength(8);
  for (let i = 0; i < boxes.length; i += 2) {
    const [a, b] = [boxes[i], boxes[i + 1]];
    expect(a.top).toBeCloseTo(b.top, 0); // same row
    expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1); // settings-grid stretches both to the row's height
    const rowHeight = Math.max(a.height, b.height);
    const shorterContent = Math.min(a.contentBottom, b.contentBottom);
    expect(shorterContent / rowHeight).toBeGreaterThan(0.6); // the shorter card's own content still fills most of the row
  }
});

test('at 390x844, the cards stack in one column, in the same order', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);

  expect(await cardHeadings(page)).toEqual(CARD_ORDER);

  const boxes = await cardBoxes(page);
  expect(boxes).toHaveLength(8);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].top + boxes[i - 1].height - 1);
});
