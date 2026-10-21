import { describe, expect, it } from 'vitest';

import { SQUASH } from './depth';
import { flightCellAt, STAIR_HEIGHT_M, treadsOf, underfoot } from './stair';
import { toPlan, toScreen, type Transform } from './view';
import type { Floor, Stair } from './wire';

const CELL_M = 0.5;
const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' } as const;
/** A flight of six cells by two, laid along the axis its exit names, climbing from floor 0 to floor 1. */
const flightTo = (exits: Stair['exits']): Stair =>
  exits === 'east' || exits === 'west'
    ? { row: 2, col: 2, rows: 2, cols: 6, exits, to: 1 }
    : { row: 2, col: 2, rows: 6, cols: 2, exits, to: 1 };
const footprint = (t: { x0: number; y0: number; x1: number; y1: number }): string => [t.x0, t.y0, t.x1, t.y1].map(v => v.toFixed(3)).join(',');

describe('a stair in three dimensions', () => {
  for (const exits of ['north', 'south', 'east', 'west'] as const) {
    it(`climbs towards the side it is left by, ${exits}, and comes down into the floor above as the same flight`, () => {
      const up = flightTo(exits);
      const treads = treadsOf(up, 0, CELL_M);
      for (let k = 1; k < treads.length; k++) expect(treads[k].z, 'each tread must stand higher than the one before').toBeGreaterThan(treads[k - 1].z);
      expect(treads[treads.length - 1].z).toBeCloseTo(STAIR_HEIGHT_M, 6);
      // The highest tread lies on the exit side of the flight's middle.
      const last = treads[treads.length - 1];
      const way = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[exits];
      const fromMiddle = [(last.x0 + last.x1) / 2 - (up.col + up.cols / 2) * CELL_M, (last.y0 + last.y1) / 2 - (up.row + up.rows / 2) * CELL_M];
      expect(fromMiddle[0] * way[0] + fromMiddle[1] * way[1], 'the top of the flight must be at its exit').toBeGreaterThan(0);

      // Upstairs the flight is named the other way round, and every tread is where it was, one flight lower.
      const down = { ...up, exits: opposite[exits], to: 0 };
      const below = new Map(treads.map(t => [footprint(t), t.z]));
      const well = treadsOf(down, 1, CELL_M);
      expect(well[0].z, 'the tread a well is entered at must be level with the floor').toBeCloseTo(0, 6);
      for (const tread of well) expect(tread.z).toBeCloseTo((below.get(footprint(tread)) ?? Number.NaN) - STAIR_HEIGHT_M, 6);
    });
  }

  it('has a tread under every point of the flight and none beside it', () => {
    const stair = flightTo('east');
    const floor = { stairs: [stair] } as Floor;
    for (let x = 1.05; x < 4; x += 0.1) for (let y = 1.05; y < 2; y += 0.1) expect(underfoot(floor, 0, CELL_M, x, y)).not.toBeNull();
    expect(underfoot(floor, 0, CELL_M, 0.9, 1.5)).toBeNull();
    expect(underfoot(floor, 0, CELL_M, 2.5, 2.1)).toBeNull();
  });

  it('takes a click on the top of the flight for the flight, though the floor drawn there is another cell', () => {
    const stair = flightTo('east');
    const floor = { stairs: [stair], cells: [] as string[][] } as unknown as Floor;
    const t: Transform = { scale: 100, ox: 0, oy: 0, squash: SQUASH };
    const top = treadsOf(stair, 0, CELL_M).at(-1)!;
    const [sx, floorY] = toScreen(t, (top.x0 + top.x1) / 2, (top.y0 + top.y1) / 2);
    const sy = floorY - top.z * Math.sqrt(1 - SQUASH ** 2) * t.scale;
    const [, behind] = toPlan(t, sx, sy);
    expect(behind, 'the point must lie over a cell north of the flight').toBeLessThan(stair.row * CELL_M);
    expect(flightCellAt(floor, 0, CELL_M, t, sx, sy)?.cell).toEqual([3, 7]);
    expect(flightCellAt(floor, 1, CELL_M, t, sx, sy), 'a well is clicked where it lies, not above it').toBeNull();
  });
});
