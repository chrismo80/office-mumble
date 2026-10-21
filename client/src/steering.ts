import { walkable } from './hearing';
import type { Grid } from './hearing';
import type { Stair } from './wire';

/** The arrow keys, as a direction to walk in. Held keys are a set of strings — the `KeyboardEvent.key` of each
 *  — and a diagonal is a real diagonal: two keys at once give a unit vector, not one that is 1.41 long. */

const KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Which way the held keys point, or `null` when they point nowhere — opposite keys cancel out, as they
 *  should, so holding left and right stands still instead of jittering. */
export function arrowStep(held: Iterable<string>): { dx: number; dy: number } | null {
  let dx = 0;
  let dy = 0;
  for (const key of held) {
    const [x, y] = KEYS[key] ?? [0, 0];
    dx += x;
    dy += y;
  }
  if (dx === 0 && dy === 0) return null;
  const length = Math.hypot(dx, dy);
  return { dx: dx / length, dy: dy / length };
}

/** A metre short of somebody, on the side I am already on — standing on a person means standing nowhere.
 *  Standing exactly on them has no side to come from, so it becomes a step from the north. */
export function aMetreShort(
  mine: { x: number; y: number },
  target: { x: number; y: number },
): { x: number; y: number } {
  const dx = mine.x - target.x;
  const dy = mine.y - target.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return { x: target.x, y: target.y - 1 };
  return { x: target.x + dx / length, y: target.y + dy / length };
}

/** How far up the flight a point is: zero at the foot, one at the tread you leave by. The ceiling stops being
 *  a wall as you climb, and this is the share of the floor above that comes through. */
export function stairClimb(stair: Stair, x: number, y: number, cellM: number): number {
  const alongCols = stair.exits === 'east' || stair.exits === 'west';
  const span = Math.max(1, (alongCols ? Math.max(1, stair.cols) : Math.max(1, stair.rows)) - 1);
  const at = alongCols ? Math.floor(x / cellM) - stair.col : Math.floor(y / cellM) - stair.row;
  const towardsEnd = stair.exits === 'east' || stair.exits === 'south';
  return Math.max(0, Math.min(1, (towardsEnd ? at : span - at) / span));
}

/** Where to stand to work a door: the cell on my side of it. A shut door is a wall of its own, and the nearest
 *  walkable cell to a wall may be on the far side — a walk that has no way there. */
export function doorSide(
  cells: Grid,
  cellM: number,
  from: { x: number; y: number },
  row: number,
  col: number,
): { row: number; col: number } {
  const across = from.x - (col + 0.5) * cellM;
  const along = from.y - (row + 0.5) * cellM;
  const side =
    Math.abs(across) >= Math.abs(along)
      ? { row, col: col + Math.sign(across) }
      : { row: row + Math.sign(along), col };
  const cell = cells[side.row]?.[side.col];
  // A wall beside the door is no place to stand either; then the door itself is the aim, and the server picks.
  return cell !== undefined && walkable(cells, side.col, side.row) ? side : { row, col };
}
