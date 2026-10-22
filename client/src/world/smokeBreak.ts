// The smoke break (issue #57): a little table in the gap beyond every balcony bench, and on the roof. Pure rules —
// the three nooks (bench, table, gap and seats), the roll/light/puff stage machine and the 90 s go-out timer — plus a
// tiny registry the mounted nook (SmokeBreak.tsx) uses to answer Player.tsx's "what's here" and E (no React, no THREE).

import { PLAYER_RADIUS, ROOF_SMOKE_BENCH, ROOF_SMOKE_TABLE, SIDES, balconyFurniture, type Rect } from './layout';
import { leavePerch, perch } from './perch';

export type NookId = 'office-west' | 'office-east' | 'roof';

export interface SmokeSeat {
  x: number;
  z: number;
}

export interface SmokeNook {
  id: NookId;
  bench: Rect;
  table: Rect;
  /** Where you stand, between the bench and the table, to get the "Sit down" prompt — the bench's whole length. */
  gap: Rect;
  /** The bench's two seats (its centre ± 0.45). */
  seats: readonly [SmokeSeat, SmokeSeat];
  /** The view's yaw once seated: away from the wall (or, on the roof, out over the parapet). */
  yaw: number;
}

function buildNook(id: NookId, bench: Rect, table: Rect): SmokeNook {
  const bz = (bench.minZ + bench.maxZ) / 2;
  const xs = [bench.minX, bench.maxX, table.minX, table.maxX].sort((a, b) => a - b);
  const gap: Rect = { minX: xs[1], maxX: xs[2], minZ: bench.minZ, maxZ: bench.maxZ };
  const benchCx = (bench.minX + bench.maxX) / 2;
  const tableCx = (table.minX + table.maxX) / 2;
  const toward = Math.sign(tableCx - benchCx) || 1; // which way the table (and so the view) is, from the bench
  // On the bench itself (Outside.tsx's furnitureGeometry seatX), nudged a touch towards the gap, not floating in it.
  const seatX = benchCx + toward * 0.04;
  const yaw = toward < 0 ? Math.PI / 2 : -Math.PI / 2;
  return { id, bench, table, gap, yaw, seats: [{ x: seatX, z: bz - 0.45 }, { x: seatX, z: bz + 0.45 }] };
}

/** Every office floor's two balcony nooks (same layout on every floor) and the roof's. */
export const NOOKS: readonly SmokeNook[] = [
  ...SIDES.map((side) => {
    const { bench, table } = balconyFurniture('office', side);
    return buildNook(side === 'west' ? 'office-west' : 'office-east', bench, table!);
  }),
  buildNook('roof', ROOF_SMOKE_BENCH, ROOF_SMOKE_TABLE),
];

export const nook = (id: NookId): SmokeNook => NOOKS.find((n) => n.id === id)!;

/** Whether (x, z) is standing in nook `n`'s gap, where E offers to sit down. */
export const inGap = (n: SmokeNook, x: number, z: number): boolean => x >= n.gap.minX - PLAYER_RADIUS && x <= n.gap.maxX + PLAYER_RADIUS && z >= n.gap.minZ && z <= n.gap.maxZ;

// ---------- the stage machine ----------

export const PUFFS = 8;
export const ROLL_MS = 5000;
export const LIGHT_MS = 1000;
export const PUFF_MS = 1500;
/** No puff for this long and it goes out: "Light it" again. */
export const GO_OUT_MS = 90_000;
/** How many stubbed butts a table's ashtray keeps showing this session. */
export const MAX_BUTTS = 5;

export type Stage = 'empty' | 'rolling' | 'ready' | 'lighting' | 'lit' | 'puffing' | 'out';

export interface SmokeState {
  stage: Stage;
  puffsLeft: number;
  /** ms timestamp the current timed stage (rolling/lighting/puffing) started. */
  since: number;
  /** ms timestamp of the last puff (or the light), for the go-out timer. */
  lastPuffAt: number;
}

export const newSmoke = (now: number): SmokeState => ({ stage: 'empty', puffsLeft: PUFFS, since: now, lastPuffAt: now });

/** E: rolls one, lights it (fresh or re-lighting one that went out), or takes a puff. Mid-animation, a stray E does nothing. */
export function pressE(s: SmokeState, now: number): SmokeState {
  if (s.stage === 'empty') return { ...s, stage: 'rolling', since: now };
  if (s.stage === 'ready' || s.stage === 'out') return { ...s, stage: 'lighting', since: now };
  if (s.stage === 'lit' && s.puffsLeft > 0) return { ...s, stage: 'puffing', since: now };
  return s;
}

/** Advances a timed stage once its time is up. `butt` is true the instant the (finished) one goes into the ashtray. */
export function tickSmoke(s: SmokeState, now: number): { state: SmokeState; butt: boolean } {
  if (s.stage === 'rolling' && now - s.since >= ROLL_MS) return { state: { ...s, stage: 'ready', since: now }, butt: false };
  if (s.stage === 'lighting' && now - s.since >= LIGHT_MS) return { state: { ...s, stage: 'lit', since: now, lastPuffAt: now }, butt: false };
  if (s.stage === 'puffing' && now - s.since >= PUFF_MS) {
    const left = s.puffsLeft - 1;
    if (left <= 0) return { state: { stage: 'empty', puffsLeft: PUFFS, since: now, lastPuffAt: now }, butt: true };
    return { state: { ...s, stage: 'lit', puffsLeft: left, since: now, lastPuffAt: now }, butt: false };
  }
  if (s.stage === 'lit' && now - s.lastPuffAt >= GO_OUT_MS) return { state: { ...s, stage: 'out', since: now }, butt: false };
  return { state: s, butt: false };
}

/** Getting up: an unfinished one (anything but 'empty') stubs into the ashtray. */
export const standUpSmoke = (s: SmokeState): { butt: boolean } => ({ butt: s.stage !== 'empty' });

/** Adds a stubbed butt to a table's ashtray, capped at MAX_BUTTS for the session. */
export const addButt = (count: number): number => Math.min(MAX_BUTTS, count + 1);

/** What the HUD shows on E, for the stage `s` is in. */
export function smokeLabel(s: SmokeState): string {
  switch (s.stage) {
    case 'empty':
      return 'Roll one';
    case 'rolling':
      return 'Rolling…';
    case 'ready':
      return 'Light it';
    case 'lighting':
      return 'Lighting…';
    case 'lit':
      return `Take a puff · ${s.puffsLeft} left`;
    case 'puffing':
      return 'Puffing…';
    case 'out':
      return 'Light it';
  }
}

// ---------- the mounted nooks' registry (SmokeBreak.tsx; Player.tsx reads it, store.ts's runFocusAction drives it) ----------

/** A minimal stand-in for store.ts's Focus, so this file doesn't import the store (and stays easy to test). */
export interface SmokeFocus {
  id: string;
  label: string;
  op: string;
}

export interface NookHandle {
  /** The "Sit down" prompt for standing at (x, z), or null (already seated, or out of the gap). */
  focusAt(x: number, z: number): SmokeFocus | null;
  /** Sits you down in the nearer free seat; a toast if both are taken. */
  sit(): void;
  /** E while perched here: advances the stage machine. */
  press(): void;
  /** What E does right now, while perched here ("Roll one", "Take a puff · 5 left", ...). */
  label(): string;
  /** For the probe: seat occupancy and the ashtray. */
  report(): { seats: ['free' | 'you', 'free' | 'you']; butts: number; stage?: Stage; puffsLeft?: number };
}

const handles = new Map<NookId, NookHandle>();

/** The mounted nook `id` takes focus/E while it's here. */
export function registerNook(id: NookId, h: NookHandle): () => void {
  handles.set(id, h);
  return () => {
    if (handles.get(id) === h) handles.delete(id);
  };
}

/** The "Sit down" focus for standing at (x, z) in whichever mounted nook's gap it's in, or null. */
export function smokeFocusAt(x: number, z: number): SmokeFocus | null {
  for (const h of handles.values()) {
    const f = h.focusAt(x, z);
    if (f) return f;
  }
  return null;
}

/** The focus to show while perched at a mounted nook: E's current stage label. */
export function smokeBreakFocus(id: NookId): SmokeFocus | null {
  const h = handles.get(id);
  return h ? { id: `smoke:${id}`, label: h.label(), op: `press:${id}` } : null;
}

/** store.ts's runFocusAction, for a `smokeBreak` focus: `sit:<nookId>` or `press:<nookId>`. */
export function runSmokeBreakOp(op: string) {
  const i = op.indexOf(':');
  if (i < 0) return;
  const id = op.slice(i + 1) as NookId;
  const h = handles.get(id);
  if (!h) return;
  if (op.slice(0, i) === 'sit') h.sit();
  else if (op.slice(0, i) === 'press') h.press();
}

/** For the probe and tests: every mounted nook's seats and ashtray. */
export const smokeNookReports = (): { id: NookId; seats: ['free' | 'you', 'free' | 'you']; butts: number }[] =>
  [...handles.entries()].map(([id, h]) => ({ id, ...h.report() }));

/** The mounted nook (and seat) you're sitting at, from a perch id of the form `smoke:<nookId>:<seat>`. */
export function parseSmokePerchId(perchId: string): { nookId: NookId; seat: 0 | 1 } | null {
  const m = /^smoke:([^:]+):([01])$/.exec(perchId);
  return m ? { nookId: m[1] as NookId, seat: Number(m[2]) as 0 | 1 } : null;
}

// ---------- the probe (window.__swarmSmokeBreak / __swarmSmokeBreakDo, for QA and Playwright) ----------

function probeMe() {
  const parsed = parseSmokePerchId(perch()?.id ?? '');
  const r = parsed && handles.get(parsed.nookId)?.report();
  if (!parsed || !r) return null;
  return { nook: parsed.nookId, seat: parsed.seat, stage: r.stage ?? null, puffsLeft: r.puffsLeft ?? null, lit: r.stage === 'lit' || r.stage === 'puffing' };
}

if (typeof window !== 'undefined') {
  const probe = {
    get nooks() {
      return smokeNookReports();
    },
    get me() {
      return probeMe();
    },
  };
  (window as unknown as Record<string, unknown>).__swarmSmokeBreak = probe;
  (window as unknown as Record<string, unknown>).__swarmSmokeBreakDo = (action: 'sit' | 'roll' | 'light' | 'puff' | 'up', nookId?: NookId) => {
    if (action === 'up') {
      leavePerch();
      return;
    }
    if (action === 'sit') {
      if (nookId) runSmokeBreakOp(`sit:${nookId}`);
      return;
    }
    // 'roll' / 'light' / 'puff' are all just E, whichever nook you're already sitting at
    const parsed = parseSmokePerchId(perch()?.id ?? '');
    if (parsed) runSmokeBreakOp(`press:${parsed.nookId}`);
  };
}
