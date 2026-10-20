// Touch controls: whether this device gets them, and the pure maths behind the on-screen joystick and gestures.
// TouchControls.tsx (ui/) drives `touchInput` from touch events; Player.tsx and CameraRig.tsx read it each frame.

import { create } from 'zustand';

/** Whether to show touch controls: the URL's say, then a coarse (touch-only) pointer. */
export function touchUi(x: { param: string | null; coarse: boolean }): boolean {
  if (x.param !== null) return x.param !== '0' && x.param !== 'false';
  return x.coarse;
}

function startTouch(): boolean {
  return touchUi({
    param: new URLSearchParams(location.search).get('touch'),
    coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
  });
}

export const useTouch = create<{ on: boolean }>(() => ({ on: typeof window === 'undefined' ? false : startTouch() }));

/** A stick pushed `radius` worth of ring is run: past this share of it. */
const RUN_AT = 0.9;
/** Smaller pushes than this share of the ring don't count: a thumb never sits perfectly centred. */
const STICK_DEADZONE = 0.12;

/** The joystick's thumb `(dx, dy)` away from its centre, in a ring `radius` px wide: -1..1 (y down-positive, as
 * the pad reports it), clamped to the ring, with a small deadzone and `run` once it's pushed past most of it. */
export function stick(dx: number, dy: number, radius: number): { x: number; y: number; run: boolean } {
  if (radius <= 0) return { x: 0, y: 0, run: false };
  const m = Math.hypot(dx, dy);
  const share = m / radius;
  if (share <= STICK_DEADZONE) return { x: 0, y: 0, run: false };
  const clamped = Math.min(share, 1);
  return { x: (dx / m) * clamped, y: (dy / m) * clamped, run: clamped >= RUN_AT };
}

export type Gesture = 'tap' | 'longPress' | 'drag';

/** How far (px) and how long a touch moved before it ended (or, while held, has been held so far). */
const TAP_PX = 10;
const TAP_MS = 350;
const LONG_PRESS_MS = 500;

/** Tells a tap (short, still) from a long press (still, held) from a drag (moved). */
export function gesture(movedPx: number, ms: number): Gesture {
  if (movedPx < TAP_PX) {
    if (ms < TAP_MS) return 'tap';
    if (ms >= LONG_PRESS_MS) return 'longPress';
  }
  return 'drag';
}

/** A pinch's zoom delta, in the same sign and rough scale as a mouse wheel's deltaY (zoomView, rig.ts):
 * fingers spreading (dist growing) zooms in, so it comes out negative, matching a scroll-up. */
export function pinchDelta(prevDist: number, dist: number): number {
  return prevDist - dist;
}

export interface TouchInput {
  x: number;
  y: number;
  run: boolean;
  lookDx: number;
  lookDy: number;
}

/** Read each frame by Player.tsx (walk) and consumed there (look deltas zeroed after use). */
export const touchInput: TouchInput = { x: 0, y: 0, run: false, lookDx: 0, lookDy: 0 };
