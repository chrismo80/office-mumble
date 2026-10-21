import { describe, expect, it } from 'vitest';

import { behind, coast, hold, keepOrTurn, lookAt, nearestRoom, nearestView, OPEN_ZOOM, sameView, toward, turnToward, VIEWS } from './camera';
import { toScreen, type Transform } from './view';

const PX_PER_M = 64;

describe('the camera', () => {
  it('centres a building smaller than the window', () => {
    const t: Transform = { scale: 20, ox: 0, oy: 0 };
    const held = hold(t, { w: 10, h: 10 }, { w: 800, h: 600 });

    expect(held.ox).toBeCloseTo((800 - 10 * 20) / 2);
    expect(held.oy).toBeCloseTo((600 - 10 * 20) / 2);

    // Walls rising a metre above the north edge are part of what is centred: the building with them.
    const walled = hold(t, { w: 10, h: 10 }, { w: 800, h: 600 }, 1);
    expect(walled.oy - 1 * 20, 'the tops of the north walls must be as far from the top as the plan is from the bottom').toBeCloseTo(600 - (walled.oy + 10 * 20));
  });

  it('keeps a building larger than the window in it, but lets it be panned', () => {
    const t: Transform = { scale: 200, ox: -5000, oy: -5000 };
    const held = hold(t, { w: 20, h: 20 }, { w: 800, h: 600 });

    // The far edge of the building stays at least a margin inside the window.
    expect(held.ox).toBeGreaterThan(-20 * 200);
    expect(held.oy).toBeGreaterThan(-20 * 200);
  });

  it('travels to the goal and lands on it', () => {
    const start: Transform = { scale: 20, ox: 0, oy: 0 };
    const goal: Transform = { scale: 80, ox: 300, oy: 200 };

    let t = start;
    let arrived = false;
    for (let i = 0; i < 120 && !arrived; i++) {
      const step = toward(t, goal, 16);
      t = step.transform;
      arrived = step.arrived;
    }

    expect(arrived).toBe(true);
    expect(sameView(t, goal)).toBe(true);
  });

  it('lets a flick run out and then stops', () => {
    let t: Transform = { scale: 20, ox: 0, oy: 0 };
    let flung: { vx: number; vy: number } | null = { vx: 2000, vy: -1000 };
    const before = t.ox;

    for (let i = 0; i < 200 && flung; i++) {
      const step = coast(t, flung, 16);
      t = step.transform;
      flung = step.flung;
    }

    expect(flung).toBeNull();
    expect(t.ox).toBeGreaterThan(before);
  });

  it('looks at a point without zooming out', () => {
    const close: Transform = { scale: 200, ox: 0, oy: 0 };
    const atPoint = lookAt(close, 5, 5, OPEN_ZOOM, { w: 800, h: 600 }, PX_PER_M);

    // Already closer than the opening zoom: the camera keeps it.
    expect(atPoint.scale).toBeCloseTo(200);
    expect(atPoint.ox).toBeCloseTo(400 - 5 * 200);
  });

  it('brings a far view in to the opening zoom', () => {
    const far: Transform = { scale: 10, ox: 0, oy: 0 };
    const atPoint = lookAt(far, 0, 0, OPEN_ZOOM, { w: 800, h: 600 }, PX_PER_M);

    expect(atPoint.scale).toBeCloseTo(OPEN_ZOOM * PX_PER_M);
  });

  it('finds the nearest room within reach and none beyond it', () => {
    const labels = [{ row: 2, col: 2 }, { row: 20, col: 20 }];

    const near = nearestRoom(labels, 0.5, 1.0, 1.0);
    expect(near).toEqual({ x: 1.25, y: 1.25 });
    expect(nearestRoom(labels, 0.5, 30, 30)).toBeNull();
  });

  it('looks from behind a figure along one of four diagonals, and turns only when the walk turns back', () => {
    const northEast = Math.PI / 4;
    expect(VIEWS, 'the camera must look along a diagonal of the plan').toContain(northEast);
    expect(keepOrTurn(1, 0, northEast), 'walking east under a north-east view must not turn the room').toBe(northEast);
    expect(keepOrTurn(0, -1, northEast), 'walking north under a north-east view must not turn the room').toBe(northEast);
    expect(keepOrTurn(-1, 0, northEast), 'walking back west must turn the camera the near way, to north-west').toBe(-Math.PI / 4);
    expect(nearestView(1, 1, 0), 'walking south-east must be seen from behind, looking south-east').toBeCloseTo((3 * Math.PI) / 4);

    const stage = { w: 800, h: 600 };
    // The figure stands low in the middle, and what is ahead of it is drawn above it.
    const view = behind(10, 4, northEast, 60, 0.5, stage, 0.68);
    const [fx, fy] = toScreen(view, 10, 4);
    expect(fx).toBeCloseTo(400);
    expect(fy).toBeCloseTo(600 * 0.68);
    const [, aheadY] = toScreen(view, 13, 4);
    expect(aheadY, 'what lies ahead of the figure must be drawn further up the screen').toBeLessThan(fy);

    // A turn across south goes the short way round, not three quarters back through north.
    const step = turnToward(Math.PI * 0.9, -Math.PI * 0.9, 16);
    expect(step, 'a turn from just west of south to just east of it must pass through south').toBeGreaterThan(Math.PI * 0.9);
  });
});
