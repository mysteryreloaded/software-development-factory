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

/** Every box the spec cares about (see issue #44): .hud's own children, .hud-top's children down through
 * .hud-top-scroll/.hud-top-lower/.aim-cards (the flow those nest in on a phone), each touch control, each toast,
 * and the phone button. Generic on purpose, so a control added later (e.g. a Jump button) is picked up without
 * editing this list. */
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
    // The wrapper containers (.hud-top, .hud-top-scroll, .hud-top-lower, .touch-controls, .touch-buttons, .toasts,
    // .aim-cards) only group other measured boxes: skip the wrapper itself (it always bounds its own children,
    // which isn't an overlap) and keep its children instead. The full-screen layers the issue exempts (.fade,
    // .crosshair, the emote wheel) are skipped too.
    const skip = ['.hud-top', '.hud-top-scroll', '.hud-top-lower', '.touch-controls', '.touch-buttons', '.toasts', '.aim-cards', '.fade', '.crosshair', '.emote-wheel'];
    document
      .querySelectorAll(
        '.hud > *, .hud-top > *, .hud-top-scroll > *, .hud-top-lower > *, .touch-controls > *, .touch-buttons > *, .toast, .phone-btn, .aim-cards > *',
      )
      .forEach((el, i) => {
        if (skip.some((w) => el.matches(w))) return;
        add(el, label(el, i));
      });
    return out;
  });
}

/** .toasts has no explicit width (shrink-to-fit, up to its max-width), so it measures each toast's text in the
 * page's own font (--font: Fredoka). Before that font finishes loading, the browser lays it out in a fallback
 * font with different metrics — wider, almost every time — then reflows narrower once Fredoka's ready; a read
 * mid-reflow sees the wider box and can clip or overlap something that the settled, narrower one wouldn't.
 * Waiting for fonts to be ready is the direct fix; retrying the whole read-and-check is a second safety net for
 * the same class of mid-layout read e2e/touch.spec.ts's stableView already waits out elsewhere. */
async function assertNoOverlapOnScreen(page: Page, viewport: { width: number; height: number }) {
  await page.evaluate(() => document.fonts.ready);
  await expect(async () => {
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
  }).toPass({ timeout: 5_000 });
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

// Issue #44 round 2: two states QA's first round never put on screen. (1) Aiming at a working agent's monitor
// pops up .aim-cards' AgentCard (AgentCard.tsx's AIM_MS) — in landscape it used to dock bottom-left, tall enough to
// climb into .hud-top above it. (2) Holding a ball turns the one "Use" touch button into up to three (Throw, Drop),
// growing .touch-buttons past where .toasts used to assume it stopped, in both orientations.
const TWO_VIEWPORTS = [
  ['portrait 360x780', { width: 360, height: 780 }],
  ['landscape 780x360', { width: 780, height: 360 }],
] as const;

// Floor 1, 1.4 m south of desk slot 0 (layout.ts's deskPosition(0)), facing it: the demo's agents start out busy,
// and desk 0 is always the first one filled.
const WORKING_DESK_SPOT: SavedView = { floor: 1, x: -10.5, z: 4.6, yaw: 0, pitch: -0.1 };

// The lobby, 1.6 m from the basketball under its hoop (toys.spec.ts's spot), facing it.
const BALL_SPOT: SavedView = { floor: 0, x: -9, z: 9.3, yaw: Math.PI, pitch: -0.73 };

test.describe('phone HUD layout round 2: the agent card and a grown touch-buttons column', () => {
  test.use(S23);

  for (const [name, viewport] of TWO_VIEWPORTS) {
    test(`aimed agent card (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startAt(page, WORKING_DESK_SPOT);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      await expect(page.locator('.agent-card')).toBeVisible({ timeout: 15_000 });
      await assertNoOverlapOnScreen(page, viewport);
    });
  }

  for (const [name, viewport] of TWO_VIEWPORTS) {
    test(`held ball + stacked toasts (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startAt(page, BALL_SPOT);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      const use = page.locator('.touch-btn-use');
      await expect(use).toHaveText('Pick up ball', { timeout: 90_000 });
      await use.click(); // a real touch device taps the on-screen button, not a keyboard that isn't there
      // Throw and Drop show an emoji, not that word, as their visible text (TouchControls.tsx's aria-label carries it).
      await expect(page.getByRole('button', { name: 'Throw' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Drop' })).toBeVisible();
      // HeldHint.tsx's own hint (the generic "throw/drop" one, for a ball): a real spot now, not hidden outright.
      await expect(page.locator('.hud-held')).toBeVisible();
      // 3 toasts (one more than the lobby/floor-1 worst case above), same mute binding (Player.tsx:359-362).
      await expect(async () => {
        await page.keyboard.press('m');
        await page.keyboard.press('m');
        await page.keyboard.press('m');
        await expect(page.locator('.toast').first()).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 10_000 });
      await assertNoOverlapOnScreen(page, viewport);
    });
  }
});

// Issue #44 round 4: (1) on the shortest portrait phones the agent card and a toast both flowed into the same
// band .toasts used to float over (round 3 only moved the card there) — now toasts flow in .hud-top too, after
// the held/aim hints, so none of the four can land on another. (2) a short landscape phone's .hud-top couldn't
// fit the whole card either (its own max-height, sized for the floor/status/chips boxes alone); the card gets its
// own corner there now (top-right, .aim-cards' landscape rules), sized to show it in full, not just avoid overlap.
/** `selector`'s own unclipped rect, and the same rect intersected with every scrolling ancestor's — equal only if
 * nothing actually clips it on screen. Shared by the agent card's and the newest toast's "shows whole" checks. */
async function ownVsClippedRect(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const own = el.getBoundingClientRect();
    let rect = own;
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
    const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    return { own: box(own), clipped: box(rect) };
  });
}

test.describe('phone HUD layout round 4: the agent card sharing a band with toasts and hints', () => {
  test.use(S23);

  for (const [name, viewport] of [
    ['portrait 320x568', { width: 320, height: 568 }],
    ['portrait 360x780', { width: 360, height: 780 }],
  ] as const) {
    test(`aimed card + a toast (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startAt(page, WORKING_DESK_SPOT);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      await expect(page.locator('.agent-card')).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('m');
      await expect(page.locator('.toast').first()).toBeVisible();
      // AgentCard.tsx's AIM_MS is 400ms, CareerPeek.tsx's own delay 700ms more: give both time to show and settle.
      await page.waitForTimeout(1000);
      await assertNoOverlapOnScreen(page, viewport);
    });
  }

  for (const [name, viewport] of [
    ['landscape 780x360', { width: 780, height: 360 }],
    ['landscape 844x390', { width: 844, height: 390 }],
  ] as const) {
    test(`aimed card shows whole, not clipped (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startAt(page, WORKING_DESK_SPOT);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      await expect(page.locator('.agent-card')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1000);
      const { own, clipped } = await ownVsClippedRect(page, '.agent-card');
      expect(clipped, 'the agent card is clipped by a scrolling ancestor').toEqual(own);
      await assertNoOverlapOnScreen(page, viewport);
    });

    test(`newest toast shows whole, not clipped (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      // 3 toasts, stacked (same mute binding as the round-2 "held ball" spec above): the newest is last in the DOM.
      await expect(async () => {
        await page.keyboard.press('m');
        await page.keyboard.press('m');
        await page.keyboard.press('m');
        await expect(page.locator('.toast').first()).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 10_000 });
      const { own, clipped } = await ownVsClippedRect(page, '.toast:last-child');
      expect(clipped, 'the newest toast is clipped by a scrolling ancestor').toEqual(own);
      await assertNoOverlapOnScreen(page, viewport);
    });
  }
});

// Issue #44 round 4's 4th fix: HeldHint.tsx now renders inside .aim-cards (round 2), so its own absolutely
// positioned pieces (the throw charge meter, the ammo counter, the ping-pong scoreboard) re-anchored to
// .aim-cards' own corner instead of the viewport .hud-hint gets — only visible on a wide-enough desktop window,
// where .aim-cards is itself positioned (on a phone it just flows, so there's nothing to re-anchor to). Desktop's
// own layout is otherwise out of scope for issue #44: this is the one state it can regress on a phone fix.
test.describe('phone HUD layout round 4: desktop stays unaffected', () => {
  test('the throw charge meter stays centred under the crosshair at 1280x800', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // In the lobby, 1.6 m north of the basketball under its hoop (toys.spec.ts's spot), facing it.
    await startAt(page, { floor: 0, x: -9, z: 9.3, yaw: Math.PI, pitch: -0.73 });
    await page.goto('/?pocket=0');
    await enterOffice(page, { loaded: true });
    await expect(page.getByText('Pick up ball')).toBeVisible({ timeout: 90_000 });
    await page.keyboard.press('e');
    await page.keyboard.down('KeyF'); // hold to charge (Key.tsx's default 'throw' binding)
    try {
      await expect(page.locator('.charge-on')).toBeVisible();
      const box = await page.locator('.charge').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width / 2, 'the charge meter is centred horizontally').toBeCloseTo(1280 / 2, 0);
    } finally {
      await page.keyboard.up('KeyF');
    }
  });
});

// Issue #71: Android drew a grey scrollbar thumb beside the floor card in `.hud-top-scroll`'s landscape clip
// (styles.css's `overflow-y: auto`, kept so a genuinely tall stack can still scroll by touch), even in states
// where nothing visibly overflows — `.hud-chips` renders with no children when its three chips are all hidden, but
// still claimed a flex gap on each side (a few px taller than the box), which was enough for Android to show the
// thumb. `scrollbar-width: none` / `::-webkit-scrollbar { display: none }` on the three scroll boxes hide the
// thumb outright; `.hud-chips:empty { display: none }` removes the extra gap so the lobby's landscape box doesn't
// scroll at all. 805x384 is the manager's own reported viewport (issue #71); the others are issue #44's set.
const SCROLLBAR_VIEWPORTS = [...VIEWPORTS, ['landscape 805x384 (reported)', { width: 805, height: 384 }] as const];

test.describe('phone HUD layout round 7: no visible scrollbar beside the floor card', () => {
  test.use(S23);

  for (const [name, viewport] of SCROLLBAR_VIEWPORTS) {
    // Only one box is actually a scroll box per orientation (styles.css's two mobile media queries): a tall-enough
    // portrait phone shares one clip on `.hud-top` itself; a short/landscape one splits it into `.hud-top-scroll`
    // (the floor card and pills) and `.hud-top-lower` (the aim card, hints and toasts) instead.
    const selectors = name.startsWith('portrait') ? ['.hud-top'] : ['.hud-top-scroll', '.hud-top-lower'];
    test(`scrollbar-width is none on the scroll boxes (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      for (const selector of selectors) {
        await expect(page.locator(selector)).toHaveCSS('scrollbar-width', 'none');
      }
    });
  }

  test('no scrollbar takes layout width even when a stack overflows (landscape 568x320)', async ({ page }) => {
    const viewport = { width: 568, height: 320 };
    await page.setViewportSize(viewport);
    await startAt(page, WORKING_DESK_SPOT);
    await page.goto('/?pocket=0');
    await enterOffice(page, { loaded: true });
    await skipTour(page);
    await setWorstCase(page, { longText: true });
    await expect(page.locator('.agent-card')).toBeVisible({ timeout: 15_000 });
    const gaps = await page.locator('.hud-top-scroll, .hud-top-lower').evaluateAll((els) =>
      (els as HTMLElement[]).map((el) => {
        const cs = getComputedStyle(el);
        const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
        return el.offsetWidth - el.clientWidth - borders;
      }),
    );
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(0.5);
  });

  test('nothing scrolls in the lobby at 805x384 (manager-reported viewport)', async ({ page }, testInfo) => {
    const viewport = { width: 805, height: 384 };
    await page.setViewportSize(viewport);
    await page.goto('/?pocket=0');
    await enterOffice(page, { loaded: true });
    await skipTour(page);
    const scroll = await page.locator('.hud-top-scroll').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(scroll.scrollHeight, '.hud-top-scroll should not scroll when the lobby card fits').toBeLessThanOrEqual(scroll.clientHeight);
    await page.screenshot({ path: testInfo.outputPath('lobby-805x384-top-left.png'), clip: { x: 0, y: 0, width: 420, height: 200 } });
  });
});

// Issue #44 round 6: the roof (in scope since the issue's "every floor kind (lobby, an office floor, the roof)")
// has its own .hud-hint, a direct child of .hud rather than nested in .aim-cards — the spec never put one of
// those on screen on a phone before. Sitting in a deck chair shows "🪑 Sitting back · …", testing .hud > .hud-hint
// (styles.css) the same way the lobby/floor-1 worst case above tests .hud-top: with every pill and a long floor
// name/sub-line on screen too (the deck chairs aren't on a repo floor, but the HUD doesn't know that).
test.describe('phone HUD layout round 6: the roof’s own hints', () => {
  test.use(S23);

  // Deck chair 0's front spot (layout.ts's deckChairFront(0)), facing back at the chair (the front spot sits
  // south of it, outside the decking, so the chair is behind-and-up from there).
  const DECK_CHAIR_FRONT: SavedView = { floor: -1, x: 4.4, z: -3.6, yaw: 2.99, pitch: -0.48 };

  for (const [name, viewport] of TWO_VIEWPORTS) {
    test(`sitting in a deck chair (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startAt(page, DECK_CHAIR_FRONT);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);
      const use = page.locator('.touch-btn-use');
      await expect(use).toHaveText('Sit back in the deck chair', { timeout: 15_000 });
      await use.click(); // a real touch device taps the on-screen button, not a keyboard that isn't there
      await expect(page.locator('.hud-hint', { hasText: 'Sitting back' })).toBeVisible();
      await setWorstCase(page, { longText: true });
      await assertNoOverlapOnScreen(page, viewport);
    });
  }
});

// Issue #85: the floor card and the status pills/chips in .hud-top-scroll fade their own background to 20% opacity
// (alpha 0.2) so the 3D world shows through, while their text stays fully opaque (never `opacity` on the element,
// which would fade the text too). High contrast (an accessibility setting) keeps today's solid backgrounds. This
// spec reads getComputedStyle(...).backgroundColor to check the alpha channel, on desktop and a phone viewport.

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

test.describe('HUD backgrounds fade to 20% opacity, high contrast keeps them solid (issue #85)', () => {
  for (const [name, viewport] of [
    ['desktop 1280x800', { width: 1280, height: 800 }],
    ['phone 390x844', { width: 390, height: 844 }],
  ] as const) {
    test(`floor card, pills and chips (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/?pocket=0');
      await enterOffice(page, { loaded: true });
      await skipTour(page);

      const floorCard = page.locator('.hud-floor');
      const livePill = page.locator('.hud-status .pill', { hasText: 'live' });
      const sessionsPill = page.locator('.hud-status .pill', { hasText: 'sessions' });
      const officeChip = page.locator('.hud-chips .office-chip');

      expect(alphaOf(await floorCard.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);
      expect(alphaOf(await livePill.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);
      expect(alphaOf(await sessionsPill.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);
      if (await officeChip.count()) {
        expect(alphaOf(await officeChip.first().evaluate((el) => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.2, 1);
      }
      // Text stays fully opaque (only the background fades).
      expect(alphaOf(await page.locator('.floor-name').evaluate((el) => getComputedStyle(el).color))).toBe(1);
      expect(alphaOf(await livePill.evaluate((el) => getComputedStyle(el).color))).toBe(1);

      await setHighContrast(page, true);
      expect(alphaOf(await floorCard.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
      expect(alphaOf(await livePill.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
      expect(alphaOf(await sessionsPill.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
      await setHighContrast(page, false);
    });
  }

  test('a .pill outside the HUD (the start screen) keeps a solid background', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?pocket=0');
    await expect(page.getByText(/DEMO MODE/)).toBeVisible();
    const demoPill = page.locator('.start .pill.pill-demo');
    expect(alphaOf(await demoPill.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
  });
});
