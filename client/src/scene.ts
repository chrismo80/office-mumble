/** What every drawing of the office needs: the canvas, the floor, where it is on the screen, and how big a
 *  cell is there. One value, handed to each part of the drawing, so none of them reaches for the client's
 *  state on its own. */

import { squashOf, type Transform } from './view';
import type { Floor } from './wire';

export type Scene = {
  ctx: CanvasRenderingContext2D;
  floor: Floor;
  /** Which floor of the building it is, counted from the ground up: a stair climbs from a lower floor and comes
   *  down into a higher one (`stair.ts`). */
  storey: number;
  cellM: number;
  transform: Transform;
  /** One cell's width on the screen, in pixels. */
  size: number;
  /** One cell's depth on the screen, in pixels: shorter than its width by the view's squash (`depth.ts`). */
  sizeY: number;
  /** From behind a figure: how near the viewer the figure stands (`nearness`). Walls nearer than that are
   *  cut down, so none of them stands between the camera and the figure. */
  cut?: number;
  /** From behind a figure: where its feet are on the screen, so what stands in front of it can give way. */
  mineAt?: [number, number];
};

/**
 * Draws what lies flat on the floor. A turned view is still a straight map of the floor — turned, then tilted —
 * so the floor is drawn as a plain plan in pixels and the canvas does the turning and the tilting. Without a
 * yaw the scene is handed on as it is.
 */
export function onTheFloor(scene: Scene, draw: (flat: Scene) => void): void {
  const t = scene.transform;
  if (t.yaw === undefined) {
    draw(scene);
    return;
  }
  const q = squashOf(t);
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  scene.ctx.save();
  // A plan pixel (X, Y) lands at (ox + c·X + s·Y, oy + q·(−s·X + c·Y)): `toScreen`, as a matrix.
  scene.ctx.transform(c, -q * s, s, q * c, t.ox, t.oy);
  draw({ ...scene, transform: { scale: t.scale, ox: 0, oy: 0 }, sizeY: scene.size });
  scene.ctx.restore();
}

/** The colour behind the office, and the outline every name on the map is drawn with. */
export const BACKGROUND = '#0f172a';

/**
 * Sets the shadow what is filled next casts, in the canvas's own pixels. A canvas keeps a shadow's blur and
 * offset in device pixels, untouched by its scale, so they are scaled here by the one scale the canvas has
 * outside a sprite's turn — the screen's density; on a high-density screen they would otherwise shrink.
 * Read off the matrix's first row, which a turned floor (`onTheFloor`) turns but does not stretch.
 */
export function castShadow(ctx: CanvasRenderingContext2D, colour: string, blur: number, dy: number, dx = 0): void {
  const m = ctx.getTransform();
  const dpr = Math.hypot(m.a, m.c);
  ctx.shadowColor = colour;
  ctx.shadowBlur = blur * dpr;
  ctx.shadowOffsetX = dx * dpr;
  ctx.shadowOffsetY = dy * dpr;
}

/** A name on the map: white, outlined in the background colour, so it reads over any floor. */
export function drawName(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): void {
  ctx.font = '600 12px "Inter", ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = BACKGROUND;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y);
}
