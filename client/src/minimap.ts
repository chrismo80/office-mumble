/**
 * The whole office, small, in the corner of the office.
 *
 * A floor plan you can zoom into loses its own shape: at the zoom a room is read at, you cannot see the
 * building. The map answers where you are, where the others are, and what part of the floor is in the
 * window — and it takes a click, because a map you cannot travel with is a picture.
 *
 * It is drawn from the same plan and the same transform as the room, never from a second copy of either.
 */

import type { PersonView, Floor } from './wire';
import { toPlan, type Transform } from './view';

/** How wide the map is on screen, in pixels; its height follows the plan's own shape. */
const WIDTH = 132;
const PADDING = 8;

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  /** Where the plan sits inside the map, so a click can be turned back into a place. */
  private inside = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * Draw the map: the floor as blocks, the walls as the lines between them, everybody as a dot, and the
   * window as a rectangle. Nothing here changes what the office thinks; it is a view of a view.
   */
  draw(
    floor: Floor,
    cellM: number,
    people: PersonView[],
    me: number,
    transform: Transform,
    stageW: number,
    stageH: number,
  ): void {
    const { ctx, canvas } = this;
    const rows = floor.cells.length;
    const cols = floor.cells[0]?.length ?? 0;
    if (rows === 0 || cols === 0) return;
    const planW = cols * cellM;
    const planH = rows * cellM;

    // The box is as tall as the plan is: a square map for a long building would be mostly empty.
    const height = Math.round(WIDTH * Math.min(1.6, Math.max(0.42, planH / planW)));
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    if (canvas.width !== Math.round(WIDTH * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(WIDTH * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${WIDTH}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, height);

    const scale = Math.min((WIDTH - PADDING * 2) / planW, (height - PADDING * 2) / planH);
    const ox = (WIDTH - planW * scale) / 2;
    const oy = (height - planH * scale) / 2;
    this.inside = { scale, ox, oy, w: WIDTH, h: height };
    const at = (x: number, y: number): [number, number] => [ox + x * scale, oy + y * scale];

    // The table under the map, so it reads as a thing on the shell and not as a hole in it.
    ctx.fillStyle = 'rgba(233, 237, 243, 0.95)';
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, WIDTH - 1, height - 1, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // The floor, one block per walkable cell: at this size a room is a field and a wall is the gap round it.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const code = floor.cells[row][col];
        if (code === 'void') continue;
        if (code === 'wall' || code === 'doorShut') continue;
        const [x, y] = at(col * cellM, row * cellM);
        ctx.rect(x, y, cellM * scale + 0.4, cellM * scale + 0.4);
      }
    }
    ctx.fill();

    // The walls, a shade brighter than the floor: the lines a plan is read by.
    ctx.fillStyle = 'rgba(51, 65, 85, 0.55)';
    ctx.beginPath();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const code = floor.cells[row][col];
        if (code !== 'wall' && code !== 'doorShut') continue;
        const [x, y] = at(col * cellM, row * cellM);
        ctx.rect(x, y, cellM * scale + 0.4, cellM * scale + 0.4);
      }
    }
    ctx.fill();

    // What the window is showing, so the map says where the room on screen is: its four corners on the
    // plan, which make a turned frame when the view is turned.
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [sx, sy] of [[0, 0], [stageW, 0], [stageW, stageH], [0, stageH]]) ctx.lineTo(...at(...toPlan(transform, sx, sy)));
    ctx.closePath();
    ctx.stroke();

    // Everybody, me included — mine larger and in the accent, so the map answers "where am I" first.
    for (const person of people) {
      const [x, y] = at(person.x, person.y);
      const mine = person.id === me;
      ctx.fillStyle = mine ? '#2563eb' : 'rgba(51, 65, 85, 0.85)';
      ctx.beginPath();
      ctx.arc(x, y, mine ? 3 : 2.2, 0, Math.PI * 2);
      ctx.fill();
      if (mine) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  /** Where on the plan a click on the map landed — or null if the map is not drawn yet. */
  placeAt(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const { scale, ox, oy } = this.inside;
    if (scale <= 1) return null;
    return [(clientX - rect.left - ox) / scale, (clientY - rect.top - oy) / scale];
  }
}
