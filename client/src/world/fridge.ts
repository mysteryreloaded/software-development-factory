// The kitchenette's fridge and freezer, as pure rules (what's on the shelves, how it restocks, how ice cream melts
// and puddles), plus a small per-floor registry so the shelves and any puddles survive a floor change (a reload
// refills, same as the rest of the office). Fridge.tsx draws it and keeps the doors; toys/sip.ts and toys/sipping.ts
// eat what's in your hands, a bite/sip/go/lick at a time, the same way the roof's sausage is eaten.

export type SnackKind = 'bar' | 'water' | 'candy' | 'icecream';
export const SNACK_KINDS: readonly SnackKind[] = ['bar', 'water', 'candy', 'icecream'];

export interface SnackDef {
  emoji: string;
  name: string;
  /** "a" or "some", for "Take a protein bar" / "Take some candy". */
  article: string;
  /** What a portion is called ("bite", "sip", "go", "lick"); pluralised with an s. */
  portionNoun: string;
  portions: number;
  stock: number;
  /** Lives in the freezer, not the fridge. */
  freezer: boolean;
}

export const SNACKS: Record<SnackKind, SnackDef> = {
  bar: { emoji: '🍫', name: 'protein bar', article: 'a', portionNoun: 'bite', portions: 3, stock: 4, freezer: false },
  water: { emoji: '💧', name: 'water', article: 'a', portionNoun: 'sip', portions: 4, stock: 4, freezer: false },
  candy: { emoji: '🍬', name: 'candy', article: 'some', portionNoun: 'go', portions: 1, stock: 6, freezer: false },
  icecream: { emoji: '🍦', name: 'ice cream', article: 'some', portionNoun: 'lick', portions: 3, stock: 3, freezer: true },
};

export const portionNoun = (kind: SnackKind, left: number) => SNACKS[kind].portionNoun + (left === 1 ? '' : 's');

/** Seconds between +1 restocks of a kind, counted from when it first went below its full stock. */
export const RESTOCK = 60;

/** Seconds held before ice cream sags and drips, and before it leaves your hands as a puddle. */
export const MELT = { soft: 20, puddle: 60 };

/** How long a puddle lasts (seconds), and the most on a floor at once (the oldest goes first). */
export const PUDDLE = { life: 180, cap: 6 };

// ---------- shelves ----------

export interface Stock {
  n: number;
  /** When this kind first went below its full stock; null once it's full again. */
  lowSince: number | null;
}

export type Shelf = Record<SnackKind, Stock>;

export const fullShelf = (): Shelf => {
  const out = {} as Shelf;
  for (const k of SNACK_KINDS) out[k] = { n: SNACKS[k].stock, lowSince: null };
  return out;
};

/** Restocks whatever's due by `now` (seconds): one kind at a time, +1 every RESTOCK s until it's full again. */
export function restock(shelf: Shelf, now: number): Shelf {
  let out: Shelf | null = null;
  for (const k of SNACK_KINDS) {
    const s = shelf[k];
    if (s.lowSince === null) continue;
    const full = SNACKS[k].stock;
    const ticks = Math.floor((now - s.lowSince) / RESTOCK);
    if (ticks <= 0) continue;
    const n = Math.min(full, s.n + ticks);
    out ??= { ...shelf };
    out[k] = { n, lowSince: n >= full ? null : s.lowSince + ticks * RESTOCK };
  }
  return out ?? shelf;
}

/** Seconds until `kind`'s next +1 restock; 0 once it's full. */
export function nextRestockIn(shelf: Shelf, kind: SnackKind, now: number): number {
  const s = shelf[kind];
  return s.lowSince === null ? 0 : Math.max(0, RESTOCK - ((now - s.lowSince) % RESTOCK));
}

export interface TakeResult {
  shelf: Shelf;
  ok: boolean;
  /** Seconds until one more is on the shelf, when `ok` is false. */
  waitS: number;
}

/** Takes one `kind` off the shelf (restocking first). */
export function takeSnack(shelf: Shelf, kind: SnackKind, now: number): TakeResult {
  const stocked = restock(shelf, now);
  const s = stocked[kind];
  if (s.n <= 0) return { shelf: stocked, ok: false, waitS: nextRestockIn(stocked, kind, now) };
  const full = SNACKS[kind].stock;
  const n = s.n - 1;
  const lowSince = s.lowSince ?? now;
  return { shelf: { ...stocked, [kind]: { n, lowSince: n >= full ? null : lowSince } }, ok: true, waitS: 0 };
}

/** Puts an untouched `kind` back on the shelf (the caller checks it's untouched, and that ice cream only goes in the freezer). */
export function putBack(shelf: Shelf, kind: SnackKind, now: number): Shelf {
  const stocked = restock(shelf, now);
  const s = stocked[kind];
  const full = SNACKS[kind].stock;
  if (s.n >= full) return stocked;
  const n = s.n + 1;
  return { ...stocked, [kind]: { n, lowSince: n >= full ? null : s.lowSince ?? now } };
}

// ---------- melt ----------

export type MeltStage = 'fresh' | 'soft' | 'puddle';

/** How melted a held ice cream is, from when it left the freezer (`outAt`) to `now` (seconds on the same clock). */
export function meltStage(outAt: number, now: number): MeltStage {
  const t = now - outAt;
  if (t >= MELT.puddle) return 'puddle';
  if (t >= MELT.soft) return 'soft';
  return 'fresh';
}

/** Seconds left before it becomes a puddle; 0 once it already has. */
export const meltCountdown = (outAt: number, now: number) => Math.max(0, MELT.puddle - (now - outAt));

// ---------- puddles ----------

export interface Puddle {
  id: string;
  x: number;
  z: number;
  bornAt: number;
}

/** Adds a puddle, dropping the oldest first if the floor is already at the cap. */
export function addPuddle(puddles: readonly Puddle[], puddle: Puddle): Puddle[] {
  const next = [...puddles, puddle];
  return next.length > PUDDLE.cap ? next.slice(next.length - PUDDLE.cap) : next;
}

/** Drops puddles whose `life` has passed (they dry up silently). */
export const dryPuddles = (puddles: readonly Puddle[], now: number): Puddle[] => puddles.filter((p) => now - p.bornAt < PUDDLE.life);

/** 1 (fresh) fading to 0 over a puddle's last 10 s. */
export function puddleFade(puddle: Puddle, now: number): number {
  const left = PUDDLE.life - (now - puddle.bornAt);
  return left >= 10 ? 1 : Math.max(0, left / 10);
}

// ---------- per-floor registry (survives floor changes; a reload refills) ----------

const shelves = new Map<number, Shelf>();
const puddlesByFloor = new Map<number, Puddle[]>();
let puddleSeq = 1;

/** A virtual clock in seconds, so e2e tests can skip ahead (window.__swarmFridgeDo('age', s)) without waiting for real time. */
let ageOffset = 0;
export const fridgeNow = () => performance.now() / 1000 + ageOffset;
export const ageFridge = (seconds: number) => {
  ageOffset += seconds;
};

/** `floor`'s shelf, restocked up to `now`. */
export function shelfOf(floor: number, now = fridgeNow()): Shelf {
  const s = restock(shelves.get(floor) ?? fullShelf(), now);
  shelves.set(floor, s);
  return s;
}

/** Takes one `kind` off `floor`'s shelf. */
export function takeFromFloor(floor: number, kind: SnackKind, now = fridgeNow()): TakeResult {
  const r = takeSnack(shelfOf(floor, now), kind, now);
  shelves.set(floor, r.shelf);
  return r;
}

/** Puts an untouched `kind` back on `floor`'s shelf. */
export function putBackOnFloor(floor: number, kind: SnackKind, now = fridgeNow()) {
  shelves.set(floor, putBack(shelfOf(floor, now), kind, now));
}

/** `floor`'s puddles, with any that have dried up removed. */
export function puddlesOf(floor: number, now = fridgeNow()): Puddle[] {
  const p = dryPuddles(puddlesByFloor.get(floor) ?? [], now);
  puddlesByFloor.set(floor, p);
  return p;
}

/** A puddle of melted ice cream at (x, z) on `floor`. */
export function dropPuddle(floor: number, x: number, z: number, now = fridgeNow()): Puddle {
  const list = addPuddle(puddlesOf(floor, now), { id: `puddle-${puddleSeq++}`, x, z, bornAt: now });
  puddlesByFloor.set(floor, list);
  return list[list.length - 1];
}

/** Seconds as "m:ss", for the wait-time toast ("more in 0:42"). */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
