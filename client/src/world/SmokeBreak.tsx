import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Outlines } from './Outlines';
import { toon } from './materials';
import { merged } from './shapes';
import { leavePerch, setPerch } from './perch';
import { smokeCrackle, smokeGrind, smokeLight } from '../ui/sfx';
import { BENCH, type Rect } from './layout';
import { markBloom } from './gfx/bloomMarks';
import { playerAt } from './camera/rig';
import { FIRST_PERSON } from './viewTags';
import { useStore } from '../store';
import { myVisitorId, visitorsAtSeat } from './presence/presenceState';
import {
  MAX_BUTTS,
  PUFFS,
  PUFF_MS,
  ROLL_MS,
  addButt,
  agentAtSeat,
  inGap,
  newSmoke,
  nook,
  pressE,
  registerNook,
  smokeLabel,
  standUpSmoke,
  tickSmoke,
  type NookId,
  type SeatOwner,
  type SmokeState,
} from './smokeBreak';

// The smoke break's table, on every office balcony and the roof (layout.ts has the numbers; smokeBreak.ts the pure
// rules). This draws the table, its six things and the roof's bench, sits you down between bench and table on E, and
// drives the roll → light → puff stage machine while you're there. Only the nook you're sitting at animates; the
// joint itself lives in your right hand, camera-attached (HeldJoint, below), once it's rolled.

const INK = '#1f1d2b';
const WOOD = '#c9905a';
const METAL = '#6c757d';
const PAPER = '#f1e8d8';
const POUCH = '#8a6240';
const BAG = '#7cb342';
const ASH = '#495057';
const EMBER = '#ff7b3d';

/** The table's top, legs and its six things (less the grinder's lid and the rolling paper, animated apart), one
 * merged mesh per colour so a table costs a few draw calls. */
function propsGeometry(cx: number, cz: number, topY: number) {
  const wood: THREE.BufferGeometry[] = [new THREE.BoxGeometry(0.4, 0.05, 0.8).translate(cx, topY, cz)];
  for (const [dx, dz] of [[-0.15, -0.3], [0.15, -0.3], [-0.15, 0.3], [0.15, 0.3]]) wood.push(new THREE.BoxGeometry(0.04, topY - 0.025, 0.04).translate(cx + dx, (topY - 0.025) / 2, cz + dz));
  const metal: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.035, 0.035, 0.05, 12).translate(cx + 0.1, topY + 0.05, cz - 0.22), // grinder base
    new THREE.BoxGeometry(0.03, 0.06, 0.015).translate(cx + 0.14, topY + 0.055, cz + 0.05), // lighter
  ];
  const pouch = [new THREE.BoxGeometry(0.1, 0.03, 0.08).translate(cx - 0.13, topY + 0.04, cz + 0.05)];
  const bag = [new THREE.SphereGeometry(0.035, 10, 8).scale(1, 0.6, 1).translate(cx - 0.02, topY + 0.045, cz - 0.02)];
  const ash: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.045, 0.04, 0.025, 12).translate(cx - 0.12, topY + 0.0375, cz - 0.1),
    new THREE.CylinderGeometry(0.038, 0.038, 0.012, 12).translate(cx - 0.12, topY + 0.044, cz - 0.1),
  ];
  return { wood: merged(wood), metal: merged(metal), pouch: merged(pouch), bag: merged(bag), ash: merged(ash) };
}

/** The roof's own bench (the office balconies already draw theirs in Outside.tsx): a plain seat and back, facing +x. */
function benchGeometry(bench: Rect) {
  const cx = (bench.minX + bench.maxX) / 2;
  const cz = (bench.minZ + bench.maxZ) / 2;
  const parts = [
    new THREE.BoxGeometry(BENCH.w - 0.08, 0.08, BENCH.l).translate(cx, 0.46, cz),
    new THREE.BoxGeometry(0.08, 0.36, BENCH.l).translate(cx - BENCH.w / 2 + 0.04, 0.68, cz),
  ];
  for (const dz of [-BENCH.l / 2 + 0.15, BENCH.l / 2 - 0.15]) {
    parts.push(new THREE.BoxGeometry(BENCH.w - 0.12, 0.06, 0.06).translate(cx, 0.39, cz + dz));
    for (const dx of [-0.2, 0.2]) parts.push(new THREE.BoxGeometry(0.06, 0.42, 0.06).translate(cx + dx, 0.21, cz + dz));
  }
  return merged(parts);
}

const BUTT_SLOTS = Array.from({ length: MAX_BUTTS }, (_, i) => i);

/** A stubbed butt in the ashtray, at slot `i` of up to MAX_BUTTS. */
function Butt({ i, x, z, y }: { i: number; x: number; z: number; y: number }) {
  const a = (i / MAX_BUTTS) * Math.PI * 2;
  return (
    <mesh position={[x + Math.cos(a) * 0.025, y, z + Math.sin(a) * 0.025]} rotation={[0, a, Math.PI / 2]} material={toon(PAPER)} castShadow={false}>
      <cylinderGeometry args={[0.004, 0.004, 0.035, 6]} />
    </mesh>
  );
}

const emberMaterial = markBloom(new THREE.MeshBasicMaterial({ color: EMBER }));
const flameMaterial = markBloom(new THREE.MeshBasicMaterial({ color: '#ffb703', toneMapped: false }));

// ---------- rolling (grinder lid twist, the paper, pinches and the cone it becomes) ----------

/** How far through 'rolling' (0-1), and the two sub-beats within it: the grinder stops spinning by SPIN_UNTIL, the
 * paper is still flat (sliding over from the pouch) until FOLD_FROM, then thins and lengthens into the cone. */
const SPIN_UNTIL = 0.55;
const FOLD_FROM = 0.8;

/** The grinder's lid, twisting (with smokeGrind's rasp) for the first part of rolling one. */
function GrinderLid({ cx, cz, topY, active, progress }: { cx: number; cz: number; topY: number; active: boolean; progress: () => number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    m.rotation.y = active ? Math.min(1, progress() / SPIN_UNTIL) * Math.PI * 5 : 0;
  });
  return (
    <mesh ref={ref} position={[cx + 0.1, topY + 0.085, cz - 0.22]} material={toon(METAL)}>
      <cylinderGeometry args={[0.033, 0.033, 0.02, 12]} />
    </mesh>
  );
}

/** The rolling paper: slides over from the pouch, then (past FOLD_FROM) thins and grows into the cone it ends up as,
 * finishing exactly where the held joint takes over once rolling's done. */
const ROLLED_LEN = 0.09; // the full joint's starting length (HeldJoint's len at puffsLeft === PUFFS)

function RollingPaper({ cx, cz, topY, progress }: { cx: number; cz: number; topY: number; progress: () => number }) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const flat = useMemo(() => new THREE.BoxGeometry(0.1, 0.004, 0.06), []);
  const cone = useMemo(() => new THREE.CylinderGeometry(0.006, 0.006, ROLLED_LEN, 8).rotateX(Math.PI / 2), []);
  useEffect(() => () => [flat, cone].forEach((g) => g.dispose()), [flat, cone]);
  const from = { x: cx - 0.13, z: cz + 0.05 };
  const to = { x: cx - 0.02, z: cz };
  useFrame(() => {
    const g = group.current;
    const m = mesh.current;
    if (!g || !m) return;
    const t = Math.min(1, progress());
    const slide = Math.min(1, t / FOLD_FROM);
    g.position.set(from.x + (to.x - from.x) * slide, topY + 0.03, from.z + (to.z - from.z) * slide);
    const fold = Math.max(0, (t - FOLD_FROM) / (1 - FOLD_FROM));
    g.scale.setScalar(t < FOLD_FROM ? 1 : 0.2 + 0.8 * fold); // grows into the cone it ends up as
    g.rotation.y = fold * 0.6;
    m.geometry = t >= FOLD_FROM ? cone : flat; // pinched flat, then rolled into the cone it ends up as
  });
  return (
    <group ref={group}>
      <mesh ref={mesh} geometry={flat} material={toon(PAPER)} />
    </group>
  );
}

// ---------- the joint, lit and held (camera-attached, bottom-right of view, like a held mug or sausage) ----------

const VIEW = { x: 0.16, y: -0.13, z: -0.4, tilt: -0.35, turn: -0.55 };
const MOUTH = { x: 0.03, y: -0.05, z: -0.24, tilt: -0.1, turn: -0.15 };
const PUFF_POOL = 16;
const PUFF_LIFE_MS = 3000;

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface PuffSlot {
  until: number; // performance.now() ms the puff is done fading
  born: number;
  dx: number;
  dz: number;
}

/** The joint in your right hand, lower right of the view: the lit tip (ember, bloom, a thin wisp), the lighter and
 * its ~1 s flame while lighting, lifting toward you on a puff, and the 4-6 soft puffs you exhale after, drifting up
 * and fading over ~3 s from a fixed pool of sprites sharing one texture. */
function HeldJoint({ state, exhaleAt }: { state: SmokeState; exhaleAt: () => number }) {
  const root = useRef<THREE.Group>(null);
  const hand = useRef<THREE.Group>(null);
  const wisps = useRef<THREE.Group>(null);
  const flame = useRef<THREE.Mesh>(null);
  const sprites = useRef<(THREE.Sprite | null)[]>([]);
  const tex = useMemo(puffTexture, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const materials = useMemo(() => Array.from({ length: PUFF_POOL }, () => new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })), [tex]);
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  const pool = useMemo<PuffSlot[]>(() => Array.from({ length: PUFF_POOL }, () => ({ until: 0, born: 0, dx: 0, dz: 0 })), []);
  const nextSlot = useRef(0);
  const exhaled = useRef(0);

  const lit = state.stage === 'lit' || state.stage === 'puffing' || state.stage === 'out';
  const glowing = state.stage === 'lit' || state.stage === 'puffing';
  const lighting = state.stage === 'lighting';
  const len = 0.09 * (0.3 + 0.7 * (state.puffsLeft / PUFFS)); // shorter each puff
  const tipZ = -len; // the far end, away from you: where the lighter, ember and wisp go

  useFrame(({ camera }) => {
    const r = root.current;
    const h = hand.current;
    if (!r || !h) return;
    r.position.copy(camera.position);
    r.quaternion.copy(camera.quaternion);
    const now = performance.now();
    const puffT = state.stage === 'puffing' ? Math.min(1, (now - state.since) / PUFF_MS) : 0;
    const k = Math.sin(Math.PI * puffT); // lifts toward you mid-puff, settles back by the end
    h.position.set(VIEW.x + (MOUTH.x - VIEW.x) * k, VIEW.y + (MOUTH.y - VIEW.y) * k, VIEW.z + (MOUTH.z - VIEW.z) * k);
    h.rotation.set(VIEW.tilt + (MOUTH.tilt - VIEW.tilt) * k, VIEW.turn + (MOUTH.turn - VIEW.turn) * k, 0, 'YXZ');

    const w = wisps.current;
    if (w) {
      const t = now / 1000;
      for (let i = 0; i < w.children.length; i++) {
        const c = w.children[i] as THREE.Mesh;
        const kk = (t * (state.stage === 'puffing' ? 0.9 : 0.35) + i / 3) % 1;
        c.position.set(Math.sin(t * 1.4 + i * 2.3) * 0.01, kk * 0.18, 0);
        c.scale.setScalar(0.5 + kk * 1.4);
        (c.material as THREE.MeshBasicMaterial).opacity = (state.stage === 'puffing' ? 0.4 : 0.18) * (1 - kk);
      }
    }
    if (flame.current) {
      const f = lighting ? Math.min(1, (now - state.since) / 220) * (0.7 + 0.3 * Math.sin(now / 40)) : 0;
      flame.current.visible = lighting;
      flame.current.scale.setScalar(0.6 + 0.4 * f);
    }

    // a fresh exhale: 4-6 puffs, lightly staggered, once per finished puff (exhaleAt() bumps its timestamp)
    const want = exhaleAt();
    if (want !== exhaled.current) {
      exhaled.current = want;
      const n = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const slot = nextSlot.current;
        nextSlot.current = (nextSlot.current + 1) % PUFF_POOL;
        pool[slot] = { born: now + i * 90, until: now + i * 90 + PUFF_LIFE_MS, dx: (Math.random() - 0.5) * 0.05, dz: (Math.random() - 0.5) * 0.05 };
      }
    }
    for (let i = 0; i < PUFF_POOL; i++) {
      const s = sprites.current[i];
      const p = pool[i];
      if (!s) continue;
      if (now < p.born || now > p.until) {
        s.visible = false;
        continue;
      }
      const age = (now - p.born) / PUFF_LIFE_MS;
      s.visible = true;
      s.position.set(p.dx * age * 4, MOUTH.y + 0.05 + age * 0.35, MOUTH.z + p.dz * age * 4 + 0.05);
      s.scale.setScalar(0.04 + age * 0.1);
      materials[i].opacity = 0.5 * (1 - age);
    }
  });

  return (
    <group ref={root} userData={FIRST_PERSON}>
      <group ref={hand}>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, tipZ / 2]} material={toon(PAPER)}>
          <cylinderGeometry args={[0.006, 0.006, -tipZ, 8]} />
        </mesh>
        {lit && (
          <mesh position={[0, 0, tipZ]} material={glowing ? emberMaterial : toon(EMBER)}>
            <sphereGeometry args={[glowing ? 0.009 : 0.007, 8, 6]} />
          </mesh>
        )}
        {glowing && (
          <group ref={wisps} position={[0, 0, tipZ]}>
            {[0, 1, 2].map((i) => (
              <mesh key={i}>
                <sphereGeometry args={[0.014, 6, 5]} />
                <meshBasicMaterial color="#e9ecef" transparent opacity={0.2} depthWrite={false} />
              </mesh>
            ))}
          </group>
        )}
        <mesh ref={flame} visible={false} position={[0, 0.02, tipZ - 0.01]} material={flameMaterial}>
          <coneGeometry args={[0.012, 0.03, 8]} />
        </mesh>
      </group>
      {materials.map((m, i) => (
        <sprite key={i} ref={(s) => void (sprites.current[i] = s)} material={m} visible={false} />
      ))}
    </group>
  );
}

/** One nook: the office balconies' (west/east, drawn beside Outside.tsx's bench) or the roof's (with its own bench). */
export function SmokeNook({ id, bench = false }: { id: NookId; bench?: boolean }) {
  const n = useMemo(() => nook(id), [id]);
  const table = useMemo(() => propsGeometry((n.table.minX + n.table.maxX) / 2, (n.table.minZ + n.table.maxZ) / 2, n.table.h ?? 0.45), [n]);
  const benchGeo = useMemo(() => (bench ? benchGeometry(n.bench) : null), [bench, n]);
  useEffect(() => () => [...Object.values(table), benchGeo].forEach((g) => g?.dispose()), [table, benchGeo]);

  const [state, setState] = useState<SmokeState>(() => newSmoke(performance.now()));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [seat, setSeat] = useState<0 | 1 | null>(null);
  const seatRef = useRef(seat);
  seatRef.current = seat;
  const [butts, setButts] = useState(0);
  const buttsRef = useRef(butts);
  buttsRef.current = butts;
  const exhaleAtRef = useRef(0);

  const tableCentre = { x: (n.table.minX + n.table.maxX) / 2, y: n.table.h ?? 0.45, z: (n.table.minZ + n.table.maxZ) / 2 };
  const gapX = (n.gap.minX + n.gap.maxX) / 2;

  const press = () => {
    if (seatRef.current == null) return;
    const before = stateRef.current.stage;
    if (before === 'empty') smokeGrind(tableCentre);
    else if (before === 'ready' || before === 'out') smokeLight(tableCentre);
    else if (before === 'lit') smokeCrackle(tableCentre);
    setState((s) => pressE(s, performance.now()));
  };

  const sitDown = () => {
    if (seatRef.current != null) return;
    // the nearer seat to where you're standing isn't always free: an agent out on the smoke errand may hold it
    const d0 = Math.abs(playerAt.z - n.seats[0].z);
    const d1 = Math.abs(playerAt.z - n.seats[1].z);
    const i: 0 | 1 = d0 <= d1 ? 0 : 1;
    // a seat a visitor already holds (#59) can't be taken: a toast, not a sit (move closer to the other one instead)
    if (visitorsAtSeat(useStore.getState().floor, `${id}:${i}`).length) {
      useStore.getState().pushToast('info', "🚬 Someone's sitting there");
      return;
    }
    const seatXZ = n.seats[i];
    setPerch({
      id: `smoke:${id}:${i}`,
      x: seatXZ.x,
      y: 1.15,
      z: seatXZ.z,
      tilt: 0,
      look: 1,
      minPitch: -0.6,
      maxPitch: 0.6,
      exit: { x: gapX, z: seatXZ.z }, // up and off the bench, back into the gap
      yaw: n.yaw,
      pitch: -0.3,
      onLeave: () => {
        setSeat(null);
        if (standUpSmoke(stateRef.current).butt) setButts((b) => addButt(b));
        setState(newSmoke(performance.now()));
      },
    });
    setSeat(i);
  };

  useEffect(
    () =>
      registerNook(id, {
        focusAt: (x, z) => (seatRef.current != null || !inGap(n, x, z) ? null : { id: `smoke:${id}`, label: 'Sit down', op: `sit:${id}` }),
        sit: sitDown,
        press,
        label: () => smokeLabel(stateRef.current),
        stub: () => setButts((b) => addButt(b)),
        report: () => ({
          seats: [0, 1].map((i): SeatOwner => {
            if (seatRef.current === i) return 'you';
            const a = agentAtSeat(id, i as 0 | 1);
            return a ? `agent:${a}` : 'free';
          }) as [SeatOwner, SeatOwner],
          butts: buttsRef.current,
          stage: stateRef.current.stage,
          puffsLeft: stateRef.current.puffsLeft,
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  useEffect(() => () => void (seatRef.current != null && leavePerch()), [id]);

  useFrame(() => {
    if (seatRef.current == null) return;
    // Two people sat down on the same seat at once (#59): the lexically smaller visitor id keeps it, stood up here.
    const mySeat = seatRef.current;
    const others = visitorsAtSeat(useStore.getState().floor, `${id}:${mySeat}`);
    const myId = myVisitorId();
    if (others.length && others.some((o) => o < myId)) {
      leavePerch();
      useStore.getState().pushToast('info', "🚬 Someone's sitting there");
      return;
    }
    const now = performance.now();
    const r = tickSmoke(stateRef.current, now);
    if (r.state !== stateRef.current) setState(r.state);
    if (r.butt) setButts((b) => addButt(b));
    // puffing finished, back to 'lit': the exhale is the puffs you breathe out after the lift
    if (stateRef.current.stage === 'puffing' && r.state.stage === 'lit') exhaleAtRef.current = now;
  });

  const rolling = state.stage === 'rolling';
  const rollProgress = () => Math.min(1, (performance.now() - state.since) / ROLL_MS);

  return (
    <group>
      <mesh geometry={table.wood} material={toon(WOOD)} castShadow receiveShadow>
        <Outlines thickness={0.015} color={INK} />
      </mesh>
      <mesh geometry={table.metal} material={toon(METAL)} />
      <mesh geometry={table.pouch} material={toon(POUCH)} />
      <mesh geometry={table.bag} material={toon(BAG)} />
      <mesh geometry={table.ash} material={toon(ASH)} />
      {benchGeo && (
        <mesh geometry={benchGeo} material={toon(WOOD)} castShadow receiveShadow>
          <Outlines thickness={0.018} color={INK} />
        </mesh>
      )}
      <GrinderLid cx={tableCentre.x} cz={tableCentre.z} topY={tableCentre.y} active={rolling} progress={rollProgress} />
      {rolling && <RollingPaper cx={tableCentre.x} cz={tableCentre.z} topY={tableCentre.y} progress={rollProgress} />}
      {seat != null && !rolling && state.stage !== 'empty' && <HeldJoint state={state} exhaleAt={() => exhaleAtRef.current} />}
      {BUTT_SLOTS.slice(0, butts).map((i) => (
        <Butt key={i} i={i} x={tableCentre.x - 0.12} z={tableCentre.z - 0.1} y={tableCentre.y + 0.05} />
      ))}
    </group>
  );
}

/** Both office balcony nooks, at their fixed spot on every floor (world/layout.ts's balconyFurniture). */
export function SmokeBreak() {
  return (
    <group>
      <SmokeNook id="office-west" />
      <SmokeNook id="office-east" />
    </group>
  );
}
