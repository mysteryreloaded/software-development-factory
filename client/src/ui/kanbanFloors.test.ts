import { describe, expect, it } from 'vitest';
import { floorStep } from './kanbanFloors';

describe('floorStep', () => {
  const repos = [
    { id: 'b', floor: 2 },
    { id: 'a', floor: 1 },
    { id: 'c', floor: 3 },
  ];

  it('steps to the next and previous floor from the middle', () => {
    expect(floorStep(repos, 'b', 1)).toBe('c');
    expect(floorStep(repos, 'b', -1)).toBe('a');
  });

  it('wraps from the top floor to floor 1 and back', () => {
    expect(floorStep(repos, 'c', 1)).toBe('a');
    expect(floorStep(repos, 'a', -1)).toBe('c');
  });

  it('with 2 floors, both directions give the other floor', () => {
    const two = [
      { id: 'x', floor: 1 },
      { id: 'y', floor: 2 },
    ];
    expect(floorStep(two, 'x', 1)).toBe('y');
    expect(floorStep(two, 'x', -1)).toBe('y');
    expect(floorStep(two, 'y', 1)).toBe('x');
    expect(floorStep(two, 'y', -1)).toBe('x');
  });

  it('returns null with fewer than 2 floors', () => {
    expect(floorStep([{ id: 'a', floor: 1 }], 'a', 1)).toBeNull();
    expect(floorStep([], 'a', 1)).toBeNull();
  });

  it('returns null for an unknown repo id', () => {
    expect(floorStep(repos, 'z', 1)).toBeNull();
  });
});
