/** What is drawn over the floor to explain it: the audible area, and what a click on the cell under the
 *  pointer would do. Neither is the plan; both are drawn from it. */

import { DOOR_HANDLE } from './floorArt';
import { look } from './look';
import { onTheFloor, type Scene } from './scene';
import { toScreen } from './view';

/** The colour a stair's cell is marked in under the pointer, the same amber a door gets. */
const STAIR_HANDLE = '#f59e0b';

/**
 * The audible area: the cells I can be heard from, a translucent wash over the floor with its edge
 * outlined. Off by default, because it is a diagnostic and not the picture. It is drawn from the same
 * numbers the hearing rule uses — `audibleArea` is the rule's own flood-fill and earshot — so what it
 * draws is what the rule does, and a shut door puts the far side outside it as surely as it cuts a
 * connection.
 */
export function drawAudibleArea(scene: Scene, audibleCells: Set<number>): void {
  if (audibleCells.size === 0) return;
  const { ctx, floor, cellM, transform, size, sizeY } = scene;
  const width = floor.cells[0]?.length ?? 0;
  const heardFrom = (row: number, col: number): boolean =>
    row >= 0 && col >= 0 && row < floor.cells.length && col < width && audibleCells.has(row * width + col);

  ctx.save();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
  for (const key of audibleCells) {
    const [x, y] = toScreen(transform, (key % width) * cellM, Math.floor(key / width) * cellM);
    ctx.fillRect(x, y, size + 0.6, sizeY + 0.6);
  }
  // Only the boundary is stroked, so the edge of the area reads and its inside does not become a grid.
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.9)';
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  for (const key of audibleCells) {
    const col = key % width;
    const row = Math.floor(key / width);
    const [x, y] = toScreen(transform, col * cellM, row * cellM);
    if (!heardFrom(row - 1, col)) { ctx.moveTo(x, y); ctx.lineTo(x + size, y); }
    if (!heardFrom(row + 1, col)) { ctx.moveTo(x, y + sizeY); ctx.lineTo(x + size, y + sizeY); }
    if (!heardFrom(row, col - 1)) { ctx.moveTo(x, y); ctx.lineTo(x, y + sizeY); }
    if (!heardFrom(row, col + 1)) { ctx.moveTo(x + size, y); ctx.lineTo(x + size, y + sizeY); }
  }
  ctx.stroke();
  ctx.restore();
}

/** A small callout in a box, for the one hint the pointer asks for by resting on a door. */
function callout(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): void {
  ctx.font = '600 12px "Inter", ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
  ctx.fillRect(x - w / 2, y - 22, w, 18);
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2, y - 22, w, 18);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y - 9);
}

/**
 * The office's outline and hint for the cell under the pointer: where a click would walk to, and what working
 * a door under the pointer would do. The editor draws its own previews (`buildOverlay.ts`), which keeps the
 * office free of tool hints it has no tool for.
 */
export function drawHover(scene: Scene, hover: [number, number] | null, floorName: (index: number) => string): void {
  if (!hover) return;
  const { ctx, floor, cellM, transform } = scene;
  const [row, col] = hover;
  const code = floor.cells[row]?.[col];
  const isDoor = code === 'doorOpen' || code === 'doorShut';
  const stair = floor.stairs?.find(
    step => row >= step.row && row < step.row + Math.max(1, step.rows) && col >= step.col && col < step.col + Math.max(1, step.cols),
  );
  // The outline lies on the floor; the callout stands upright over it, whichever way the view is turned.
  onTheFloor(scene, ({ transform: flat, size, sizeY }) => {
    const [x, y] = toScreen(flat, col * cellM, row * cellM);
    ctx.strokeStyle = stair ? STAIR_HANDLE : isDoor ? DOOR_HANDLE : look.hover;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, size - 2, sizeY - 2);
  });
  const [x, y] = toScreen(transform, (col + 0.5) * cellM, row * cellM);
  // A stair says where it goes, because the floor name is the only thing about it the picture cannot show.
  if (stair) callout(ctx, x, y, `stairs: ${floorName(stair.to)} — walk to the end`);
  else if (isDoor) {
    callout(ctx, x, y, code === 'doorOpen' ? 'door: open — click to shut' : 'door: shut — click to open');
  }
}
