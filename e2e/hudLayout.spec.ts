import type { Page } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Floor 1, out on the open floor (not at anyone's desk), facing north.
const FLOOR_1_SPOT: SavedView = { floor: 1, x: -4, z: 8.5, yaw: 0, pitch: -0.1 };

// Issue #44: on a phone, in either orientation, the HUD's floating boxes (the floor card, the status pills, the
// office/usage/doctor chips) could land on top of each other or run past the screen edge, because they floated at
// fixed `top`/`left`/`right` offsets sized for a wide desktop window. HUD.tsx now wraps them in one `.hud-top`
// flex column (client/src/styles.css's `@media (max-width: 700px), (max-height: 500px)`), and the bottom-right
// cluster (toasts, the agent card, the phone button, the touch controls) each got its own corner. This spec
// measures every visible HUD box at the worst case (long floor text, every pill, two toasts, touch controls) and
// asserts none of them touch or run off-screen, on narrow and short viewports in both orientations.

const S23 = { deviceScaleFactor: 3, hasTouch: true, isMobile: true };

const VIEWPORTS = [
  ['portrait 320x568', { width: 320, height: 568 }],
  ['portrait 360x780', { width: 360, height: 780 }],
  ['portrait 390x844', { width: 390, height: 844 }],
  ['landscape 568x320', { width: 568, height: 320 }],
  ['landscape 780x360', { width: 780, height: 360 }],
  ['landscape 844x390', { width: 844, height: 390 }],
] as const;

async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Every box the spec cares about (see issue #44): .hud's own children, .hud-top's children, each touch control,
 * each toast, the phone button, and the agent card's children. Generic on purpose, so a control added later (e.g. a
 * Jump button) is picked up without editing this list. */
async function hudBoxes(page: Page): Promise<{ selector: string; box: Box }[]> {
  return page.evaluate(() => {
    const out: { selector: string; box: Box }[] = [];
    const seen = new Set<Element>();
    // Clip against every scrolling ancestor (e.g. .hud-top's own max-height/overflow-y: auto, which bounds how
    // tall the chips can grow): a box scrolled out of its ancestor's clip rect isn't actually on screen, even
    // though getBoundingClientRect reports its unclipped layout position.
    const clipToAncestors = (el: Element, r: DOMRect): DOMRect => {
      let rect = r;
      let node = el.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const cr = node.getBoundingClientRect();
          const left = Math.max(rect.left, cr.left);
          const top = Math.max(rect.top, cr.top);
          const right = Math.min(rect.right, cr.right);
          const bottom = Math.min(rect.bottom, cr.bottom);
          rect = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
        }
        node = node.parentElement;
      }
      return rect;
    };
    const add = (el: Element, label: string) => {
      if (seen.has(el)) return;
      seen.add(el);
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return;
      const r = clipToAncestors(el, el.getBoundingClientRect());
      if (r.width <= 0 || r.height <= 0) return;
      out.push({ selector: label, box: { x: r.x, y: r.y, width: r.width, height: r.height } });
    };
    const label = (el: Element, i: number) => `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}#${i}`;
    // The 4 wrapper containers (.hud-top, .touch-controls, .touch-buttons, .toasts, .aim-cards) only group other
    // measured boxes: skip the wrapper itself (it always bounds its own children, which isn't an overlap) and keep
    // its children instead. The full-screen layers the issue exempts (.fade, .crosshair, the emote wheel) are
    // skipped too.
    const skip = ['.hud-top', '.touch-controls', '.touch-buttons', '.toasts', '.aim-cards', '.fade', '.crosshair', '.emote-wheel'];
    document.querySelectorAll('.hud > *, .hud-top > *, .touch-controls > *, .touch-buttons > *, .toast, .phone-btn, .aim-cards > *').forEach((el, i) => {
      if (skip.some((w) => el.matches(w))) return;
      add(el, label(el, i));
    });
    return out;
  });
}

async function assertNoOverlapOnScreen(page: Page, viewport: { width: number; height: number }) {
  const boxes = await hudBoxes(page);
  expect(boxes.length).toBeGreaterThan(0);
  for (const { selector, box } of boxes) {
    expect(box.x, `${selector} left edge`).toBeGreaterThanOrEqual(0);
    expect(box.y, `${selector} top edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${selector} right edge`).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height, `${selector} bottom edge`).toBeLessThanOrEqual(viewport.height);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(intersects(boxes[i].box, boxes[j].box), `${boxes[i].selector} overlaps ${boxes[j].selector}`).toBe(false);
    }
  }
  const hasScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.documentElement.scrollHeight > document.documentElement.clientHeight);
  expect(hasScroll).toBe(false);
}

/** The lobby and floor 1's worst case: a long floor name/sub-line, every status pill, two toasts, the touch
 * controls and the phone button, all on screen together. */
async function setWorstCase(page: Page, { longText }: { longText: boolean }) {
  if (longText) {
    await page.locator('.floor-name').evaluate((el) => {
      el.textContent = 'ZetaSoft Industries International Holdings · The Lobby, Building 7, North Wing, Ground Floor Reception Area';
    });
    await page.locator('.floor-sub').evaluate((el) => {
      el.textContent = '42 agents · 17 working · 9 in QA · 5 ready to merge · 3 need you to look at something right now';
    });
  }
  // Two toasts (Player.tsx's mute binding pushes one each press). Toasts auto-dismiss after a few seconds
  // (store.ts's pushToast) and the demo's own chatter can add or remove its own toasts meanwhile, so don't wait on
  // an exact count: press both right away and measure promptly, whatever is actually on screen at that point.
  // (toPass retries the pair of presses: the very first key after a fresh page load occasionally doesn't land.)
  await expect(async () => {
    await page.keyboard.press('m');
    await page.keyboard.press('m');
    await expect(page.locator('.toast').first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 10_000 });
}

test.describe('phone HUD layout: no overlaps, nothing off-screen', () => {
  test.use(S23);

  for (const [name, viewport] of VIEWPORTS) {
    test(`lobby (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      await setWorstCase(page, { longText: true });
      await assertNoOverlapOnScreen(page, viewport);
    });
  }

  for (const [name, viewport] of [
    ['portrait 360x780', { width: 360, height: 780 }],
    ['landscape 780x360', { width: 780, height: 360 }],
  ] as const) {
    test(`floor 1 (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startAt(page, FLOOR_1_SPOT);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      await setWorstCase(page, { longText: true });
      await assertNoOverlapOnScreen(page, viewport);
    });
  }
});
