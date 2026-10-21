import { describe, expect, it } from 'vitest';

import {
  applyChanges,
  arranged,
  arrangementProblem,
  cellsBetween,
  movesBy,
  nearestWalkable,
  pieceAt,
  piecesIn,
  placementProblem,
  resizeFor,
  stampAt,
  stampOf,
  strokeFor,
  survivingChanges,
  toggledDoor,
  turnMoves,
  turnStamp,
  walkable,
} from './edit';
import type { Cell, Floor, Object as Piece } from './wire';

/** A floor of `rows` by `cols` cells, all floor unless a cell is named otherwise. */
function floorOf(rows: number, cols: number, objects: Piece[] = [], set: Array<[number, number, Cell]> = []): Floor {
  const cells: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'floor' as Cell));
  for (const [row, col, cell] of set) cells[row][col] = cell;
  return { name: 'T', surface: 'parquet', cells, painted: [], objects, labels: [] };
}

const piece = (kind: string, row: number, col: number, facing = 'south'): Piece => ({ kind, row, col, facing });

describe('a stroke over the grid', () => {
  it('walks every cell between two cells and skips none', () => {
    expect(cellsBetween([0, 0], [0, 4])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]);
    expect(cellsBetween([1, 1], [1, 1])).toEqual([[1, 1]]);
    expect(cellsBetween([0, 0], [3, 3])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
  });

  it('draws a wall straight along the way the drag went further, whatever the hand did across it', () => {
    const cells = floorOf(5, 6).cells;
    const wall = strokeFor('wall', cells, [1, 0], [2, 4]);
    expect(wall.map(c => [c.row, c.col])).toEqual([[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]]);
    expect(wall.every(c => c.cell === 'wall')).toBe(true);
    const down = strokeFor('wall', cells, [0, 2], [4, 3]);
    expect(down.map(c => [c.row, c.col])).toEqual([[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]]);
  });

  it('fills a rectangle with floor or with void, and only on the grid', () => {
    const cells = floorOf(3, 3).cells;
    expect(strokeFor('floor', cells, [2, 2], [1, 1])).toHaveLength(4);
    const erase = strokeFor('erase', cells, [1, 1], [9, 9]);
    expect(erase.map(c => [c.row, c.col])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
    expect(erase.every(c => c.cell === 'void')).toBe(true);
  });

  it('builds a room as walls round a floor, and keeps a door already in its outline', () => {
    const cells = floorOf(5, 5, [], [[0, 2, 'doorShut']]).cells;
    const room = applyChanges(cells, strokeFor('room', cells, [0, 0], [3, 4]));
    expect(room[0]).toEqual(['wall', 'wall', 'doorShut', 'wall', 'wall']);
    expect(room[1]).toEqual(['wall', 'floor', 'floor', 'floor', 'wall']);
    expect(room[3]).toEqual(['wall', 'wall', 'wall', 'wall', 'wall']);
    expect(room[4], 'outside the room nothing may change').toEqual(cells[4]);
  });

  it('puts a door only into wall', () => {
    const cells = floorOf(1, 4, [], [[0, 1, 'wall'], [0, 2, 'wall']]).cells;
    expect(strokeFor('door', cells, [0, 0], [0, 3])).toEqual([
      { row: 0, col: 1, cell: 'doorOpen' },
      { row: 0, col: 2, cell: 'doorOpen' },
    ]);
  });

  it('lengthens a window already there instead of stopping at it', () => {
    const cells = floorOf(1, 4, [], [[0, 0, 'wall'], [0, 1, 'window'], [0, 2, 'wall'], [0, 3, 'floor']]).cells;
    expect(strokeFor('window', cells, [0, 0], [0, 2]).map(change => change.col)).toEqual([0, 1, 2]);
  });

  it('puts a window only into wall, and leaves floor and doors alone', () => {
    const cells = floorOf(1, 4, [], [[0, 0, 'wall'], [0, 1, 'floor'], [0, 2, 'wall'], [0, 3, 'doorOpen']]).cells;
    expect(strokeFor('window', cells, [0, 0], [0, 3])).toEqual([
      { row: 0, col: 0, cell: 'window' },
      { row: 0, col: 2, cell: 'window' },
    ]);
  });

  it('writes a stroke into a new grid and leaves the one it was given alone', () => {
    const grid: Cell[][] = [['floor', 'floor']];
    const next = applyChanges(grid, [{ row: 0, col: 1, cell: 'wall' }, { row: 5, col: 5, cell: 'wall' }]);
    expect(next).toEqual([['floor', 'wall']]);
    expect(grid[0][1]).toBe('floor');
  });

  it('takes what stood on an erased cell with it, and nothing a wall was drawn over', () => {
    const objects = [piece('desk', 1, 2), piece('chairDesk', 2, 2)];
    expect(survivingChanges(objects, [{ row: 1, col: 2, cell: 'void' }])).toEqual([piece('chairDesk', 2, 2)]);
    expect(survivingChanges(objects, [{ row: 1, col: 2, cell: 'wall' }])).toBe(objects);
  });
});

describe('a stamp', () => {
  // A desk with its chair north of it: the pair as somebody would copy it off the floor.
  const pair = [piece('chairDesk', 4, 6), piece('desk', 5, 6)];

  it('is measured from its own top-left and put down with its middle under the pointer', () => {
    const stamp = stampOf(pair);
    expect(stamp).toEqual([
      { kind: 'chairDesk', dr: 0, dc: 0, facing: 'south' },
      { kind: 'desk', dr: 1, dc: 0, facing: 'south' },
    ]);
    expect(stampAt(stamp, 10, 10)).toEqual([piece('chairDesk', 10, 10), piece('desk', 11, 10)]);
  });

  it('turns as a whole: the chair stays at its desk and both face the new way', () => {
    const turned = turnStamp(stampOf(pair), true);
    expect(turned).toEqual([
      { kind: 'chairDesk', dr: 0, dc: 1, facing: 'west' },
      { kind: 'desk', dr: 0, dc: 0, facing: 'west' },
    ]);
    const round = [true, true, true].reduce((stamp, clockwise) => turnStamp(stamp, clockwise), turned);
    expect(round, 'four quarter turns must be no turn').toEqual(stampOf(pair));
  });

  it('may not be put down outside the floor, on void, or on something already standing', () => {
    const floor = floorOf(3, 3, [piece('plantSmall1', 1, 1)], [[0, 2, 'void']]);
    expect(placementProblem(floor, [piece('desk', 0, 0)])).toBeNull();
    expect(placementProblem(floor, [piece('desk', 1, 1)])).toBe('dort steht schon etwas');
    expect(placementProblem(floor, [piece('desk', 0, 2)])).toBe('outside the floor plan');
    expect(placementProblem(floor, [piece('desk', 3, 0)])).toBe('outside the floor plan');
  });
});

describe('a selection on the floor', () => {
  const floor = floorOf(6, 6, [piece('chairDesk', 1, 1), piece('desk', 2, 1), piece('plantSmall1', 1, 3)]);
  const group = floor.objects.slice(0, 2);

  it('moves onto its own cells as a whole, and is refused onto something that stays', () => {
    const down = movesBy(group, 1, 0);
    expect(arrangementProblem(floor, down), 'the chair landing where the desk stood must be a move').toBeNull();
    expect(arranged(floor.objects, down).slice(0, 2)).toEqual([piece('chairDesk', 2, 1), piece('desk', 3, 1)]);
    expect(arrangementProblem(floor, movesBy(group, 0, 2))).toBe('dort steht schon etwas');
    expect(arrangementProblem(floor, movesBy(group, 0, -2))).toBe('outside the floor plan');
  });

  it('turns about its middle, and a single piece turns on its own cell', () => {
    expect(turnMoves([piece('desk', 2, 1)], true)).toEqual([{ row: 2, col: 1, to_row: 2, to_col: 1, facing: 'west' }]);
    expect(turnMoves(group, true).map(m => [m.to_row, m.to_col, m.facing])).toEqual([
      [1, 1, 'west'],
      [1, 0, 'west'],
    ]);
  });

  it('is caught by a marquee by the cell each piece stands on', () => {
    expect(piecesIn(floor.objects, [0, 0], [1, 2])).toEqual([piece('chairDesk', 1, 1)]);
    expect(piecesIn(floor.objects, [2, 3], [0, 0])).toHaveLength(3);
  });

  it('is hit anywhere on a piece, not only on the cell it is anchored to', () => {
    const sofa = piece('loungeSofaLong', 3, 3);
    const sizes = (kind: string) => (kind === 'loungeSofaLong' ? { w: 170, d: 80 } : undefined);
    // The sofa is 1.7 m wide, centred on its cell at x = 1.75 m: it reaches from 0.9 m to 2.6 m.
    expect(pieceAt([sofa], sizes, 0.5, 1.0, 1.75)).toBe(sofa);
    expect(pieceAt([sofa], sizes, 0.5, 2.55, 1.75)).toBe(sofa);
    expect(pieceAt([sofa], sizes, 0.5, 2.7, 1.75)).toBeNull();
    // Turned east, it is 1.7 m deep instead.
    const turned = { ...sofa, facing: 'east' };
    expect(pieceAt([turned], sizes, 0.5, 1.75, 1.0)).toBe(turned);
    expect(pieceAt([turned], sizes, 0.5, 1.0, 1.75)).toBeNull();
  });
});

describe('the floor dragged at an edge', () => {
  it('grows by the cells it was dragged out, and cuts by the cells it was dragged in', () => {
    expect(resizeFor('top', 3, 10, 8)).toEqual({ top: 3, right: 0, bottom: 0, left: 0 });
    expect(resizeFor('right', -2, 10, 8)).toEqual({ top: 0, right: -2, bottom: 0, left: 0 });
  });

  it('stops at one cell rather than asking for a floor that cannot be', () => {
    expect(resizeFor('left', -20, 10, 8).left).toBe(-7);
    expect(resizeFor('bottom', -20, 10, 8).bottom).toBe(-9);
  });
});

describe('a door click', () => {
  it('turns a door to its other state and leaves anything else alone', () => {
    expect(toggledDoor('doorOpen')).toBe('doorShut');
    expect(toggledDoor('doorShut')).toBe('doorOpen');
    expect(toggledDoor('floor')).toBeNull();
    expect(toggledDoor('wall')).toBeNull();
    expect(toggledDoor(undefined)).toBeNull();
  });
});

describe('carrying somebody a plan has walled in', () => {
  // Only one walkable cell, at (row 1, col 2), so the answer is the same wherever somebody was standing.
  const grid: Cell[][] = [
    ['wall', 'wall', 'wall'],
    ['wall', 'wall', 'floor'],
    ['wall', 'wall', 'wall'],
  ];

  it('finds the nearest walkable cell to a point inside a wall', () => {
    expect(nearestWalkable(grid, 0.5, 0.75, 0.75)).toEqual([1, 2]); // cell (1,1) is a wall
  });

  it('returns the cell itself when it is already on the floor', () => {
    expect(nearestWalkable(grid, 0.5, 1.25, 0.75)).toEqual([1, 2]);
  });

  it('has nothing to offer when there is nowhere to stand', () => {
    expect(nearestWalkable([['wall', 'wall']], 0.5, 0.2, 0.2)).toBeNull();
    expect(nearestWalkable([], 0.5, 0, 0)).toBeNull();
  });

  it('calls floor and an open door walkable, and a shut door and void not', () => {
    const cells: Cell[][] = [['floor', 'doorOpen', 'doorShut', 'void']];
    expect(walkable(cells, 0, 0)).toBe(true);
    expect(walkable(cells, 0, 1)).toBe(true);
    expect(walkable(cells, 0, 2)).toBe(false);
    expect(walkable(cells, 0, 3)).toBe(false);
    expect(walkable(cells, 9, 9)).toBe(false);
  });
});
