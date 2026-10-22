import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Outlines } from './Outlines';
import * as THREE from 'three';
import { doorSlide } from '../ui/sfx';
import { playerAt } from './camera/rig';
import { doorOpen, resetDoors, tickDoors } from './doors';
import { drawFacade } from './draw';
import { BALCONY, BALCONY_LIGHTS, BALCONY_OUT, BENCH, FLOOR_HEIGHT, HALF_D, HALF_W, PLANTER, SIDE_DOOR, SIDE_OPENINGS, SIDES, WALL_H, WALL_T, WINDOW, balconyFurniture, floorElevation, sideSign, type Side } from './layout';
import { toon, toonMap } from './materials';
import { OutsideSounds } from './OutsideSounds';
import { doorWalkers } from './hiringState';
import { bodyState } from './people';
import { walk } from './toys/hands';
import { boxesGeometry, merged, type BoxSpec } from './shapes';
import { paneMaterial } from './Shell';
import { LampHalos, balconyBulb } from './sky/lamps';
import { SmokeBreak } from './SmokeBreak';
import { DRUM_RADIUS, tickLiveDoor, wingAngle, WINGS } from './revolvingDoor';

// Outside the side walls: the sliding glass doors, the balconies (the lobby's is a patio on the ground), and the rest
// of the building round you: its walls above and below your floor and every floor's balcony (the city, outside/City.tsx,
// is the ground). Everything static is merged into a few meshes, so all of it costs a handful of draw calls.

type FloorKind = 'office' | 'lobby';
const INK = '#1f1d2b';
const wallX = (side: Side) => sideSign(side) * (HALF_W + WALL_T / 2);

// ---------- side doors ----------

const LEAF_W = SIDE_DOOR.half + 0.04; // each of a door's two leaves, a little wider than half, so they meet
const LEAF_H = SIDE_DOOR.h - 0.02;
const SLIDE = SIDE_DOOR.half + 0.02; // how far each leaf slides into the wall
const LEAVES = [0, 1, 2, 3]; // west north, west south, east north, east south

/** A leaf's frame (lying along z, centred on z = 0), with its pull handle by the edge where the leaves meet (+z or -z). */
function leafFrame(meet: number) {
  const t = 0.06;
  return boxesGeometry([
    { size: [t, LEAF_H, 0.07], at: [0, LEAF_H / 2, -LEAF_W / 2 + 0.035] },
    { size: [t, LEAF_H, 0.07], at: [0, LEAF_H / 2, LEAF_W / 2 - 0.035] },
    { size: [t, 0.09, LEAF_W], at: [0, LEAF_H - 0.045, 0] },
    { size: [t, 0.14, LEAF_W], at: [0, 0.07, 0] },
    { size: [0.12, 0.6, 0.035], at: [0, 1.05, meet * (LEAF_W / 2 - 0.14)] },
  ]);
}

/** The glass doors: two leaves each that slide apart into the wall while you're near and shut behind you, with a whoosh.
 * The lobby's west side has a revolving door instead (#41, below), so it draws no leaves there and never slides. */
function SideDoors({ kind, floor }: { kind: FloorKind; floor: number }) {
  const slides = kind === 'lobby' ? (['east'] as const) : SIDES;
  const geo = useMemo(
    () => ({
      glass: new THREE.PlaneGeometry(LEAF_W - 0.1, LEAF_H - 0.2).rotateY(Math.PI / 2).translate(0, 0.14 + (LEAF_H - 0.2) / 2, 0),
      frames: [leafFrame(1), leafFrame(-1)],
    }),
    [],
  );
  useEffect(() => () => [geo.glass, ...geo.frames].forEach((g) => g.dispose()), [geo]);
  useEffect(() => {
    resetDoors(kind, floor);
    return () => resetDoors(kind, floor, false);
  }, [kind, floor]);

  const leaves = useRef<(THREE.Group | null)[]>([]);
  const moved = useCallback((side: Side, opening: boolean) => doorSlide({ x: wallX(side), y: 1.2, z: SIDE_OPENINGS[kind][side].door }, opening), [kind]);
  const walkers = useMemo(() => [] as { x: number; z: number }[], []);
  useFrame((_, dt) => {
    // a declined candidate on their way out of the lobby opens the door too
    walkers.length = 0;
    for (const id of doorWalkers) {
      const b = bodyState(id);
      if (b) walkers.push(b);
    }
    tickDoors(playerAt.x, playerAt.z, Math.min(dt, 0.05), moved, walkers);
    for (const i of LEAVES) {
      const g = leaves.current[i];
      if (!g) continue;
      const side = SIDES[i >> 1];
      if (!slides.includes(side)) continue;
      const dir = i & 1 ? 1 : -1;
      const z = SIDE_OPENINGS[kind][side].door + dir * (LEAF_W / 2 - 0.02 + doorOpen(side) * SLIDE);
      if (g.position.z !== z) g.position.z = z;
    }
  });

  return (
    <group>
      {LEAVES.map((i) => {
        const side = SIDES[i >> 1];
        if (!slides.includes(side)) return null;
        const dir = i & 1 ? 1 : -1;
        return (
          <group key={i} ref={(g) => void (leaves.current[i] = g)} position={[wallX(side), 0, SIDE_OPENINGS[kind][side].door + dir * (LEAF_W / 2 - 0.02)]}>
            <mesh geometry={geo.glass} material={paneMaterial()} renderOrder={1} />
            <mesh geometry={geo.frames[i & 1]} material={toon('#e9ecef')} />
          </group>
        );
      })}
    </group>
  );
}

// ---------- the lobby's revolving door (#41) ----------

const WING_H = SIDE_DOOR.h - 0.1;
// A wing spans the drum's full diameter through the post, so it's really two opposite wings at once: WINGS of
// them 90° apart need only WINGS / 2 meshes, each doubling as the blade on its far side too.
const DRAWN_WINGS = WINGS / 2;
const QUARTER = Math.PI / 2;
// The two curved sides are quarter-circles centred on north and south, leaving the east (into the building) and
// west (out to the grounds) quarters open to walk through (drumColliders() bounds the same two arcs).
const ARC_SEGMENTS = 16;

/** The drum: a post with WINGS glass wings turning inside two curved glass side walls, centred on the post (not
 * offset into the wall). It never blocks: only the sides are solid for the player (drumColliders(), which
 * Player.tsx's collide() also uses), and nothing here is solid for them at all. The wings are phased to your
 * progress across the drum and coast to the next quarter turn once you've left (revolvingDoor.ts). */
function RevolvingDoor() {
  const z = SIDE_OPENINGS.lobby.west.door;
  const x = wallX('west');
  const geo = useMemo(() => {
    const wing = new THREE.PlaneGeometry(DRUM_RADIUS * 2 - 0.08, WING_H).rotateX(-Math.PI / 2).rotateZ(Math.PI / 2).translate(0, WING_H / 2 + 0.05, 0);
    const post = new THREE.CylinderGeometry(0.06, 0.06, WING_H, 10).translate(0, WING_H / 2 + 0.05, 0);
    const arc = (thetaStart: number) => new THREE.CylinderGeometry(DRUM_RADIUS, DRUM_RADIUS, WING_H, ARC_SEGMENTS, 1, true, thetaStart, QUARTER).translate(0, WING_H / 2 + 0.05, 0);
    const north = arc(Math.PI - QUARTER / 2);
    const south = arc(-QUARTER / 2);
    return { wing, post, north, south };
  }, []);
  useEffect(() => () => [geo.wing, geo.post, geo.north, geo.south].forEach((g) => g.dispose()), [geo]);
  const wings = useRef<(THREE.Mesh | null)[]>([]);
  useFrame((_, dt) => {
    // Player.tsx's own walk.x (its velocity after collision) is what actually moves you through the wall, so the
    // wings read that directly rather than re-deriving speed from position deltas (which chase floating jitter).
    const dx = playerAt.x - x;
    const dz = playerAt.z - z;
    const inside = dx * dx + dz * dz <= DRUM_RADIUS * DRUM_RADIUS;
    const state = tickLiveDoor(inside ? Math.abs(walk.x) : 0, inside, Math.min(dt, 0.05));
    for (let i = 0; i < DRAWN_WINGS; i++) {
      const w = wings.current[i];
      if (w) w.rotation.y = wingAngle(state, i);
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={geo.north} material={paneMaterial()} renderOrder={1} />
      <mesh geometry={geo.south} material={paneMaterial()} renderOrder={1} />
      <mesh geometry={geo.post} material={toon('#8d8f96')} />
      {Array.from({ length: DRAWN_WINGS }, (_, i) => (
        <mesh key={i} ref={(m) => void (wings.current[i] = m)} geometry={geo.wing} material={paneMaterial()} renderOrder={1} />
      ))}
    </group>
  );
}

// ---------- balconies ----------

const DEEP = BALCONY_OUT - HALF_W; // a slab, from under the doorway to the railing's outside
const LEN = BALCONY.maxZ - BALCONY.minZ;
const MID_Z = (BALCONY.minZ + BALCONY.maxZ) / 2;
const IN = HALF_W + WALL_T;

/** Every floor's balconies, the ground's patio and the roof's canopy over the top floor's: slabs, glass and rails.
 * The ground floor is always the lobby, and its west side is the revolving door's grounds now (#41), not a patio:
 * dropped here so every view of it (the lobby's own and looking down from above) agrees. */
function balconyGeometry(floor: number, top: number) {
  const { rail, railT, slab, minZ, maxZ, depth } = BALCONY;
  const slabs: BoxSpec[] = [];
  const patio: BoxSpec[] = [];
  const glass: BoxSpec[] = [];
  const rails: BoxSpec[] = [];
  for (let f = 0; f <= top + 1; f++) {
    const y = (f - floor) * FLOOR_HEIGHT;
    for (const side of SIDES) {
      if (f === 0 && side === 'west') continue;
      const s = sideSign(side);
      (f === 0 ? patio : slabs).push({ size: [DEEP, slab, LEN], at: [s * (HALF_W + DEEP / 2), y - slab / 2, MID_Z] });
      if (f > top) continue;
      const out = s * (BALCONY_OUT - railT / 2);
      const across = s * (IN + (depth - railT) / 2);
      const paneH = rail - 0.14;
      glass.push({ size: [0.03, paneH, LEN - railT * 2], at: [out, y + 0.06 + paneH / 2, MID_Z] });
      rails.push({ size: [railT + 0.03, 0.07, LEN], at: [out, y + rail - 0.035, MID_Z] });
      for (const z of [minZ + railT / 2, maxZ - railT / 2]) {
        glass.push({ size: [depth - railT, paneH, 0.03], at: [across, y + 0.06 + paneH / 2, z] });
        rails.push({ size: [depth, 0.07, railT + 0.03], at: [s * (IN + depth / 2), y + rail - 0.035, z] });
        for (const x of [IN + 0.05, IN + depth / 2]) rails.push({ size: [0.07, rail, 0.07], at: [s * x, y + rail / 2, z] });
      }
      for (let k = 0; k <= 10; k++) rails.push({ size: [0.07, rail, 0.07], at: [out, y + rail / 2, minZ + railT / 2 + (k * (LEN - railT)) / 10] });
    }
  }
  return { slabs: boxesGeometry(slabs), patio: boxesGeometry(patio), glass: boxesGeometry(glass), rails: boxesGeometry(rails) };
}

/** On your floor's balconies: planters with shrubs and flowers, a bench, and the lamps under the balcony above.
 * The lobby's west side has no balcony any more (its patio is gone, #41), so it gets no furniture or lamps there;
 * offices keep theirs on both sides. */
function furnitureGeometry(kind: FloorKind) {
  const sides = kind === 'lobby' ? (['east'] as const satisfies readonly Side[]) : SIDES;
  const planters: BoxSpec[] = [];
  const bench: BoxSpec[] = [];
  const legs: BoxSpec[] = [];
  const shrubs: THREE.BufferGeometry[] = [];
  const flowers: THREE.BufferGeometry[] = [];
  for (const side of sides) {
    const s = sideSign(side);
    const f = balconyFurniture(kind, side);
    for (const p of f.planters) {
      const x = (p.minX + p.maxX) / 2;
      const z = (p.minZ + p.maxZ) / 2;
      planters.push({ size: [PLANTER.w, PLANTER.h - 0.06, PLANTER.l], at: [x, (PLANTER.h - 0.06) / 2, z] });
      planters.push({ size: [PLANTER.w + 0.06, 0.06, PLANTER.l + 0.06], at: [x, PLANTER.h - 0.03, z] });
      for (const [dz, r] of [[-0.55, 0.3], [0, 0.36], [0.55, 0.28]]) shrubs.push(new THREE.SphereGeometry(r, 14, 10).translate(x, PLANTER.h + r * 0.55, z + dz));
      for (const [dx, dz] of [[-0.1, -0.35], [0.12, 0.2], [-0.05, 0.75], [0.08, -0.8]]) flowers.push(new THREE.SphereGeometry(0.07, 8, 6).translate(x + dx, PLANTER.h + 0.5, z + dz));
    }
    const b = f.bench;
    const bz = (b.minZ + b.maxZ) / 2;
    const seatX = s * (IN + BENCH.w / 2 + 0.04);
    bench.push({ size: [BENCH.w - 0.08, 0.08, BENCH.l], at: [seatX, 0.46, bz] });
    bench.push({ size: [0.08, 0.36, BENCH.l], at: [s * (IN + 0.08), 0.68, bz] });
    for (const dz of [-BENCH.l / 2 + 0.15, BENCH.l / 2 - 0.15]) {
      legs.push({ size: [BENCH.w - 0.12, 0.06, 0.06], at: [seatX, 0.39, bz + dz] });
      for (const dx of [-0.2, 0.2]) legs.push({ size: [0.06, 0.42, 0.06], at: [seatX + dx, 0.21, bz + dz] });
    }
  }
  const lights = BALCONY_LIGHTS.filter((l) => sides.includes(l.side));
  const lamps = boxesGeometry(lights.map((l) => ({ size: [0.5, 0.06, 0.5] as BoxSpec['size'], at: [l.x, l.y + 0.05, l.z] as BoxSpec['at'] })));
  const bulbs = merged(lights.map((l) => new THREE.PlaneGeometry(0.4, 0.4).rotateX(Math.PI / 2).translate(l.x, l.y + 0.015, l.z)));
  const halos = lights.map((l): [number, number, number] => [l.x, l.y + 0.055, l.z]);
  return { planters: boxesGeometry(planters), bench: boxesGeometry(bench), legs: boxesGeometry(legs), shrubs: merged(shrubs), flowers: merged(flowers), lamps, bulbs, halos };
}

function Balconies({ kind, floor, top }: { kind: FloorKind; floor: number; top: number }) {
  const shell = useMemo(() => balconyGeometry(floor, top), [floor, top]);
  const stuff = useMemo(() => furnitureGeometry(kind), [kind]);
  useEffect(() => () => [...Object.values(shell), stuff.planters, stuff.bench, stuff.legs, stuff.shrubs, stuff.flowers, stuff.lamps, stuff.bulbs].forEach((g) => g.dispose()), [shell, stuff]);
  return (
    <group>
      <mesh geometry={shell.slabs} material={toon('#d6d0c4')} />
      <mesh geometry={shell.patio} material={toon('#e3b98f')} />
      <mesh geometry={shell.rails} material={toon('#5c677d')} />
      <mesh geometry={shell.glass} material={paneMaterial()} renderOrder={1} />
      <mesh geometry={stuff.planters} material={toon('#e07a5f')}>
        <Outlines thickness={0.018} color={INK} />
      </mesh>
      <mesh geometry={stuff.shrubs} material={toon('#52b788')} />
      <mesh geometry={stuff.flowers} material={toon('#ff8fab')} />
      <mesh geometry={stuff.bench} material={toon('#c9905a')}>
        <Outlines thickness={0.018} color={INK} />
      </mesh>
      <mesh geometry={stuff.legs} material={toon('#495057')} />
      <mesh geometry={stuff.lamps} material={toon('#e9ecef')} />
      <mesh geometry={stuff.bulbs} material={balconyBulb} />
      <LampHalos positions={stuff.halos} size="bulb" />
    </group>
  );
}

// ---------- the rest of the building ----------

const BAY = 5; // the facade's window repeat along the walls, metres

let facadeTex: THREE.CanvasTexture | null = null;
function facadeTexture() {
  if (facadeTex) return facadeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const { y, h } = WINDOW;
  drawFacade(c.getContext('2d')!, 256, 256, WALL_H / FLOOR_HEIGHT, { x0: 0.12, x1: 0.88, y0: (y - h / 2) / FLOOR_HEIGHT, y1: (y + h / 2) / FLOOR_HEIGHT });
  facadeTex = new THREE.CanvasTexture(c);
  facadeTex.colorSpace = THREE.SRGBColorSpace;
  facadeTex.wrapS = facadeTex.wrapT = THREE.RepeatWrapping;
  facadeTex.anisotropy = 8;
  return facadeTex;
}

/** The building's outer walls below your floor (down to the ground) and above it (up to the roof), as one textured ring. */
function facadeGeometry(floor: number, top: number) {
  const elev = floorElevation(floor);
  const roof = (top + 1) * FLOOR_HEIGHT - elev;
  const bands: [number, number][] = [];
  if (elev > 0) bands.push([-elev, 0]);
  if (roof > WALL_H) bands.push([WALL_H, roof]);
  const X = HALF_W + WALL_T;
  const Z = HALF_D + WALL_T;
  const faces = [
    { len: 2 * X, rot: 0, x: 0, z: Z },
    { len: 2 * X, rot: Math.PI, x: 0, z: -Z },
    { len: 2 * Z, rot: Math.PI / 2, x: X, z: 0 },
    { len: 2 * Z, rot: -Math.PI / 2, x: -X, z: 0 },
  ];
  return merged(
    bands.flatMap(([y0, y1]) =>
      faces.map((f) => {
        const g = new THREE.PlaneGeometry(f.len, y1 - y0);
        const uv = g.attributes.uv;
        // in metres, so the windows line up with the storeys whatever the band
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * f.len) / BAY, (y0 + elev + uv.getY(i) * (y1 - y0)) / FLOOR_HEIGHT);
        return g.rotateY(f.rot).translate(f.x, (y0 + y1) / 2, f.z);
      }),
    ),
  );
}

function Facade({ floor, top }: { floor: number; top: number }) {
  const geo = useMemo(() => facadeGeometry(floor, top), [floor, top]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={toonMap('facade', facadeTexture())} />;
}

/** The building under the roof (roof/Roof.tsx): every floor's balconies and the outer walls, down to the ground. */
export function BuildingBelow({ top }: { top: number }) {
  const floor = top + 1; // the roof, as the storey above the top floor
  const shell = useMemo(() => balconyGeometry(floor, top), [floor, top]);
  useEffect(() => () => Object.values(shell).forEach((g) => g.dispose()), [shell]);
  return (
    <group>
      <mesh geometry={shell.slabs} material={toon('#d6d0c4')} />
      <mesh geometry={shell.patio} material={toon('#e3b98f')} />
      <mesh geometry={shell.rails} material={toon('#5c677d')} />
      <mesh geometry={shell.glass} material={paneMaterial()} renderOrder={1} />
      <Facade floor={floor} top={top} />
    </group>
  );
}

/** Everything outside the side walls, for floor `floor` of a building whose top floor is `top`. */
export function Outside({ kind, floor, top }: { kind: FloorKind; floor: number; top: number }) {
  return (
    <group>
      <SideDoors kind={kind} floor={floor} />
      {kind === 'lobby' && <RevolvingDoor />}
      <OutsideSounds kind={kind} />
      <Balconies kind={kind} floor={floor} top={Math.max(top, floor)} />
      <Facade floor={floor} top={Math.max(top, floor)} />
      {kind === 'office' && <SmokeBreak />}
    </group>
  );
}
