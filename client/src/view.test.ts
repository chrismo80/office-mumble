import { describe, expect, it } from 'vitest';

import { frontCell, frontCellTurned, RISE, SQUASH, WALL_HEIGHT_M } from './depth';
import { fit, MAX_ZOOM, MIN_ZOOM, pan, toPlan, toScreen, zoomAt, zoomCentred, zoomOf } from './view';

/** One cell is 0.5 m and one cell is 64 px at zoom 1, which is what this many pixels per metre means. */
const PX_PER_M = 64 / 0.5;

describe('the plan-to-screen conversion', () => {
  it('puts a floor in the middle of the canvas', () => {
    const t = fit(24, 10, 800, 600);
    const [x, y] = toScreen(t, 12, 5); // the middle of the floor
    expect(x).toBeCloseTo(400, 6);
    expect(y).toBeCloseTo(300, 6);
  });

  it('keeps the whole floor inside the canvas', () => {
    const t = fit(24, 10, 800, 600, 24);
    for (const [x, y] of [[0, 0], [24, 0], [0, 10], [24, 10]]) {
      const [sx, sy] = toScreen(t, x, y);
      expect(sx).toBeGreaterThanOrEqual(24 - 1e-6);
      expect(sx).toBeLessThanOrEqual(800 - 24 + 1e-6);
      expect(sy).toBeGreaterThanOrEqual(24 - 1e-6);
      expect(sy).toBeLessThanOrEqual(600 - 24 + 1e-6);
    }
  });

  it('turns a click back into the place it meant', () => {
    const t = fit(24, 10, 800, 600);
    const [x, y] = toPlan(t, 317, 244);
    const [backX, backY] = toScreen(t, x, y);
    expect(backX).toBeCloseTo(317, 6);
    expect(backY).toBeCloseTo(244, 6);

    // A turned and tilted view, too: a click there still means the place it lands on.
    const turned = { ...t, squash: 0.5, yaw: 2.2 };
    const [backTurnedX, backTurnedY] = toScreen(turned, ...toPlan(turned, 317, 244));
    expect(backTurnedX).toBeCloseTo(317, 6);
    expect(backTurnedY).toBeCloseTo(244, 6);
  });

  it('means what stands in front where a wall or a door rises over the floor', () => {
    const cell = 0.5;
    // One column of the plan, north to south.
    const column = (...codes: string[]): string[][] => codes.map(code => [code]);
    // How far a wall's top lies up the plan from its footprint: what it covers of the floor behind it.
    const reach = (WALL_HEIGHT_M * RISE) / SQUASH;
    const at = (cells: string[][], y: number) => frontCell(cells, cell, 0.25, y);

    const wall = column('floor', 'floor', 'floor', 'wall', 'floor');
    expect(at(wall, 3 * cell - 0.01), 'a click on a wall’s face must mean the wall').toEqual([3, 0]);
    expect(at(wall, 3 * cell - reach + 0.01), 'a click on a wall’s top must mean the wall').toEqual([3, 0]);
    expect(at(wall, 3 * cell - reach - 0.01), 'a click above a wall must mean the floor there').toEqual([Math.floor((3 * cell - reach - 0.01) / cell), 0]);
    expect(at(wall, 4 * cell + 0.01), 'a click in front of a wall must mean the floor in front').toEqual([4, 0]);

    const leaf = column('floor', 'floor', 'doorShut', 'floor');
    expect(at(leaf, 2 * cell - reach + 0.01), 'a click on the top of a shut door’s leaf must work the door').toEqual([2, 0]);

    const doorway = column('wall', 'wall', 'wall', 'doorOpen', 'wall', 'wall', 'floor');
    // Just below the top of the wall over the door: the part of its face no top further south covers.
    expect(at(doorway, 3 * cell - reach + 0.01), 'the face over an open door in a wall running away must be the door').toEqual([3, 0]);

    // A turned view, looking north-east: the wall's top stands up the screen from its footprint, over the
    // floor behind it, and a click there is still the wall — and in front of it still the floor.
    const turned = { scale: 100, ox: 400, oy: 300, squash: 0.5, yaw: Math.PI / 4 };
    const [topX, topY] = toScreen(turned, 0.25, 3 * cell + 0.25);
    const lifted = WALL_HEIGHT_M * Math.sqrt(1 - 0.5 ** 2) * 100;
    expect(frontCellTurned(wall, cell, turned, topX, topY - lifted), 'a click on a wall’s top must mean the wall, whichever way the view looks').toEqual([3, 0]);
    const [frontX, frontY] = toScreen(turned, 0.25, 4 * cell + 0.25);
    expect(frontCellTurned(wall, cell, turned, frontX, frontY), 'a click on the floor in front of a wall must mean that floor').toEqual([4, 0]);
  });
});

describe('zooming about the pointer', () => {
  it('one cell is 64 px at zoom 1', () => {
    const atOne = { scale: PX_PER_M, ox: 0, oy: 0 };
    const [x0] = toScreen(atOne, 0, 0);
    const [x1] = toScreen(atOne, 0.5, 0); // one cell to the right
    expect(x1 - x0).toBeCloseTo(64, 6);
  });

  it('keeps the plan under the pointer exactly where it was', () => {
    const t = fit(24, 10, 800, 600);
    const [px, py] = toPlan(t, 512, 321);
    const zoomed = zoomAt(t, 512, 321, 1.8, PX_PER_M);
    const [ax, ay] = toPlan(zoomed, 512, 321);
    expect(ax).toBeCloseTo(px, 9);
    expect(ay).toBeCloseTo(py, 9);
    expect(zoomed.scale).toBeGreaterThan(t.scale);
  });

  it('zooms out about the pointer the same way', () => {
    // A window whose fit sits inside the zoom range, so zooming out is not immediately the clamp.
    const t = fit(24, 10, 1200, 820);
    const [px, py] = toPlan(t, 100, 500);
    const zoomed = zoomAt(t, 100, 500, 0.5, PX_PER_M);
    expect(zoomed.scale).toBeLessThan(t.scale);
    const [ax, ay] = toPlan(zoomed, 100, 500);
    expect(ax).toBeCloseTo(px, 9);
    expect(ay).toBeCloseTo(py, 9);
  });

  it('stops at a sane range and does not move the pointer when it does', () => {
    let t = fit(24, 10, 1200, 820);
    for (let i = 0; i < 60; i++) t = zoomAt(t, 400, 300, 1.5, PX_PER_M);
    expect(t.scale / PX_PER_M).toBeCloseTo(MAX_ZOOM, 9);
    for (let i = 0; i < 60; i++) t = zoomAt(t, 400, 300, 0.7, PX_PER_M);
    expect(t.scale / PX_PER_M).toBeCloseTo(MIN_ZOOM, 9);
  });
});

describe('panning by a drag', () => {
  it('shifts the view by exactly the drag it is given, without changing the zoom', () => {
    const t = fit(24, 10, 800, 600);
    const moved = pan(t, 40, -25);
    const [x, y] = toScreen(moved, 3, 2);
    const [bx, by] = toScreen(t, 3, 2);
    expect(x - bx).toBeCloseTo(40, 9);
    expect(y - by).toBeCloseTo(-25, 9);
    expect(moved.scale).toBe(t.scale);
  });

  it('zooms about my figure and leaves it in the middle of the stage', () => {
    const t = zoomCentred({ scale: 64, ox: 0, oy: 0 }, 5, 3, 2, { w: 800, h: 600 }, 64);
    const [x, y] = toScreen(t, 5, 3);
    expect(x).toBeCloseTo(400, 6);
    expect(y).toBeCloseTo(300, 6);
    expect(zoomOf(t, 64)).toBeCloseTo(2, 6);
  });

  it('respects the zoom limits', () => {
    const t = zoomCentred({ scale: 64, ox: 0, oy: 0 }, 5, 3, 100, { w: 800, h: 600 }, 64);
    expect(zoomOf(t, 64)).toBeLessThanOrEqual(MAX_ZOOM);
  });
});
