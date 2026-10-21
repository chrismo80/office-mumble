import { describe, expect, it } from 'vitest';

import floorPlan from '../../fixtures/floor-t1.json';
import sharedCases from '../../fixtures/hearing-cases.json';
import { audible, audibleArea, CLEAR_M, EARSHOT_M, levelAt, within } from './hearing';

const CELL = 0.5;

/** Two rooms of two cells with a wall between them — once with a wall, once with a door open, once shut. */
const WALL = [
  ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
  ['wall', 'floor', 'floor', 'wall', 'floor', 'floor', 'wall'],
  ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
];
const OPEN = [
  ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
  ['wall', 'floor', 'floor', 'doorOpen', 'floor', 'floor', 'wall'],
  ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
];
const SHUT = [
  ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
  ['wall', 'floor', 'floor', 'doorShut', 'floor', 'floor', 'wall'],
  ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
];

/** A single straight piece of floor `len` cells long — the corridor the walking-away cases use. */
const corridor = (len: number): string[][] => [Array<string>(len).fill('floor')];

/** The centre of a cell: cell (col, row) sits at ((col + 0.5) · cellM, (row + 0.5) · cellM). */
const at = (col: number, row: number) => ({ x: (col + 0.5) * CELL, y: (row + 0.5) * CELL });

const here = { id: 1, ...at(1, 1) };
const there = { id: 2, ...at(4, 1) };
const further = { id: 3, ...at(5, 1) };

describe('how loud somebody is at a distance', () => {
  it('is full volume within reach of a word, and nothing at the maximum', () => {
    expect(levelAt(0)).toBe(1);
    expect(levelAt(CLEAR_M)).toBe(1);
    expect(levelAt(EARSHOT_M)).toBe(0);
    expect(levelAt(EARSHOT_M + 5)).toBe(0);
  });

  it('falls off as the distance grows, without a step at either end', () => {
    const half = levelAt((CLEAR_M + EARSHOT_M) / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(levelAt(4)).toBeGreaterThan(levelAt(6));
  });
});

describe('who I can hear', () => {
  it('hears nobody through a wall, however close they are', () => {
    expect(audible(WALL, CELL, here, [here, there])).toEqual([]);
  });

  it('hears somebody through an open door', () => {
    expect(audible(OPEN, CELL, here, [here, there])).toMatchObject([{ id: 2, level: 1 }]);
  });

  it('hears nobody through a shut door, and the room it shut still hears itself', () => {
    expect(audible(SHUT, CELL, here, [here, there])).toEqual([]);
    expect(audible(SHUT, CELL, there, [here, there, further])).toMatchObject([{ id: 3, level: 1 }]);
  });

  it('never hears itself', () => {
    expect(audible(OPEN, CELL, here, [here])).toEqual([]);
  });

  it('answers the same question the same way from either side', () => {
    expect(audible(OPEN, CELL, here, [here, there])).toMatchObject([{ id: 2, level: 1 }]);
    expect(audible(OPEN, CELL, there, [here, there])).toMatchObject([{ id: 1, level: 1 }]);
  });

  it('puts the loudest first', () => {
    const heard = audible(corridor(60), CELL, { id: 1, x: 0.25, y: 0.25 }, [
      { id: 1, x: 0.25, y: 0.25 },
      { id: 2, x: 5.25, y: 0.25 },
      { id: 3, x: 2.25, y: 0.25 },
    ]);
    expect(heard.map(entry => entry.id)).toEqual([3, 2]);
  });

  it('drops somebody out of earshot as they walk away, and back in as they return', () => {
    const track = corridor(80);
    const me = { id: 1, x: 0.25, y: 0.25 };
    const standing = (distanceM: number) => [me, { id: 2, x: 0.25 + distanceM, y: 0.25 }];

    expect(audible(track, CELL, me, standing(CLEAR_M + 1))).toHaveLength(1);
    expect(audible(track, CELL, me, standing(EARSHOT_M - 0.5))).toHaveLength(1);
    expect(audible(track, CELL, me, standing(EARSHOT_M + 0.5))).toEqual([]);
    expect(audible(track, CELL, me, standing(CLEAR_M + 1))).toHaveLength(1);
  });

  it('tells walking away apart from a door being shut', () => {
    const track = corridor(80);
    const me = { id: 1, x: 0.25, y: 0.25 };
    const far = { id: 2, x: 0.25 + EARSHOT_M + 1, y: 0.25 };

    // Out of earshot down an open corridor: still in my area, so the rule reports them at level zero.
    expect(within(track, CELL, me, [me, far])).toMatchObject([{ id: 2, level: 0 }]);
    expect(audible(track, CELL, me, [me, far])).toEqual([]);

    // Behind a shut door: not in my area at all, and the rule says nothing about them.
    expect(within(SHUT, CELL, here, [here, there])).toEqual([]);
  });

  it('lets a wall beat a short distance, and distance beat nothing', () => {
    const track = corridor(60);
    const me = { id: 1, x: 0.25, y: 0.25 };
    const downTheCorridor = { id: 3, x: 0.25 + CLEAR_M * 3, y: 0.25 };

    // 1.5 m away on the other side of a wall: nothing. Nine metres down an open corridor: murmur.
    expect(audible(WALL, CELL, here, [here, there])).toEqual([]);
    const heard = audible(track, CELL, me, [me, downTheCorridor]);
    expect(heard).toHaveLength(1);
    expect(heard[0].level).toBeGreaterThan(0);
    expect(heard[0].level).toBeLessThan(1);
  });
});

describe('the cells I can be heard from', () => {
  // A 7-wide grid: col 3 is the door and col 4 is the cell on its far side, one and a half metres away.
  const me = { id: 1, ...at(1, 1) };
  const farSide = 1 * 7 + 4;

  it('stops at a shut door and reaches through it once it opens', () => {
    expect(audibleArea(SHUT, CELL, me).has(farSide)).toBe(false);
    expect(audibleArea(OPEN, CELL, me).has(farSide)).toBe(true);
  });

  it('stops at a wall the same way', () => {
    expect(audibleArea(WALL, CELL, me).has(farSide)).toBe(false);
  });

  it('includes the cell I am standing on', () => {
    expect(audibleArea(OPEN, CELL, me).has(1 * 7 + 1)).toBe(true);
  });

  it('stops at earshot along an open corridor, on the rule\'s own number', () => {
    const track = corridor(60);
    const stood = { id: 1, x: 0.25, y: 0.25 };
    const heard = audibleArea(track, CELL, stood);
    // Cell 15 is 7.5 m away, inside EARSHOT_M; cell 16 is exactly 8 m, where the level is zero.
    expect(heard.has(15)).toBe(true);
    expect(heard.has(16)).toBe(false);
    expect(levelAt(EARSHOT_M)).toBe(0);
  });
});

describe('the cases the Rust rule answers too', () => {
  // `fixtures/hearing-cases.json` is run by `crates/hearing` as well: a case one side passes and the other
  // fails is the two implementations drifting apart.
  const close = (got: number, wanted: number) => Math.abs(got - wanted) < 1e-5;

  it('fades with distance the same way', () => {
    for (const [distance, level] of sharedCases.levels) {
      expect(close(levelAt(distance), level), `at ${distance} m`).toBe(true);
    }
  });

  it.each(sharedCases.cases)('$says', ({ grid, me, everybody, within: wanted }) => {
    const cells = sharedCases.grids[grid as keyof typeof sharedCases.grids];
    const got = within(cells, sharedCases.cell_m, me, everybody);
    expect(got.map(heard => heard.id)).toEqual(wanted.map(heard => heard.id));
    got.forEach((heard, i) => expect(close(heard.level, wanted[i].level), `level of ${heard.id}`).toBe(true));
  });
});

describe('on the real floor', () => {
  const cells = floorPlan.floors[0].cells;

  it('carries sound along a straight piece of floor', () => {
    // Wherever two floor cells sit side by side: one area, half a metre apart.
    let pair: [number, number] | undefined;
    cells.forEach((line, row) => {
      const col = line.findIndex((cell, c) => cell === 'floor' && line[c + 1] === 'floor');
      if (pair === undefined && col >= 0) pair = [col, row];
    });
    expect(pair).toBeDefined();
    const [col, row] = pair as [number, number];
    const a = { id: 1, ...at(col, row) };
    const b = { id: 2, ...at(col + 1, row) };
    expect(audible(cells, CELL, a, [a, b])).toMatchObject([{ id: 2, level: 1 }]);
  });

  it('cuts off the room behind every shut door, in both directions', () => {
    // Every shut door the seed floor has, wherever the floor puts them: the rule on the real format, without
    // naming a cell of a floor that is laid out again from time to time.
    cells.forEach((line, row) => {
      line.forEach((cell, col) => {
        if (cell !== 'doorShut') return;
        // The two walkable cells a shut door stands between: one inside the room, one outside it.
        const sides = ([[col + 1, row], [col - 1, row], [col, row + 1], [col, row - 1]] as const)
          .filter(([c, r]) => cells[r] !== undefined && (cells[r][c] === 'floor' || cells[r][c] === 'doorOpen'))
          .map(([c, r]) => at(c, r));
        if (sides.length !== 2) return;
        const [a, b] = sides;
        expect(audible(cells, CELL, { id: 1, ...a }, [{ id: 1, ...a }, { id: 2, ...b }])).toEqual([]);
        expect(audible(cells, CELL, { id: 2, ...b }, [{ id: 1, ...a }, { id: 2, ...b }])).toEqual([]);
      });
    });
  });

  it('measures the way round a corner, not the straight line through a wall', () => {
    const corner = [
      ['wall', 'wall', 'wall', 'wall', 'wall'],
      ['wall', 'floor', 'wall', 'floor', 'wall'],
      ['wall', 'floor', 'wall', 'floor', 'wall'],
      ['wall', 'floor', 'floor', 'floor', 'wall'],
      ['wall', 'wall', 'wall', 'wall', 'wall'],
    ];
    const me = { id: 1, x: 0.75, y: 0.75 };
    const other = { id: 2, x: 1.75, y: 0.75 };

    // A metre apart as the crow flies, three metres the way round: the corridor is the only way.
    const [heard] = within(corner, CELL, me, [me, other]);
    expect(heard.distance).toBeCloseTo(3, 1);
    expect(heard.level).toBeCloseTo(0.5556, 3);
  });
});
