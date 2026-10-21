// The lobby's grounds (#41): everywhere you can walk once you're out of the building, through the west revolving
// door. Pure, numbers only (no three.js), derived from the city's own streets (cityLayout.ts) so they never drift
// apart: our block's plaza, the street paved over in front of the door, and the park next door. Outside.tsx and
// City.tsx draw it; Game.tsx adds groundsColliders() to the lobby's colliders; grounds.test.ts checks the numbers.

import { CITY, CORRIDOR_HALF } from './cityLayout';

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Our block's plaza, from the centre to its pavement, both sides. */
export const PLAZA = { minX: -CITY.homeHalfX, maxX: CITY.homeHalfX, minZ: -CITY.homeHalfZ, maxZ: CITY.homeHalfZ };
/** The west street, paved over between the plaza and the park: no road, kerb or paint. */
export const PAVED_STREET = { minX: -(CITY.homeHalfX + 2 * CORRIDOR_HALF), maxX: -CITY.homeHalfX, minZ: PLAZA.minZ, maxZ: PLAZA.maxZ };
/** Our neighbour's park, the block beyond the paved street. */
export const HOME_PARK = { minX: -(CITY.homeHalfX + CITY.pitch), maxX: PAVED_STREET.minX, minZ: PLAZA.minZ, maxZ: PLAZA.maxZ };

/** Everywhere outside the building you can walk: the plaza, the paved stretch of street, and the park. */
export const GROUNDS: Rect = { minX: HOME_PARK.minX, maxX: PLAZA.maxX, minZ: PLAZA.minZ, maxZ: PLAZA.maxZ };

/** Whether (x, z) is somewhere on the grounds (the building's own walls still stop you; that's layout.ts's job). */
export const isWalkable = (x: number, z: number) => x >= GROUNDS.minX && x <= GROUNDS.maxX && z >= GROUNDS.minZ && z <= GROUNDS.maxZ;

/** How thick the invisible edge colliders are. */
const EDGE = 0.4;

/**
 * Invisible colliders along all four of the grounds' edges, so you never stray onto a real street: the east one
 * backs up the existing east patio's rail, which only covers |z| <= 11.2 and leaves the rest of that edge open.
 */
export function groundsColliders(): Rect[] {
  const { minX, maxX, minZ, maxZ } = GROUNDS;
  return [
    { minX, maxX, minZ: minZ - EDGE, maxZ: minZ }, // north
    { minX, maxX, minZ: maxZ, maxZ: maxZ + EDGE }, // south
    { minX: minX - EDGE, maxX: minX, minZ, maxZ }, // west
    { minX: maxX, maxX: maxX + EDGE, minZ, maxZ }, // east
  ];
}

export interface FenceLine {
  axis: 'x' | 'z';
  /** The line's own coordinate (x for a 'z'-axis run, z for an 'x'-axis run). */
  at: number;
  from: number;
  to: number;
}

/** The park's fence: north, west and south edges only, never the east one that opens onto the paved street. */
export function parkFenceLines(): FenceLine[] {
  const { minX, maxX, minZ, maxZ } = HOME_PARK;
  return [
    { axis: 'x', at: minZ, from: minX, to: maxX }, // north
    { axis: 'x', at: maxZ, from: minX, to: maxX }, // south
    { axis: 'z', at: minX, from: minZ, to: maxZ }, // west
  ];
}

/** Short bollards across each end of the paved stretch, where the road resumes unpaved. */
export function bollardXs(): number[] {
  const { minX, maxX } = PAVED_STREET;
  const n = 5;
  return Array.from({ length: n }, (_, i) => minX + ((maxX - minX) * (i + 0.5)) / n);
}
export const bollardZs = (): number[] => [PAVED_STREET.minZ, PAVED_STREET.maxZ];
