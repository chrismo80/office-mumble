/**
 * The camera: where the floor sits, how far in it is, and how it follows my figure. Also the easing that
 * trails the server's positions by a tick, because that is what makes a figure read as walking.
 *
 * It draws nothing. It only turns metres into pixels and moves the window over the floor.
 */

import { behind, coast, hold, keepOrTurn, lookAt, nearestRoom, nearestView, toward, turnToward, OPEN_ZOOM } from './camera';
import { RISE, SQUASH, WALL_HEIGHT_M } from './depth';
import { facingVector } from './figure';
import { fit, MAX_ZOOM, nearness, riseOf, toScreen, zoomOf, type Transform } from './view';
import { squashOf } from './view';
import type { Scene } from './scene';
import { underfoot } from './stair';
import type { PersonView } from './wire';
import { S } from './state';

/** How large a cell is drawn when zoomed all the way in. */
export const ZOOM_CELL_PX = 64;

export function pxPerM(): number {
  return ZOOM_CELL_PX / S.cellM;
}

export function planSize(): { w: number; h: number } {
  return { w: (S.floor?.cells[0]?.length ?? 48) * S.cellM, h: (S.floor?.cells.length ?? 0) * S.cellM };
}

export function stageSize(): { w: number; h: number } {
  return { w: S.canvas.clientWidth, h: S.canvas.clientHeight };
}

export function resizeCanvas(): void {
  const { w, h } = stageSize();
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  S.canvas.width = Math.floor(w * dpr);
  S.canvas.height = Math.floor(h * dpr);
  S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function fitToWindow(): void {
  const { w, h } = stageSize();
  // No plan yet, or no place on screen to show it in: there is nothing to fit, and fitting a floor that
  // is not there would fix the camera on a size nobody asked for.
  if (!S.floor || w === 0 || h === 0) return;
  const size = planSize();
  S.transform = fit(size.w, size.h, w, h, 24, SQUASH, WALL_HEIGHT_M * RISE);
  S.fitted = true;
  S.fittedTo = { w, h };
  // A fit is a decision taken now, not a journey: it also ends any travel that was in the air.
  S.goal = null;
  S.flung = null;
}

export function localPoint(clientX: number, clientY: number): [number, number] {
  const rect = S.canvas.getBoundingClientRect();
  return [clientX - rect.left, clientY - rect.top];
}

export function aim(next: Transform): void {
  S.goal = next;
  S.flung = null;
}

export function openOn(x: number, y: number, zoom = OPEN_ZOOM): void {
  aim(lookAt(S.transform, x, y, zoom, stageSize(), pxPerM()));
}

export function openOnMe(): void {
  const mine = S.standing.get(S.me);
  if (!S.floor || !mine) return;
  S.openAtMe = false;
  // Towards the room a little, so a person by an outer wall does not open with half a frame of wall.
  const room = nearestRoom(S.floor.labels ?? [], S.cellM, mine.x, mine.y);
  if (room) openOn(mine.x + (room.x - mine.x) * 0.28, mine.y + (room.y - mine.y) * 0.28);
  else openOn(mine.x, mine.y + 0.6);
}

export function smoothPeople(dt: number): Map<number, PersonView> {
  const here = onMyFloor();
  const k = 1 - Math.exp(-dt / 45);
  for (const [id, person] of here) {
    const at = S.drawn.get(id);
    if (!at) S.drawn.set(id, { x: person.x, y: person.y });
    else {
      at.x += (person.x - at.x) * k;
      at.y += (person.y - at.y) * k;
    }
  }
  for (const id of [...S.drawn.keys()]) if (!here.has(id)) S.drawn.delete(id);
  return new Map([...here].map(([id, person]) => {
    const at = S.drawn.get(id) as { x: number; y: number };
    return [id, { ...person, x: at.x, y: at.y }];
  }));
}

export function stepCamera(dt: number, here: Map<number, PersonView>): void {
  if (S.behindOn || S.transform.yaw !== undefined) {
    stepBehind(dt, here);
    return;
  }
  if (S.goal) {
    const step = toward(S.transform, S.goal, dt);
    S.transform = hold(step.transform, planSize(), stageSize(), WALL_HEIGHT_M * RISE);
    if (step.arrived) S.goal = null;
  } else if (S.flung) {
    const step = coast(S.transform, S.flung, dt);
    S.transform = hold(step.transform, planSize(), stageSize(), WALL_HEIGHT_M * RISE);
    S.flung = step.flung;
  } else if (!S.drag) {
    followMe(here);
  }
}

export function followMe(here: Map<number, PersonView>): void {
  const mine = here.get(S.me);
  if (!mine) return;
  const moved = S.lastMine === null || Math.hypot(mine.x - S.lastMine.x, mine.y - S.lastMine.y) > 1e-3;
  S.lastMine = { x: mine.x, y: mine.y };
  // A figure standing still does not drag the view back: looking somewhere else by hand stays where it was put.
  if (!moved || zoomOf(S.transform, pxPerM()) <= fitZoom() * 1.02) return;
  const { w, h } = stageSize();
  const [sx, sy] = toScreen(S.transform, mine.x, mine.y);
  if (Math.abs(sx - w / 2) < (w / 2) * S.deadZone && Math.abs(sy - h / 2) < (h / 2) * S.deadZone) return;
  // A dead zone squeezed to nothing means the figure is meant to sit in the middle: put the view there at
  // once, every frame. The figure is drawn from a smoothed position, so the view moves smoothly with it —
  // easing this too would make the figure leave the middle and be pulled back in steps. A wide zone is a
  // rare correction and may glide there instead of jumping.
  const centred = lookAt(S.transform, mine.x, mine.y, zoomOf(S.transform, pxPerM()), { w, h }, pxPerM());
  if (S.deadZone < 0.05) S.transform = hold(centred, planSize(), stageSize(), WALL_HEIGHT_M * RISE);
  else aim(centred);
}

export function fitZoom(): number {
  const { w, h } = stageSize();
  const size = planSize();
  return fit(size.w, size.h, w, h, 24, SQUASH, WALL_HEIGHT_M * RISE).scale / pxPerM();
}

export function onMyFloor(): Map<number, PersonView> {
  return new Map([...S.standing].filter(([, person]) => (person.floor ?? 0) === S.myFloor));
}

export function sceneNow(): Scene | null {
  if (!S.floor) return null;
  // From behind, the walls between the camera and me are cut down, so they never stand in front of me.
  const mine = S.behindOn ? S.crowd.shownAt(S.me) : null;
  // On a stair my feet are on a tread, above the floor or below it, and that is where whatever covers me is.
  const tread = mine ? underfoot(S.floor, S.myFloor, S.cellM, mine.x, mine.y)?.tread : undefined;
  const feet = mine ? toScreen(S.transform, mine.x, mine.y) : null;
  return {
    ctx: S.ctx, floor: S.floor, storey: S.myFloor, cellM: S.cellM, transform: S.transform, size: S.transform.scale * S.cellM, sizeY: S.transform.scale * S.cellM * squashOf(S.transform),
    ...(mine && feet
      ? { cut: nearness(S.transform, mine.x, mine.y), mineAt: [feet[0], feet[1] - (tread?.z ?? 0) * riseOf(S.transform) * S.transform.scale] as [number, number] }
      : {}),
  };
}

// ── from behind my figure ────────────────────────────────────────────────────────────────────────────

/** How far from straight down the room is seen from behind a figure: lower than the plan's angle, so the room
 *  ahead stands up and the walls show their faces. */
const BEHIND_ANGLE_DEG = 60;
const BEHIND_SQUASH = Math.cos((BEHIND_ANGLE_DEG * Math.PI) / 180);
/** Where my figure stands on the stage from behind: below the middle, so most of the picture lies ahead. */
const BEHIND_AT = 0.68;
/** How close the view from behind starts, as a zoom: a room around me, not the floor. */
const BEHIND_ZOOM = 1.25;
/** Below this speed, in metres a second, I am standing, and the camera keeps the way it looks. */
const WALKING_M_S = 0.4;

/** Into the view from behind my figure, or back out of it. */
export function toggleBehind(): void {
  if (S.behindOn) {
    S.behindOn = false;
    S.yawGoal = 0;
    return;
  }
  S.behindOn = true;
  // Behind me as I stand: the diagonal nearest the way my figure faces, until I walk.
  const [fx, fy] = facingVector(S.crowd.facingOf(S.me) ?? 'north');
  S.yawGoal = nearestView(fx, fy, 0);
  S.heading = null;
  S.behindScale = Math.min(MAX_ZOOM * pxPerM(), Math.max(S.transform.scale, BEHIND_ZOOM * pxPerM()));
  S.goal = null;
  S.flung = null;
  if (S.transform.yaw === undefined) S.transform = { ...S.transform, yaw: 0 };
}

/** Straight out of the view from behind, with no glide: the whole floor, `0`, is a decision taken now. */
export function dropBehind(): void {
  S.behindOn = false;
  S.descent = 0;
  S.yawGoal = 0;
  const { yaw: _, ...flat } = S.transform;
  S.transform = { ...flat, squash: SQUASH };
}

function stepBehind(dt: number, here: Map<number, PersonView>): void {
  const mine = here.get(S.me);
  if (!mine) return;
  // The way I walk, smoothed over a third of a second, decides which of the four views the camera looks
  // along: it keeps the one it has until I walk back towards it. A figure standing still turns nothing.
  if (S.behindOn && S.lastMine) {
    const dx = mine.x - S.lastMine.x;
    const dy = mine.y - S.lastMine.y;
    const step = Math.hypot(dx, dy);
    if ((step / Math.max(1, dt)) * 1000 > WALKING_M_S) {
      const k = 1 - Math.exp(-dt / 330);
      const was = S.heading ?? { x: dx / step, y: dy / step };
      S.heading = { x: was.x + (dx / step - was.x) * k, y: was.y + (dy / step - was.y) * k };
      S.yawGoal = keepOrTurn(S.heading.x, S.heading.y, S.yawGoal);
    }
  }
  S.lastMine = { x: mine.x, y: mine.y };
  // The wheel aims a goal; from behind only its zoom is taken, because where the camera stands is mine.
  if (S.goal) {
    if (S.behindOn) S.behindScale = S.goal.scale;
    S.goal = null;
  }
  S.flung = null;

  const k = 1 - Math.exp(-dt / 400);
  S.descent += ((S.behindOn ? 1 : 0) - S.descent) * k;
  const yaw = turnToward(S.transform.yaw ?? 0, S.behindOn ? S.yawGoal : 0, dt);
  const scale = S.behindOn ? Math.exp(Math.log(S.transform.scale) + (Math.log(S.behindScale) - Math.log(S.transform.scale)) * k) : S.transform.scale;
  const squash = SQUASH + (BEHIND_SQUASH - SQUASH) * S.descent;
  const at = 0.5 + (BEHIND_AT - 0.5) * S.descent;
  const view = behind(mine.x, mine.y, yaw, scale, squash, stageSize(), at);
  // Back out and looking north again: the plan's own view takes over, without a yaw.
  if (!S.behindOn && S.descent < 0.01 && Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw))) < 0.004) {
    const { yaw: _, ...flat } = view;
    S.transform = hold({ ...flat, squash: SQUASH }, planSize(), stageSize(), WALL_HEIGHT_M * RISE);
    return;
  }
  S.transform = view;
}
