/**
 * The camera: where the view is going and how it gets there.
 *
 * Everything here is a function of a `Transform` and returns one. The state that makes a camera a camera —
 * the goal it is travelling to, the flick it is still coasting on — stays with the caller, so what is left
 * is arithmetic: no canvas, no floor, no clock, and testable on its own.
 */

import { MAX_ZOOM, MIN_ZOOM, squashOf, toView, zoomOf, type Transform } from './view';

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type Velocity = { vx: number; vy: number };

/** How close the office opens: about eleven metres across at a 0.5 m cell, so a room and its neighbours. */
export const OPEN_ZOOM = 0.62;

/** Near enough to stop easing. */
export function sameView(a: Transform, b: Transform): boolean {
  return Math.abs(a.scale - b.scale) < 0.002 * a.scale
    && Math.abs(a.ox - b.ox) < 0.5
    && Math.abs(a.oy - b.oy) < 0.5;
}

/** The middle of the room nearest a point on the plan, if there is one within a room's reach. */
export function nearestRoom(
  labels: ReadonlyArray<{ row: number; col: number }>,
  cellM: number,
  x: number,
  y: number,
): Point | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const label of labels) {
    const at = { x: (label.col + 0.5) * cellM, y: (label.row + 0.5) * cellM };
    const d = Math.hypot(at.x - x, at.y - y);
    if (d < 7 && (best === null || d < best.d)) best = { ...at, d };
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * Look at a point of the plan. Never zooms *out* to get there: somebody reading a desk at 3× and jumping to a
 * room keeps their zoom; somebody looking at the whole floor is brought in to a legible one.
 */
export function lookAt(
  t: Transform,
  x: number,
  y: number,
  zoom: number,
  stage: Size,
  pxPerM: number,
): Transform {
  if (stage.w === 0 || stage.h === 0) return t;
  const now = zoomOf(t, pxPerM);
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.max(zoom, Math.min(now, MAX_ZOOM))));
  const scale = z * pxPerM;
  return { scale, ox: stage.w / 2 - x * scale, oy: stage.h / 2 - y * scale * squashOf(t), squash: squashOf(t) === 1 ? undefined : squashOf(t) };
}

/**
 * Keep the office in the window. A building smaller than the frame is centred; a larger one may be panned,
 * but never further than leaving a hand's width of plan on every side — a camera dragged into empty table has
 * lost the thing it was looking at. `above` is how far, in screen metres, the walls on the north edge rise
 * above the plan: part of the building, so part of what is centred.
 */
export function hold(t: Transform, plan: Size, stage: Size, above = 0): Transform {
  if (plan.w <= 0 || stage.w === 0 || stage.h === 0) return t;
  const margin = Math.max(48, Math.min(stage.w, stage.h) * 0.12);
  const planW = plan.w * t.scale;
  const rise = above * t.scale;
  const planH = plan.h * t.scale * squashOf(t) + rise;
  // A building bigger than the window may be panned until half the window is empty: a figure at the edge of
  // the plan has to be able to sit in the middle of the view, and that leaves floor on one side only.
  const slackW = Math.max(margin, stage.w / 2);
  const slackH = Math.max(margin, stage.h / 2);
  const ox = planW <= stage.w ? (stage.w - planW) / 2 : Math.min(slackW, Math.max(stage.w - planW - slackW, t.ox));
  // Worked out for the top of the walls, and handed back for the plan's own north edge beneath them.
  const top = planH <= stage.h ? (stage.h - planH) / 2 : Math.min(slackH, Math.max(stage.h - planH - slackH, t.oy - rise));
  const oy = top + rise;
  return ox === t.ox && oy === t.oy ? t : { ...t, ox, oy };
}

/** One frame's worth of travel toward the goal. Frame-rate independent: `dt` is milliseconds. */
export function toward(t: Transform, goal: Transform, dt: number): { transform: Transform; arrived: boolean } {
  const k = 1 - Math.exp(-dt / 110);
  const scale = Math.exp(Math.log(t.scale) + (Math.log(goal.scale) - Math.log(t.scale)) * k);
  const next = {
    ...t,
    scale,
    ox: t.ox + (goal.ox - t.ox) * k,
    oy: t.oy + (goal.oy - t.oy) * k,
  };
  return sameView(next, goal) ? { transform: goal, arrived: true } : { transform: next, arrived: false };
}

/** One frame of a flick, slowing down until it is slow enough to stop. */
export function coast(
  t: Transform,
  flung: Velocity,
  dt: number,
): { transform: Transform; flung: Velocity | null } {
  const decay = Math.exp(-dt / 320);
  const next = {
    ...t,
    ox: t.ox + (flung.vx * dt) / 1000,
    oy: t.oy + (flung.vy * dt) / 1000,
  };
  const left = { vx: flung.vx * decay, vy: flung.vy * decay };
  return { transform: next, flung: Math.hypot(left.vx, left.vy) < 40 ? null : left };
}

// ── from behind a figure ─────────────────────────────────────────────────────────────────────────────

/**
 * The four ways the camera looks from behind a figure, as yaws — north is 0, east a quarter turn: north-east,
 * south-east, south-west, north-west. Diagonally across the plan, so every wall shows two of its faces, and
 * fixed, so the room stands still between two turns and what is drawn of it can be kept.
 */
export const VIEWS = [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4];

/** How far ahead a heading points for a camera looking along `yaw`: 1 straight ahead, −1 straight at it. */
const ahead = (dx: number, dy: number, yaw: number): number => dx * Math.sin(yaw) - dy * Math.cos(yaw);

/** The short way round from one yaw to another, in radians. */
const turnBetween = (from: number, to: number): number => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** The view that looks most nearly along a heading; between two equally near, the one less far from `prefer`. */
export function nearestView(dx: number, dy: number, prefer: number): number {
  let best = VIEWS[0];
  for (const yaw of VIEWS) {
    const gain = ahead(dx, dy, yaw) - ahead(dx, dy, best);
    if (gain > 1e-6 || (gain > -1e-6 && Math.abs(turnBetween(prefer, yaw)) < Math.abs(turnBetween(prefer, best)))) best = yaw;
  }
  return best;
}

/** How far a heading may turn towards the camera before the camera turns: a little past square to it. Walking
 *  across the picture keeps the room still; walking back towards the viewer turns it. */
const TURN_WHEN = -0.17;

/** The view to look along while walking along a heading: the one already looked along, unless the walk has
 *  turned back towards the camera. */
export function keepOrTurn(dx: number, dy: number, current: number): number {
  return ahead(dx, dy, current) > TURN_WHEN ? current : nearestView(dx, dy, current);
}

/** One frame's worth of turning from one yaw towards another, the short way round. `dt` is milliseconds. */
export function turnToward(from: number, to: number, dt: number, tau = 140): number {
  const left = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + left * (1 - Math.exp(-dt / tau));
}

/**
 * The view from behind a point of the plan, looking along `yaw`: the point stands in the middle across and
 * `at` of the way down the stage, so most of the picture is what lies ahead of it.
 */
export function behind(x: number, y: number, yaw: number, scale: number, squash: number, stage: Size, at: number): Transform {
  const t: Transform = { scale, ox: 0, oy: 0, squash, yaw };
  const [u, v] = toView(t, x, y);
  return { ...t, ox: stage.w / 2 - u * scale, oy: stage.h * at - v * scale * squash };
}
