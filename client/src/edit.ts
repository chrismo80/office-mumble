/**
 * The editor's arithmetic, kept pure and apart from the canvas. The server holds the plan and validates every
 * edit; what lives here is what the client needs on its own to preview honestly — which cells a gesture
 * covers, where a stamp lands, how far an edge was dragged. The server's answer is still the one in force.
 */

import type { Facing } from './figure';
import type { Cell, CellChange, Floor, Object as Piece, Shift } from './wire';

/**
 * The editor's tools. No `walk`: walking is the office's act, and the office sends no edit — `router.ts` owns
 * that rule. `select` and `hand` build nothing, so the editor opens on a tool that cannot leave a mark.
 */
export type Tool = 'select' | 'hand' | 'room' | 'wall' | 'door' | 'window' | 'floor' | 'surface' | 'erase' | 'furniture' | 'label';

/** A cell, as `[row, col]`. */
export type At = [number, number];

// ── strokes over cells ───────────────────────────────────────────────────────────────────────────────

/**
 * Every cell a straight drag passes over, both ends included. A hand moves faster than pointer events arrive,
 * so a line drawn quickly would otherwise be dotted.
 */
export function cellsBetween(from: At, to: At): At[] {
  const [r0, c0] = from;
  const [r1, c1] = to;
  const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
  if (steps === 0) return [[r0, c0]];
  const walked: At[] = [];
  for (let step = 0; step <= steps; step++) {
    walked.push([Math.round(r0 + ((r1 - r0) * step) / steps), Math.round(c0 + ((c1 - c0) * step) / steps)]);
  }
  return walked;
}

/** The corners of the rectangle two cells span, top-left first, whichever way the drag went. */
export function spanOf(a: At, b: At): { top: number; left: number; bottom: number; right: number } {
  return { top: Math.min(a[0], b[0]), left: Math.min(a[1], b[1]), bottom: Math.max(a[0], b[0]), right: Math.max(a[1], b[1]) };
}

/** Every cell of the rectangle two cells span, row by row. */
export function rectCells(a: At, b: At): At[] {
  const { top, left, bottom, right } = spanOf(a, b);
  const cells: At[] = [];
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) cells.push([row, col]);
  return cells;
}

/**
 * A wall is drawn from where the drag began along whichever axis it went further, so a wobbling hand still
 * draws a straight wall.
 */
export function straightLine(from: At, to: At): At[] {
  const across = Math.abs(to[1] - from[1]) >= Math.abs(to[0] - from[0]);
  return cellsBetween(from, across ? [from[0], to[1]] : [to[0], from[1]]);
}

/**
 * What a cell tool writes for a drag, as one stroke: `wall` a straight line, `door` turns wall cells along one
 * (a door is a hole, not floor that says it is a door), `floor` and `erase` fill the rectangle, `room` walls
 * the rectangle and keeps a door already in its outline.
 */
export function strokeFor(tool: Tool, cells: Cell[][], from: At, to: At): CellChange[] {
  const change = ([row, col]: At, cell: Cell): CellChange => ({ row, col, cell });
  const onFloor = ([row, col]: At) => cells[row]?.[col] !== undefined;
  switch (tool) {
    case 'wall':
      return straightLine(from, to).filter(onFloor).map(at => change(at, 'wall'));
    case 'door':
      return straightLine(from, to)
        .filter(([row, col]) => cells[row]?.[col] === 'wall')
        .map(at => change(at, 'doorOpen'));
    case 'window':
      // A window is a gap cut into wall, so it only ever replaces wall — and a window that is already there,
      // so that a drag across an older one lengthens it instead of stopping at its edge. Erase takes it back
      // to wall; the window tool never makes a wall.
      return straightLine(from, to)
        .filter(([row, col]) => cells[row]?.[col] === 'wall' || cells[row]?.[col] === 'window')
        .map(at => change(at, 'window'));
    case 'floor':
      return rectCells(from, to).filter(onFloor).map(at => change(at, 'floor'));
    case 'erase':
      return rectCells(from, to).filter(onFloor).map(at => change(at, 'void'));
    case 'room': {
      const { top, left, bottom, right } = spanOf(from, to);
      return rectCells(from, to)
        .filter(onFloor)
        .flatMap(([row, col]): CellChange[] => {
          const edge = row === top || row === bottom || col === left || col === right;
          if (!edge) return [change([row, col], 'floor')];
          const now = cells[row][col];
          if (now === 'doorOpen' || now === 'doorShut') return [];
          return [change([row, col], 'wall')];
        });
    }
    default:
      return [];
  }
}

/** The cells a paint-type tool covers: a rectangle, like the floor. */
export function paintCells(cells: Cell[][], from: At, to: At): At[] {
  return rectCells(from, to).filter(([row, col]) => cells[row]?.[col] !== undefined);
}

/**
 * A grid with a stroke written into it, as a new grid: what is on screen is a preview of an unanswered message,
 * and the plan that replaces it is the whole floor, so nothing here is worth mutating.
 */
export function applyChanges(cells: Cell[][], changes: CellChange[]): Cell[][] {
  const next = cells.map(row => row.slice());
  for (const { row, col, cell } of changes) {
    if (next[row]?.[col] === undefined) continue;
    next[row][col] = cell;
  }
  return next;
}

/**
 * The items a stroke leaves standing: everything but those on a cell it made void — an erased cell is not a
 * cell any more, so nothing may stand on it. The server applies the same rule.
 */
export function survivingChanges<T extends { row: number; col: number }>(items: T[], changes: CellChange[]): T[] {
  const erased = new Set(changes.filter(change => change.cell === 'void').map(change => `${change.row},${change.col}`));
  if (erased.size === 0) return items;
  return items.filter(item => !erased.has(`${item.row},${item.col}`));
}

// ── furniture: stamps, selections, moves ─────────────────────────────────────────────────────────────

/** The four ways round, clockwise from north. */
export const FACINGS: Facing[] = ['north', 'east', 'south', 'west'];

/** A facing turned a quarter, clockwise or not. */
export function turned(facing: string, clockwise: boolean): Facing {
  const at = Math.max(0, FACINGS.indexOf(facing as Facing));
  return FACINGS[(at + (clockwise ? 1 : 3)) % 4];
}

/**
 * Pieces as a shape that can be put down anywhere. Offsets are from the group's top-left, so a stamp has no
 * place of its own until it is put.
 */
export type Stamp = Array<{ kind: string; dr: number; dc: number; facing: string }>;

/** The size of a stamp in cells, rows by columns. */
export function stampSize(stamp: Stamp): { rows: number; cols: number } {
  if (stamp.length === 0) return { rows: 0, cols: 0 };
  return { rows: Math.max(...stamp.map(p => p.dr)) + 1, cols: Math.max(...stamp.map(p => p.dc)) + 1 };
}

/** The stamp a group of pieces makes, measured from its own top-left. */
export function stampOf(pieces: Piece[]): Stamp {
  if (pieces.length === 0) return [];
  const top = Math.min(...pieces.map(p => p.row));
  const left = Math.min(...pieces.map(p => p.col));
  return pieces.map(p => ({ kind: p.kind, dr: p.row - top, dc: p.col - left, facing: p.facing }));
}

/**
 * A stamp turned a quarter: the group turns as a whole, positions and facings together, so a desk with its
 * chair stays a desk with its chair.
 */
export function turnStamp(stamp: Stamp, clockwise: boolean): Stamp {
  const { rows, cols } = stampSize(stamp);
  return stamp.map(p => ({
    kind: p.kind,
    dr: clockwise ? p.dc : cols - 1 - p.dc,
    dc: clockwise ? rows - 1 - p.dr : p.dr,
    facing: turned(p.facing, clockwise),
  }));
}

/** The pieces a stamp puts down with its middle on a cell — the cell under the pointer. */
export function stampAt(stamp: Stamp, row: number, col: number): Piece[] {
  const { rows, cols } = stampSize(stamp);
  const top = row - Math.floor((rows - 1) / 2);
  const left = col - Math.floor((cols - 1) / 2);
  return stamp.map(p => ({ kind: p.kind, row: top + p.dr, col: left + p.dc, facing: p.facing }));
}

const key = (row: number, col: number) => `${row},${col}`;

/**
 * Why pieces may not be put down here, or null. A cell something already stands on is refused although the
 * server would replace it: taking a piece away should not happen by putting another one down.
 */
export function placementProblem(floor: Floor, pieces: Piece[]): string | null {
  const standing = new Set(floor.objects.map(o => key(o.row, o.col)));
  const seen = new Set<string>();
  for (const piece of pieces) {
    const cell = floor.cells[piece.row]?.[piece.col];
    if (cell === undefined || cell === 'void') return 'outside the floor plan';
    const at = key(piece.row, piece.col);
    if (standing.has(at) || seen.has(at)) return 'dort steht schon etwas';
    seen.add(at);
  }
  return null;
}

/** The moves that carry a selection by a number of rows and columns. */
export function movesBy(pieces: Piece[], dr: number, dc: number): Shift[] {
  return pieces.map(p => ({ row: p.row, col: p.col, to_row: p.row + dr, to_col: p.col + dc, facing: p.facing }));
}

/**
 * The moves that turn a selection a quarter about its middle: a single piece turns on its cell, a group turns
 * as a whole and stays roughly where it was.
 */
export function turnMoves(pieces: Piece[], clockwise: boolean): Shift[] {
  if (pieces.length === 0) return [];
  const stamp = stampOf(pieces);
  const { rows, cols } = stampSize(stamp);
  const top = Math.min(...pieces.map(p => p.row)) + Math.floor((rows - cols) / 2);
  const left = Math.min(...pieces.map(p => p.col)) + Math.floor((cols - rows) / 2);
  const turnedStamp = turnStamp(stamp, clockwise);
  return pieces.map((p, i) => ({
    row: p.row,
    col: p.col,
    to_row: top + turnedStamp[i].dr,
    to_col: left + turnedStamp[i].dc,
    facing: turnedStamp[i].facing,
  }));
}

/**
 * Why a rearrangement may not happen, or null — the server's own rule, mirrored so a move can show red before
 * it is let go: every piece on the floor, no two on one cell, none on a piece that is not moving.
 */
export function arrangementProblem(floor: Floor, moves: Shift[]): string | null {
  const moving = new Set(moves.map(m => key(m.row, m.col)));
  const landing = new Set<string>();
  for (const move of moves) {
    const cell = floor.cells[move.to_row]?.[move.to_col];
    if (cell === undefined || cell === 'void') return 'outside the floor plan';
    const at = key(move.to_row, move.to_col);
    if (landing.has(at)) return 'two pieces on one cell';
    landing.add(at);
    const stays = !moving.has(at) && floor.objects.some(o => key(o.row, o.col) === at);
    if (stays) return 'dort steht schon etwas';
  }
  return null;
}

/** The pieces after a rearrangement, as the server will apply it: drawn now, until its plan arrives. */
export function arranged(pieces: Piece[], moves: Shift[]): Piece[] {
  const byCell = new Map(moves.map(m => [key(m.row, m.col), m]));
  return pieces.map(p => {
    const move = byCell.get(key(p.row, p.col));
    return move ? { ...p, row: move.to_row, col: move.to_col, facing: move.facing } : p;
  });
}

/** A piece's size on the floor in metres, as it faces: turned a quarter, its width and depth swap. */
export function footprintM(size: { w: number; d: number }, facing: string): { w: number; d: number } {
  const quarter = facing === 'east' || facing === 'west';
  return { w: (quarter ? size.d : size.w) / 100, d: (quarter ? size.w : size.d) / 100 };
}

/**
 * The piece under a point, or null. A piece is hit anywhere on its footprint, not only its anchor cell, and
 * where footprints overlap the one furthest forward wins — it is the one drawn on top.
 */
export function pieceAt(
  pieces: Piece[],
  sizeOf: (kind: string) => { w: number; d: number } | undefined,
  cellM: number,
  x: number,
  y: number,
): Piece | null {
  let best: Piece | null = null;
  let bestFront = -Infinity;
  for (const piece of pieces) {
    const size = sizeOf(piece.kind) ?? { w: cellM * 100, d: cellM * 100 };
    const { w, d } = footprintM(size, piece.facing);
    // At least the anchor cell, so a lamp's thin pole is still something to click.
    const halfW = Math.max(w, cellM) / 2;
    const halfD = Math.max(d, cellM) / 2;
    const cx = (piece.col + 0.5) * cellM;
    const cy = (piece.row + 0.5) * cellM;
    if (Math.abs(x - cx) > halfW || Math.abs(y - cy) > halfD) continue;
    const front = cy + halfD;
    if (front > bestFront) {
      best = piece;
      bestFront = front;
    }
  }
  return best;
}

/** The pieces anchored inside the rectangle two cells span — what a marquee catches. */
export function piecesIn(pieces: Piece[], a: At, b: At): Piece[] {
  const { top, left, bottom, right } = spanOf(a, b);
  return pieces.filter(p => p.row >= top && p.row <= bottom && p.col >= left && p.col <= right);
}

// ── the floor's own size ─────────────────────────────────────────────────────────────────────────────

export type Edge = 'top' | 'right' | 'bottom' | 'left';
export type Edges = { top: number; right: number; bottom: number; left: number };

/**
 * The resize a dragged edge asks for: cells moved outward as the server's four numbers. Inward is negative and
 * cuts; the floor never shrinks below one cell, because the server would refuse it.
 */
export function resizeFor(edge: Edge, outward: number, height: number, width: number): Edges {
  const across = edge === 'top' || edge === 'bottom' ? height : width;
  const cells = Math.max(outward, 1 - across);
  return {
    top: edge === 'top' ? cells : 0,
    right: edge === 'right' ? cells : 0,
    bottom: edge === 'bottom' ? cells : 0,
    left: edge === 'left' ? cells : 0,
  };
}

// ── doors and walking ────────────────────────────────────────────────────────────────────────────────

/** What a click on a door means: the door turned to its other state, or null where there is no door. */
export function toggledDoor(code: Cell | undefined): Cell | null {
  if (code === 'doorOpen') return 'doorShut';
  if (code === 'doorShut') return 'doorOpen';
  return null;
}

/** Floor and an open door are what may be walked; a wall, a shut door and void are not. */
export function walkable(cells: Cell[][], row: number, col: number): boolean {
  const code = cells[row]?.[col];
  return code === 'floor' || code === 'doorOpen';
}

/**
 * The nearest walkable cell to a point — the rule that carries somebody when a plan changes under them. The
 * same rule the server applies, ties broken by row then column, so both choose the same cell.
 */
export function nearestWalkable(cells: Cell[][], cellM: number, x: number, y: number): [number, number] | null {
  const height = cells.length;
  const width = cells[0]?.length ?? 0;
  if (height === 0 || width === 0) return null;

  const col = Math.min(width - 1, Math.max(0, Math.floor(x / cellM)));
  const row = Math.min(height - 1, Math.max(0, Math.floor(y / cellM)));
  if (walkable(cells, row, col)) return [row, col];

  let best: [number, number] | null = null;
  let bestDistance = Infinity;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!walkable(cells, r, c)) continue;
      const cx = (c + 0.5) * cellM;
      const cy = (r + 0.5) * cellM;
      const distance = (cx - x) ** 2 + (cy - y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [r, c];
      }
    }
  }
  return best;
}
