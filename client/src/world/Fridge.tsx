import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store';
import { noise, tone, type Vec3 } from '../ui/sfx';
import {
  SNACKS,
  SNACK_KINDS,
  ageFridge,
  fridgeNow,
  formatWait,
  putBackOnFloor,
  puddlesOf,
  shelfOf,
  takeFromFloor,
  type Shelf,
  type SnackKind,
} from './fridge';
import { useInteractable } from './interact';
import { glow, toon } from './materials';
import { Outlines } from './Outlines';
import { withoutDrop } from './toys/sipping';

// The kitchenette's fridge and freezer: E on the door opens or shuts it (a seal sound, the inside light coming on),
// E on a shelf takes a snack or puts an untouched one back, and the snack is eaten a portion at a time wherever you
// aim (toys/sip.ts, toys/sipping.ts), like the roof's sausage. One instance is ever drawn (only the current floor),
// so its door state lives here as module state, the same way CoffeeMachine.tsx's brew does; the shelves and any
// puddles (fridge.ts) are keyed by floor and outlive a floor change.

const INK = '#1f1d2b';
const OPEN_ANGLE = (100 * Math.PI) / 180;
const OPEN_S = 0.35;

// The fridge's footprint: 0.8 (x, depth) by 2 (y, height) by 0.8 (z, width), split into the fridge below and the
// freezer on top. `position` is its base centre on the floor (y = 0 at the kitchenette's counter level).
const DEPTH = 0.8;
const WIDTH = 0.8;
const FREEZER_H = 0.6;
const FRIDGE_H = 1.4;
const FRONT_X = -DEPTH / 2;
const WALL = 0.03;

let fridgeOpen = false;
let freezerOpen = false;
let curFloor = 0;
const listeners = new Set<() => void>();
function emit() {
  for (const fn of listeners) fn();
}

let seq = 1;

// Where the doors are in the world, for their sounds (filled in once drawn).
const fridgeSpot: Vec3 = { x: 0, y: 0, z: 0 };
const freezerSpot: Vec3 = { x: 0, y: 0, z: 0 };

const SFX = { group: 'toys' } as const;

const sounds = {
  seal: (pos: Vec3, opening: boolean) => {
    noise({ ...SFX, pos, name: 'fridge-seal', dur: opening ? 0.3 : 0.22, peak: 0.045, filter: 'lowpass', freq: opening ? 420 : 320, to: opening ? 650 : 220, attack: 0.02 });
    tone({ ...SFX, pos, name: 'fridge-seal', freq: opening ? 180 : 140, to: opening ? 140 : 100, type: 'sine', dur: 0.14, peak: 0.02, attack: 0.02 });
  },
  take: (pos: Vec3) => tone({ ...SFX, pos, name: 'fridge-take', freq: 900, to: 1300, type: 'triangle', dur: 0.1, peak: 0.035, attack: 0.004 }),
  putBack: (pos: Vec3) => tone({ ...SFX, pos, name: 'fridge-putback', freq: 500, to: 300, type: 'triangle', dur: 0.12, peak: 0.03, attack: 0.004 }),
  nope: (pos: Vec3) => {
    tone({ ...SFX, pos, name: 'fridge-nope', freq: 220, to: 160, type: 'square', dur: 0.1, peak: 0.04 });
    tone({ ...SFX, pos, name: 'fridge-nope', freq: 190, to: 130, type: 'square', at: 0.12, dur: 0.12, peak: 0.04 });
  },
};

export type FridgeOp = 'door' | 'freezer' | 'shelf';

/** E on the fridge: toggle a door, or take/put back a snack on a shelf. */
export function fridgeAction(op: FridgeOp, snack?: SnackKind) {
  const s = useStore.getState();
  if (op === 'door') {
    fridgeOpen = !fridgeOpen;
    sounds.seal(fridgeSpot, fridgeOpen);
    emit();
    return;
  }
  if (op === 'freezer') {
    freezerOpen = !freezerOpen;
    sounds.seal(freezerSpot, freezerOpen);
    emit();
    return;
  }
  if (!snack) return;
  const def = SNACKS[snack];
  const spot = def.freezer ? freezerSpot : fridgeSpot;
  const held = s.held;
  if (held?.kind === 'snack' && held.snack === snack) {
    if (held.left < def.portions) {
      s.pushToast('info', `${def.emoji} Finish it first, then put it back`);
      return;
    }
    withoutDrop(() => s.setHeld(null));
    putBackOnFloor(curFloor, snack, fridgeNow());
    sounds.putBack(spot);
    return;
  }
  if (held?.kind === 'snack' || held?.kind === 'sausage') {
    s.pushToast('info', '🙌 One at a time: finish eating first');
    return;
  }
  const r = takeFromFloor(curFloor, snack, fridgeNow());
  if (!r.ok) {
    sounds.nope(spot);
    s.pushToast('info', `${def.emoji} No ${def.name} left, more in ${formatWait(r.waitS)}`);
    return;
  }
  s.setHeld({ kind: 'snack', id: `snack-${seq++}`, snack, left: def.portions, outAt: fridgeNow() });
  sounds.take(spot);
}

function shelfLabel(snack: SnackKind, shelf: Shelf, held: ReturnType<typeof useStore.getState>['held'], now: number): string {
  const def = SNACKS[snack];
  if (held?.kind === 'snack' && held.snack === snack) {
    if (held.left < def.portions) return `${def.emoji} Finish it first`;
    return def.freezer ? `${def.emoji} Put the ${def.name} in the freezer` : `${def.emoji} Put the ${def.name} back`;
  }
  if (held?.kind === 'snack' || held?.kind === 'sausage') return '🙌 Your hands are full';
  const n = shelf[snack].n;
  if (n <= 0) return `${def.emoji} No ${def.name} left, more in ${formatWait(nextWaitFor(shelf, snack, now))}`;
  return `${def.emoji} Take ${def.article} ${def.name} (${n} left)`;
}

function nextWaitFor(shelf: Shelf, snack: SnackKind, now: number) {
  const s = shelf[snack];
  return s.lowSince === null ? 0 : Math.max(0, 60 - ((now - s.lowSince) % 60));
}

/** The toon shelf items for one kind: full `stock` of them, only the first `n` shown. */
function ShelfItems({ snack, n, positions, color }: { snack: SnackKind; n: number; positions: [number, number, number][]; color: string }) {
  return (
    <>
      {positions.map((p, i) => (
        <group key={i} visible={i < n} position={p}>
          {snack === 'water' ? (
            <mesh material={toon(color)} castShadow>
              <cylinderGeometry args={[0.035, 0.035, 0.12, 10]} />
              <Outlines thickness={0.006} color={INK} />
            </mesh>
          ) : snack === 'icecream' ? (
            <mesh rotation={[Math.PI, 0, 0]} material={toon(color)} castShadow>
              <coneGeometry args={[0.055, 0.1, 10]} />
              <Outlines thickness={0.007} color={INK} />
            </mesh>
          ) : snack === 'candy' ? (
            <mesh material={toon(color)} castShadow>
              <sphereGeometry args={[0.035, 10, 8]} />
              <Outlines thickness={0.006} color={INK} />
            </mesh>
          ) : (
            <mesh material={toon(color)} castShadow>
              <boxGeometry args={[0.1, 0.03, 0.045]} />
              <Outlines thickness={0.006} color={INK} />
            </mesh>
          )}
        </group>
      ))}
    </>
  );
}

const BAR_POS: [number, number, number][] = [-0.24, -0.08, 0.08, 0.24].map((z) => [-0.18, 0.95, z]);
const WATER_POS: [number, number, number][] = [-0.24, -0.08, 0.08, 0.24].map((z) => [-0.18, 0.5, z]);
const CANDY_POS: [number, number, number][] = [-0.26, -0.15, -0.04, 0.07, 0.18, 0.29].map((z) => [-0.18, 0.15, z]);
const ICE_POS: [number, number, number][] = [-0.18, 0, 0.18].map((z) => [-0.18, 1.72, z]);

// How wide a fixed strip, dead ahead where you stood to open it, stays aimable for closing the door once it's
// open: narrow enough to leave the shelf items to either side of it free to aim at (unlike the full-width closed
// hit box, which would cover the whole opening again).
const AJAR_WIDTH = 0.2;

function Door({ y, height, x, width, open, pos, label, action }: { y: number; height: number; x: number; width: number; open: boolean; pos: Vec3; label: string; action: { kind: 'fridge'; op: 'door' | 'freezer' } }) {
  const swing = useRef<THREE.Group>(null);
  const t = useRef(open ? 1 : 0);
  // Closed, the whole front is the hit box (there's nothing behind it yet to leave clear). Open, that would block
  // the shelves again, so a narrow fixed strip takes over: still dead ahead of where you opened it (so E there
  // closes it too), but out of the way of the shelf items to either side.
  const closedRef = useInteractable<THREE.Group>(!open ? { id: `fridge:${action.op}`, label, action } : null, 2.6);
  const ajarRef = useInteractable<THREE.Group>(open ? { id: `fridge:${action.op}`, label, action } : null, 2.6);
  useFrame((_, dt) => {
    t.current = Math.min(1, Math.max(0, t.current + (open ? dt : -dt) / OPEN_S));
    if (swing.current) swing.current.rotation.y = t.current * OPEN_ANGLE;
  });
  useEffect(() => {
    if (swing.current) {
      swing.current.updateWorldMatrix(true, false);
      const at = swing.current.localToWorld(new THREE.Vector3(0, 0, -width / 2));
      pos.x = at.x;
      pos.y = at.y;
      pos.z = at.z;
    }
  }, [pos, width]);
  return (
    <group position={[x, y, 0]}>
      <group ref={closedRef}>
        <mesh visible={false}>
          <boxGeometry args={[0.12, height, width]} />
        </mesh>
      </group>
      <group ref={ajarRef}>
        <mesh visible={false}>
          <boxGeometry args={[0.12, height, AJAR_WIDTH]} />
        </mesh>
      </group>
      <group ref={swing} position={[0, 0, width / 2]}>
        <mesh position={[0, 0, -width / 2]} material={toon('#f1f3f5')} castShadow>
          <boxGeometry args={[0.06, height, width]} />
          <Outlines thickness={0.014} color={INK} />
        </mesh>
        <mesh position={[-0.05, 0, -width + 0.1]} material={toon('#adb5bd')}>
          <boxGeometry args={[0.035, height * 0.28, 0.045]} />
        </mesh>
      </group>
    </group>
  );
}

/** A hollow compartment's walls (back, sides, top, bottom), open at -x where its door swings: so what's on the
 * shelves inside, and the glow of its light, actually show once the door is open. */
function CabinetWalls({ bottom, top, color }: { bottom: number; top: number; color: string }) {
  const mat = toon(color);
  const mid = (bottom + top) / 2;
  const height = top - bottom;
  return (
    <>
      <mesh position={[DEPTH / 2 - WALL / 2, mid, 0]} material={mat} castShadow>
        <boxGeometry args={[WALL, height, WIDTH]} />
        <Outlines thickness={0.018} color={INK} />
      </mesh>
      <mesh position={[0, mid, -WIDTH / 2 + WALL / 2]} material={mat} castShadow>
        <boxGeometry args={[DEPTH, height, WALL]} />
      </mesh>
      <mesh position={[0, mid, WIDTH / 2 - WALL / 2]} material={mat} castShadow>
        <boxGeometry args={[DEPTH, height, WALL]} />
      </mesh>
      <mesh position={[0, top - WALL / 2, 0]} material={mat} castShadow>
        <boxGeometry args={[DEPTH, WALL, WIDTH]} />
        <Outlines thickness={0.018} color={INK} />
      </mesh>
      <mesh position={[0, bottom + WALL / 2, 0]} material={mat} castShadow>
        <boxGeometry args={[DEPTH, WALL, WIDTH]} />
      </mesh>
    </>
  );
}

/** The kitchenette's fridge and freezer, standing on the floor at `position` (base centre, front facing -x). */
export function Fridge({ position, floor }: { position: [number, number, number]; floor: number }) {
  const [open, setOpen] = useState({ fridge: fridgeOpen, freezer: freezerOpen });
  const held = useStore((s) => s.held);
  const [, retick] = useState(0);

  useEffect(() => {
    curFloor = floor;
    fridgeOpen = false;
    freezerOpen = false;
    setOpen({ fridge: false, freezer: false });
    const fn = () => setOpen({ fridge: fridgeOpen, freezer: freezerOpen });
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [floor]);

  // The shelf counts and the restock clock change on their own: a slow re-render keeps the hint (and a wait
  // countdown) current without the whole floor re-rendering every frame for it.
  useEffect(() => {
    const id = setInterval(() => retick((n) => (n + 1) % 1_000_000), 500);
    return () => clearInterval(id);
  }, []);

  const shelf = shelfOf(curFloor);
  const now = fridgeNow();
  const bar = useInteractable<THREE.Group>(open.fridge ? { id: 'fridge:bar', label: shelfLabel('bar', shelf, held, now), action: { kind: 'fridge', op: 'shelf', snack: 'bar' } } : null, 2.4);
  const water = useInteractable<THREE.Group>(open.fridge ? { id: 'fridge:water', label: shelfLabel('water', shelf, held, now), action: { kind: 'fridge', op: 'shelf', snack: 'water' } } : null, 2.4);
  const candy = useInteractable<THREE.Group>(open.fridge ? { id: 'fridge:candy', label: shelfLabel('candy', shelf, held, now), action: { kind: 'fridge', op: 'shelf', snack: 'candy' } } : null, 2.4);
  const icecream = useInteractable<THREE.Group>(open.freezer ? { id: 'fridge:icecream', label: shelfLabel('icecream', shelf, held, now), action: { kind: 'fridge', op: 'shelf', snack: 'icecream' } } : null, 2.4);

  return (
    <group position={position}>
      {/* the hollow cabinet, open at -x: fridge below, freezer on top */}
      <CabinetWalls bottom={0} top={FRIDGE_H} color="#ced4da" />
      <CabinetWalls bottom={FRIDGE_H} top={FRIDGE_H + FREEZER_H} color="#dee2e6" />
      {/* the inside light, on with the door */}
      <group position={[0, FRIDGE_H / 2, 0]} visible={open.fridge}>
        <mesh material={glow('#fff9db')}>
          <boxGeometry args={[0.02, FRIDGE_H - 0.1, WIDTH - 0.1]} />
        </mesh>
      </group>
      <group position={[0, FRIDGE_H + FREEZER_H / 2, 0]} visible={open.freezer}>
        <mesh material={glow('#d0ebff')}>
          <boxGeometry args={[0.02, FREEZER_H - 0.08, WIDTH - 0.1]} />
        </mesh>
      </group>

      <Door y={FRIDGE_H / 2} height={FRIDGE_H - 0.02} x={FRONT_X} width={WIDTH} open={open.fridge} pos={fridgeSpot} label={open.fridge ? 'Close the fridge' : 'Open the fridge'} action={{ kind: 'fridge', op: 'door' }} />
      <Door y={FRIDGE_H + FREEZER_H / 2} height={FREEZER_H - 0.02} x={FRONT_X} width={WIDTH} open={open.freezer} pos={freezerSpot} label={open.freezer ? 'Close the freezer' : 'Open the freezer'} action={{ kind: 'fridge', op: 'freezer' }} />

      {open.fridge && (
        <>
          <group ref={bar}>
            <ShelfItems snack="bar" n={shelf.bar.n} positions={BAR_POS} color="#8a5a32" />
          </group>
          <group ref={water}>
            <ShelfItems snack="water" n={shelf.water.n} positions={WATER_POS} color="#8ecae6" />
          </group>
          <group ref={candy}>
            <ShelfItems snack="candy" n={shelf.candy.n} positions={CANDY_POS} color="#f72585" />
          </group>
        </>
      )}
      {open.freezer && (
        <group ref={icecream}>
          <ShelfItems snack="icecream" n={shelf.icecream.n} positions={ICE_POS} color="#f8f0e3" />
        </group>
      )}
    </group>
  );
}

// ---------- probe ----------

export interface FridgeSnapshot {
  fridgeOpen: boolean;
  freezerOpen: boolean;
  stock: Record<SnackKind, number>;
  puddles: { x: number; z: number }[];
}

if (typeof window !== 'undefined' && !Object.getOwnPropertyDescriptor(window, '__swarmFridge')) {
  Object.defineProperty(window, '__swarmFridge', {
    get: (): FridgeSnapshot => {
      const shelf = shelfOf(curFloor);
      const stock = {} as Record<SnackKind, number>;
      for (const k of SNACK_KINDS) stock[k] = shelf[k].n;
      return { fridgeOpen, freezerOpen, stock, puddles: puddlesOf(curFloor).map((p) => ({ x: p.x, z: p.z })) };
    },
    enumerable: false,
    configurable: false,
  });
  // __swarmFridgeDo('fridge' | 'freezer'): toggle a door. 'take', kind: take a snack. 'putBack': put the held one back.
  // 'age', seconds: moves the virtual clock (restocks, melt) ahead without a real wait.
  Object.defineProperty(window, '__swarmFridgeDo', {
    value: (op: 'fridge' | 'freezer' | 'take' | 'putBack' | 'age', arg?: SnackKind | number) => {
      if (op === 'fridge') fridgeAction('door');
      else if (op === 'freezer') fridgeAction('freezer');
      else if (op === 'take') fridgeAction('shelf', arg as SnackKind);
      else if (op === 'putBack') {
        const held = useStore.getState().held;
        if (held?.kind === 'snack') fridgeAction('shelf', held.snack);
      } else if (op === 'age') ageFridge(arg as number);
    },
    enumerable: false,
    configurable: false,
  });
}
