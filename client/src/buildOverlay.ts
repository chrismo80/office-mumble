/**
 * What Bauen draws over the floor: the stroke about to be sent, the piece about to be put down, the selection,
 * the marquee and the floor's edges. None of it is the plan; all of it says what a gesture would do.
 */

import { footprintM, spanOf, type At, type Edge, type Edges } from './edit';
import { PIECES } from './furniture';
import type { Scene } from './scene';
import { drawPieceOn } from './standing';
import { toScreen } from './view';
import type { Cell, CellChange, Object as Piece } from './wire';

export const ACCENT = '#6ea8fe';
const GOOD = 'rgba(74, 222, 128, 0.22)';
const BAD = 'rgba(248, 113, 113, 0.35)';
const BAD_LINE = '#f87171';

/** The wash a stroke previews each cell code with: what the cell is about to become, in one glance. */
const STROKE_INK: Record<Cell, string> = {
  wall: 'rgba(51, 65, 85, 0.85)',
  window: 'rgba(56, 189, 248, 0.4)',
  floor: 'rgba(250, 204, 21, 0.32)',
  void: 'rgba(244, 63, 94, 0.45)',
  doorOpen: 'rgba(251, 191, 36, 0.8)',
  doorShut: 'rgba(251, 191, 36, 0.8)',
};
export const PAINT_INK = 'rgba(163, 230, 53, 0.38)';

/** A rectangle of the plan in metres, on the screen. */
function screenRect(scene: Scene, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const [x0, y0] = toScreen(scene.transform, x, y);
  const [x1, y1] = toScreen(scene.transform, x + w, y + h);
  return [x0, y0, x1 - x0, y1 - y0];
}

function cellRect(scene: Scene, [row, col]: At): [number, number, number, number] {
  return screenRect(scene, col * scene.cellM, row * scene.cellM, scene.cellM, scene.cellM);
}

/** Cells washed with one colour. */
export function tintCells(scene: Scene, cells: At[], fill: string): void {
  scene.ctx.fillStyle = fill;
  for (const at of cells) scene.ctx.fillRect(...cellRect(scene, at));
}

/** A stroke's preview: every cell washed with what it is about to become. */
export function drawStroke(scene: Scene, changes: CellChange[]): void {
  for (const change of changes) tintCells(scene, [[change.row, change.col]], STROKE_INK[change.cell]);
}

/** The cell under the pointer, outlined. */
export function outlineCell(scene: Scene, at: At, colour: string): void {
  const [x, y, w, h] = cellRect(scene, at);
  scene.ctx.strokeStyle = colour;
  scene.ctx.lineWidth = 2;
  scene.ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** Where a piece covers the floor, on screen: its footprint as it faces, centred on its cell. */
function footprintRect(scene: Scene, piece: Piece): [number, number, number, number] {
  const size = PIECES[piece.kind] ?? { w: scene.cellM * 100, d: scene.cellM * 100 };
  const { w, d } = footprintM(size, piece.facing);
  const [fw, fd] = [Math.max(w, scene.cellM * 0.8), Math.max(d, scene.cellM * 0.8)];
  const cx = (piece.col + 0.5) * scene.cellM;
  const cy = (piece.row + 0.5) * scene.cellM;
  return screenRect(scene, cx - fw / 2, cy - fd / 2, fw, fd);
}

/** A piece's footprint outlined — the hover, or the selection with its corner marks. */
export function outlinePiece(scene: Scene, piece: Piece, selected: boolean): void {
  const { ctx } = scene;
  const [x, y, w, h] = footprintRect(scene, piece);
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = selected ? 2 : 1;
  if (!selected) ctx.setLineDash([4, 3]);
  ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  if (selected) {
    ctx.fillStyle = '#ffffff';
    for (const [cx, cy] of [[x - 2, y - 2], [x + w + 2, y - 2], [x - 2, y + h + 2], [x + w + 2, y + h + 2]]) {
      ctx.fillRect(cx - 3, cy - 3, 6, 6);
      ctx.strokeRect(cx - 3, cy - 3, 6, 6);
    }
  }
  ctx.restore();
}

/**
 * Pieces not yet where they are drawn: washed green where they fit and red where they do not, the pieces
 * see-through on top, so the eye reads what goes there and whether it may.
 */
export function drawGhosts(scene: Scene, pieces: Piece[], fits: boolean): void {
  const { ctx } = scene;
  for (const piece of pieces) {
    const [x, y, w, h] = footprintRect(scene, piece);
    ctx.fillStyle = fits ? GOOD : BAD;
    ctx.fillRect(x, y, w, h);
    if (!fits) {
      ctx.strokeStyle = BAD_LINE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
    }
  }
  const backToFront = [...pieces].sort((a, b) => a.row - b.row);
  for (const piece of backToFront) drawPieceOn(scene, piece.kind, piece.facing, piece.row, piece.col, fits ? 0.75 : 0.45);
}

/** The marquee: the rectangle a drag over empty floor is catching pieces in. */
export function drawMarquee(scene: Scene, a: At, b: At): void {
  const { top, left, bottom, right } = spanOf(a, b);
  const [x, y, w, h] = screenRect(scene, left * scene.cellM, top * scene.cellM, (right - left + 1) * scene.cellM, (bottom - top + 1) * scene.cellM);
  const { ctx } = scene;
  ctx.save();
  ctx.fillStyle = 'rgba(110, 168, 254, 0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}

/** A room name about to be written, at the cell it would be anchored to. */
export function drawLabelGhost(scene: Scene, at: At, text: string): void {
  const [x, y, w, h] = cellRect(scene, at);
  const { ctx } = scene;
  outlineCell(scene, at, '#e879f9');
  if (!text) return;
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.font = '600 13px "Inter", ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5d0fe';
  ctx.fillText(text, x + w / 2, y + h / 2 - 8);
  ctx.restore();
}

// ── the floor's edges ────────────────────────────────────────────────────────────────────────────────

/** How close to an edge, in screen pixels, the pointer has to be to take hold of it. */
const GRIP_PX = 7;

/** The floor's outline on screen. */
function floorRect(scene: Scene): [number, number, number, number] {
  const rows = scene.floor.cells.length;
  const cols = scene.floor.cells[0]?.length ?? 0;
  return screenRect(scene, 0, 0, cols * scene.cellM, rows * scene.cellM);
}

/** The edge of the floor a screen point takes hold of, or null. */
export function edgeAt(scene: Scene, sx: number, sy: number): Edge | null {
  const [x, y, w, h] = floorRect(scene);
  const alongX = sx > x && sx < x + w;
  const alongY = sy > y && sy < y + h;
  if (alongX && Math.abs(sy - y) < GRIP_PX) return 'top';
  if (alongX && Math.abs(sy - (y + h)) < GRIP_PX) return 'bottom';
  if (alongY && Math.abs(sx - x) < GRIP_PX) return 'left';
  if (alongY && Math.abs(sx - (x + w)) < GRIP_PX) return 'right';
  return null;
}

/**
 * The floor's outline and a handle per edge: the affordance that says the size can be taken hold of. The edge
 * under the pointer, or being dragged, is lit.
 */
export function drawEdges(scene: Scene, hot: Edge | null): void {
  const { ctx } = scene;
  const [x, y, w, h] = floorRect(scene);
  ctx.save();
  ctx.strokeStyle = 'rgba(110, 168, 254, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  ctx.setLineDash([]);
  const handles: Array<[Edge, number, number, number, number]> = [
    ['top', x + w / 2 - 18, y - 4, 36, 8],
    ['bottom', x + w / 2 - 18, y + h - 4, 36, 8],
    ['left', x - 4, y + h / 2 - 18, 8, 36],
    ['right', x + w - 4, y + h / 2 - 18, 8, 36],
  ];
  for (const [edge, hx, hy, hw, hh] of handles) {
    ctx.fillStyle = edge === hot ? ACCENT : '#cbd5e1';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(hx, hy, hw, hh, 4);
    ctx.fill();
    ctx.stroke();
  }
  if (hot) {
    const line: Record<Edge, [number, number, number, number]> = {
      top: [x, y, x + w, y],
      bottom: [x, y + h, x + w, y + h],
      left: [x, y, x, y + h],
      right: [x + w, y, x + w, y + h],
    };
    const [x0, y0, x1, y1] = line[hot];
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Metres the way a person writes them here: one decimal, with a comma. */
export function metres(value: number): string {
  return value.toFixed(1).replace('.', ',');
}

/** The floor as an edge drag would leave it: the new outline, and its size in words beside it. */
export function drawResize(scene: Scene, edges: Edges): void {
  const rows = scene.floor.cells.length + edges.top + edges.bottom;
  const cols = (scene.floor.cells[0]?.length ?? 0) + edges.left + edges.right;
  const { cellM, ctx } = scene;
  const [x, y, w, h] = screenRect(scene, -edges.left * cellM, -edges.top * cellM, cols * cellM, rows * cellM);
  ctx.save();
  ctx.fillStyle = 'rgba(110, 168, 254, 0.08)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  const text = `${metres(cols * cellM)} × ${metres(rows * cellM)} m`;
  ctx.font = '600 12px "Inter", ui-sans-serif, system-ui, sans-serif';
  const tw = ctx.measureText(text).width + 14;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fillRect(x + w / 2 - tw / 2, y + h / 2 - 11, tw, 22);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2);
  ctx.restore();
}
