import { describe, expect, it } from 'vitest';
import { aMetreShort, arrowStep, doorSide, stairClimb } from './steering';

describe('the arrow keys', () => {
  it('points where a single key points', () => {
    expect(arrowStep(['ArrowUp'])).toEqual({ dx: 0, dy: -1 });
    expect(arrowStep(['ArrowRight'])).toEqual({ dx: 1, dy: 0 });
  });

  it('makes a diagonal a unit vector, not one that is 1.41 long', () => {
    const step = arrowStep(['ArrowLeft', 'ArrowDown']);
    expect(step).not.toBeNull();
    expect(Math.hypot(step!.dx, step!.dy)).toBeCloseTo(1, 6);
    expect(step!.dx).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(step!.dy).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('stands still when nothing is held, or when opposite keys cancel', () => {
    expect(arrowStep([])).toBeNull();
    expect(arrowStep(['ArrowLeft', 'ArrowRight'])).toBeNull();
    expect(arrowStep(['ArrowUp', 'ArrowDown'])).toBeNull();
  });
});

describe('walking to somebody', () => {
  it('stops a metre short, on the side I am on', () => {
    const to = aMetreShort({ x: 5, y: 1 }, { x: 1, y: 1 });
    expect(to.x).toBeCloseTo(2, 6);
    expect(to.y).toBeCloseTo(1, 6);
  });

  it('steps in from the north when I am standing on them', () => {
    expect(aMetreShort({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual({ x: 1, y: 0 });
  });

  it('counts the climb from the foot of the flight to the tread you leave by', () => {
    const stair = { row: 2, rows: 2, col: 2, cols: 6, exits: 'east', to: 1 } as const;

    // The foot of the flight is the west end, the tread you leave by the east one.
    expect(stairClimb(stair, 1.25, 1.25, 0.5)).toBe(0);
    expect(stairClimb(stair, 3.75, 1.25, 0.5)).toBe(1);
    // Halfway up the sixth cell of the run is not halfway up the five steps.
    expect(stairClimb(stair, 2.75, 1.25, 0.5)).toBeCloseTo(0.6, 5);
  });

  it('stands on my side of a shut door, not behind it', () => {
    const cells = [['wall', 'floor', 'doorShut', 'floor', 'wall']];

    // Coming from the left, the place to stand is the cell before the door — the door itself is a wall, and
    // the nearest walkable cell to it would have been the one on the far side.
    expect(doorSide(cells, 0.5, { x: 0.75, y: 0.25 }, 0, 2)).toEqual({ row: 0, col: 1 });
    expect(doorSide(cells, 0.5, { x: 1.75, y: 0.25 }, 0, 2)).toEqual({ row: 0, col: 3 });

    // A wall next to the door: the door itself is the aim, and the server picks the nearest walkable cell.
    const tight = [['wall', 'floor', 'doorShut', 'wall', 'wall']];
    expect(doorSide(tight, 0.5, { x: 1.75, y: 0.25 }, 0, 2)).toEqual({ row: 0, col: 2 });
  });
});
