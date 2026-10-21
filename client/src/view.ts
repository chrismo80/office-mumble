/** Plan metres and screen pixels, and the one place that conversion happens. */

/**
 * Where the plan is on the screen. `scale` is pixels per metre across; `squash` is how much shorter a metre
 * of depth is drawn than a metre across — the cosine of the angle the room is looked down at (see
 * `depth.ts`), 1 straight down. Absent means 1, which is how a view without a tilt is written.
 *
 * `yaw` turns the view: the direction it looks in, in radians from north towards east. Absent, the view looks
 * north, as the plan is drawn; present, even at 0, the office is drawn by the turned path that stands every
 * wall as a box (`standing.ts`) — the view from behind a figure (`cameraControl.ts`).
 */
export type Transform = { scale: number; ox: number; oy: number; squash?: number; yaw?: number };

/** The squash of a view, 1 when it has none. */
export const squashOf = (t: Transform): number => t.squash ?? 1;

/** Screen metres of front per metre of height, for a view of this squash: both come from one angle. */
export const riseOf = (t: Transform): number => Math.sqrt(Math.max(0, 1 - squashOf(t) ** 2));

/**
 * A point of the plan in the view's own axes: across the screen, and down it — towards the viewer is larger.
 * Without a yaw these are the plan's own x and y. Linear, so it turns a direction as well as a point.
 */
export function toView(t: Transform, x: number, y: number): [number, number] {
  if (!t.yaw) return [x, y];
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  return [x * c + y * s, -x * s + y * c];
}

/** The way back from the view's axes to the plan's. */
export function fromView(t: Transform, u: number, v: number): [number, number] {
  if (!t.yaw) return [u, v];
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  return [u * c - v * s, u * s + v * c];
}

/** How near the viewer a point of the plan is: what orders everything that stands, back to front. */
export const nearness = (t: Transform, x: number, y: number): number => toView(t, x, y)[1];

/** How small and how large the zoom may get, as a multiple of one cell being 64 px. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/** Fits a floor into a canvas, with a margin, and keeps it centred. One metre is `scale` pixels. `above` is
 *  how far, in screen metres, what stands on the floor's north edge rises above it: a wall's height, seen. */
export function fit(
  planWidthM: number,
  planHeightM: number,
  viewWidth: number,
  viewHeight: number,
  margin = 24,
  squash = 1,
  above = 0,
): Transform {
  const usableW = Math.max(1, viewWidth - margin * 2);
  const usableH = Math.max(1, viewHeight - margin * 2);
  const tall = planHeightM * squash + above;
  const scale = Math.min(usableW / Math.max(planWidthM, 1e-6), usableH / Math.max(tall, 1e-6));
  return {
    scale,
    ox: (viewWidth - planWidthM * scale) / 2,
    oy: (viewHeight - tall * scale) / 2 + above * scale,
    ...(squash === 1 ? {} : { squash }),
  };
}

export function toScreen(t: Transform, x: number, y: number): [number, number] {
  const [u, v] = toView(t, x, y);
  return [t.ox + u * t.scale, t.oy + v * t.scale * squashOf(t)];
}

export function toPlan(t: Transform, sx: number, sy: number): [number, number] {
  return fromView(t, (sx - t.ox) / t.scale, (sy - t.oy) / (t.scale * squashOf(t)));
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * Zoom about a point on the screen, so the plan under the pointer stays under the pointer.
 *
 * Zoom is expressed as a multiple of `pxPerM`, which is how many pixels one metre is drawn at when one cell
 * is 64 px; that keeps "zoom 1" meaning the same thing whatever a cell's size is. The scale is clamped to a
 * sane range, and when the clamp bites the point still does not move — the plan only grows until it cannot.
 */
export function zoomAt(
  t: Transform,
  sx: number,
  sy: number,
  factor: number,
  pxPerM: number,
  min = MIN_ZOOM,
  max = MAX_ZOOM,
): Transform {
  const [px, py] = toView(t, ...toPlan(t, sx, sy));
  const zoom = clamp((t.scale / pxPerM) * factor, min, max);
  const scale = zoom * pxPerM;
  return { ...t, scale, ox: sx - px * scale, oy: sy - py * scale * squashOf(t) };
}

/**
 * Zoom about a point of the plan and keep that point in the middle of the stage. The wheel zooms about the
 * pointer, which is right when reading a corner; this is for the one point you are meant to be standing on,
 * so the room grows around you instead of sliding out from under you.
 */
export function zoomCentred(
  t: Transform,
  x: number,
  y: number,
  factor: number,
  stage: { w: number; h: number },
  pxPerM: number,
  min = MIN_ZOOM,
  max = MAX_ZOOM,
): Transform {
  const zoom = clamp((t.scale / pxPerM) * factor, min, max);
  const scale = zoom * pxPerM;
  const [u, v] = toView(t, x, y);
  return { ...t, scale, ox: stage.w / 2 - u * scale, oy: stage.h / 2 - v * scale * squashOf(t) };
}

/** The same view shifted by a screen delta: dragging the floor by (dx, dy). */
export function pan(t: Transform, dx: number, dy: number): Transform {
  return { ...t, ox: t.ox + dx, oy: t.oy + dy };
}

/** The current zoom as a multiple of one cell being 64 px, for a display that wants to say it. */
export function zoomOf(t: Transform, pxPerM: number): number {
  return t.scale / pxPerM;
}
