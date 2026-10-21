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
import {
  MAX_BUTTS,
  addButt,
  inGap,
  newSmoke,
  nook,
  pressE,
  registerNook,
  smokeLabel,
  standUpSmoke,
  tickSmoke,
  type NookId,
  type SmokeState,
} from './smokeBreak';

// The smoke break's table, on every office balcony and the roof (layout.ts has the numbers; smokeBreak.ts the pure
// rules). This draws the table, its six things and the roof's bench, sits you down between bench and table on E, and
// drives the roll → light → puff stage machine while you're there. Only the nook you're sitting at animates.

const INK = '#1f1d2b';
const WOOD = '#c9905a';
const METAL = '#6c757d';
const PAPER = '#f1e8d8';
const POUCH = '#8a6240';
const BAG = '#7cb342';
const ASH = '#495057';
const EMBER = '#ff7b3d';

/** The table's top, legs and its six things, all one merged mesh per colour so a table costs a few draw calls. */
function propsGeometry(cx: number, cz: number, topY: number) {
  const wood: THREE.BufferGeometry[] = [new THREE.BoxGeometry(0.4, 0.05, 0.8).translate(cx, topY, cz)];
  for (const [dx, dz] of [[-0.15, -0.3], [0.15, -0.3], [-0.15, 0.3], [0.15, 0.3]]) wood.push(new THREE.BoxGeometry(0.04, topY - 0.025, 0.04).translate(cx + dx, (topY - 0.025) / 2, cz + dz));
  const metal: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.035, 0.035, 0.05, 12).translate(cx + 0.1, topY + 0.05, cz - 0.22), // grinder base
    new THREE.CylinderGeometry(0.033, 0.033, 0.02, 12).translate(cx + 0.1, topY + 0.085, cz - 0.22), // grinder lid
    new THREE.BoxGeometry(0.03, 0.06, 0.015).translate(cx + 0.14, topY + 0.055, cz + 0.05), // lighter
  ];
  const paper = [new THREE.BoxGeometry(0.1, 0.004, 0.06).translate(cx - 0.05, topY + 0.027, cz + 0.22)];
  const pouch = [new THREE.BoxGeometry(0.1, 0.03, 0.08).translate(cx - 0.13, topY + 0.04, cz + 0.05)];
  const bag = [new THREE.SphereGeometry(0.035, 10, 8).scale(1, 0.6, 1).translate(cx - 0.02, topY + 0.045, cz - 0.02)];
  const ash: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.045, 0.04, 0.025, 12).translate(cx - 0.12, topY + 0.0375, cz - 0.1),
    new THREE.CylinderGeometry(0.038, 0.038, 0.012, 12).translate(cx - 0.12, topY + 0.044, cz - 0.1),
  ];
  return { wood: merged(wood), metal: merged(metal), paper: merged(paper), pouch: merged(pouch), bag: merged(bag), ash: merged(ash) };
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

/** The joint, once rolled: shorter each puff, glowing at the tip while lit, with a thin wisp of smoke. */
function Joint({ state, x, y, z }: { state: SmokeState; x: number; y: number; z: number }) {
  const lit = state.stage === 'lit' || state.stage === 'puffing' || state.stage === 'out';
  const glowing = state.stage === 'lit' || state.stage === 'puffing';
  const len = 0.09 * (0.3 + 0.7 * (state.puffsLeft / 8));
  const lift = state.stage === 'puffing' ? 0.03 : 0;
  const wisps = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = wisps.current;
    if (!g) return;
    const t = performance.now() / 1000;
    for (let i = 0; i < g.children.length; i++) {
      const c = g.children[i] as THREE.Mesh;
      const k = (t * (state.stage === 'puffing' ? 0.9 : 0.35) + i / 3) % 1;
      c.position.set(Math.sin(t * 1.4 + i * 2.3) * 0.01, k * 0.22, 0);
      c.scale.setScalar(0.5 + k * 1.4);
      (c.material as THREE.MeshBasicMaterial).opacity = (state.stage === 'puffing' ? 0.4 : 0.18) * (1 - k);
    }
  });
  return (
    <group position={[x, y + lift, z]}>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={toon(PAPER)}>
        <cylinderGeometry args={[0.006, 0.006, len, 8]} />
      </mesh>
      {lit && (
        <mesh position={[0, len / 2, 0]} material={glowing ? emberMaterial : toon(EMBER)}>
          <sphereGeometry args={[glowing ? 0.009 : 0.007, 8, 6]} />
        </mesh>
      )}
      {glowing && (
        <group ref={wisps} position={[0, len / 2, 0]}>
          {[0, 1, 2].map((i) => (
            <mesh key={i}>
              <sphereGeometry args={[0.014, 6, 5]} />
              <meshBasicMaterial color="#e9ecef" transparent opacity={0.2} depthWrite={false} />
            </mesh>
          ))}
        </group>
      )}
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

  const tableCentre = { x: (n.table.minX + n.table.maxX) / 2, y: n.table.h ?? 0.45, z: (n.table.minZ + n.table.maxZ) / 2 };

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
    const i = 0;
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
      exit: { x: seatXZ.x, z: seatXZ.z },
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
        report: () => ({ seats: [seatRef.current === 0 ? 'you' : 'free', seatRef.current === 1 ? 'you' : 'free'], butts: buttsRef.current, stage: stateRef.current.stage, puffsLeft: stateRef.current.puffsLeft }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  useEffect(() => () => void (seatRef.current != null && leavePerch()), [id]);

  useFrame(() => {
    if (seatRef.current == null) return;
    const now = performance.now();
    const r = tickSmoke(stateRef.current, now);
    if (r.state !== stateRef.current) setState(r.state);
    if (r.butt) setButts((b) => addButt(b));
  });

  const rolled = state.stage !== 'empty' && state.stage !== 'rolling';

  return (
    <group>
      <mesh geometry={table.wood} material={toon(WOOD)} castShadow receiveShadow>
        <Outlines thickness={0.015} color={INK} />
      </mesh>
      <mesh geometry={table.metal} material={toon(METAL)} />
      <mesh geometry={table.paper} material={toon(PAPER)} />
      <mesh geometry={table.pouch} material={toon(POUCH)} />
      <mesh geometry={table.bag} material={toon(BAG)} />
      <mesh geometry={table.ash} material={toon(ASH)} />
      {benchGeo && (
        <mesh geometry={benchGeo} material={toon(WOOD)} castShadow receiveShadow>
          <Outlines thickness={0.018} color={INK} />
        </mesh>
      )}
      {rolled && <Joint state={state} x={tableCentre.x} y={tableCentre.y + 0.06} z={tableCentre.z - 0.1} />}
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
