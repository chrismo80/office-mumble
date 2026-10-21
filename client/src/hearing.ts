/**
 * Who hears whom: the one piece of logic the whole project hangs off, so it is pure, symmetric and tested
 * without a user interface. Walls and shut doors cut, distance decides the level, and past `EARSHOT_M` there
 * is no stream at all. Every client computes this itself; the Rust copy in `crates/hearing` answers the same
 * cases in `fixtures/hearing-cases.json`.
 */

export type Person = { id: number; x: number; y: number };

/** How loud, and how far the sound had to travel: the way round a corner is longer than the straight line,
 *  and a voice around it is quieter because of the way, not because of where it stands. */
export type Audible = { id: number; level: number; distance: number };

export type Grid = string[][];

/** Within this distance the words are clear. */
export const CLEAR_M = 2;

/**
 * Past this distance there is no stream at all. Not settled: it decides how many voices a floor holds, so
 * listening on a real floor settles it. Was 12 m, which put everybody in earshot on a 20 m floor.
 */
export const EARSHOT_M = 8;

/**
 * Inverse distance, scaled to reach exactly zero at `EARSHOT_M`: twice as far is half as loud, and it still
 * fades instead of ending at a step.
 */
export function levelAt(distanceM: number): number {
  if (distanceM <= CLEAR_M) return 1;
  if (distanceM >= EARSHOT_M) return 0;
  const murmurAtTheEdge = CLEAR_M / EARSHOT_M;
  return (CLEAR_M / distanceM - murmurAtTheEdge) / (1 - murmurAtTheEdge);
}

/** Which cell a position is in. A cell is centred half a cell past its corner. */
function cellOf(value: number, cellM: number): number {
  return Math.floor(value / cellM);
}

/**
 * Every cell reachable without crossing a wall or a shut door — my area, the one hard rule. An open door is
 * not a cut, and neither is distance.
 */
function area(cells: Grid, col: number, row: number): Map<number, number> {
  const width = cells[0]?.length ?? 0;
  // Cell index to the number of steps it takes to get there: the way there, not the straight line.
  const reachable = new Map<number, number>();
  if (!walkable(cells, col, row)) return reachable;

  const queue: Array<[number, number]> = [[col, row]];
  reachable.set(row * width + col, 0);
  for (let head = 0; head < queue.length; head++) {
    const [c, r] = queue[head];
    const steps = reachable.get(r * width + c) ?? 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextCol = c + dc;
      const nextRow = r + dr;
      if (!walkable(cells, nextCol, nextRow)) continue;
      const key = nextRow * width + nextCol;
      if (reachable.has(key)) continue;
      reachable.set(key, steps + 1);
      queue.push([nextCol, nextRow]);
    }
  }
  return reachable;
}

/** Floor and open door; a wall or a shut door cuts one area from the next. */
export function walkable(cells: Grid, col: number, row: number): boolean {
  if (row < 0 || row >= cells.length) return false;
  const cell = cells[row][col];
  return cell === 'floor' || cell === 'doorOpen';
}

/**
 * Whether a straight line between two places crosses nothing solid: sound with a clear path takes it, and only
 * what has to go round a corner takes the longer way. Walking the cells of the line, not a ray — a wall is a
 * wall, and a shut door counts as one.
 */
function clearPath(cells: Grid, cellM: number, from: Person, to: Person): boolean {
  let col = cellOf(from.x, cellM);
  let row = cellOf(from.y, cellM);
  const endCol = cellOf(to.x, cellM);
  const endRow = cellOf(to.y, cellM);
  const spanCol = Math.abs(endCol - col);
  const spanRow = Math.abs(endRow - row);
  const stepCol = col < endCol ? 1 : -1;
  const stepRow = row < endRow ? 1 : -1;
  let error = spanCol - spanRow;
  for (;;) {
    if (!walkable(cells, col, row)) return false;
    if (col === endCol && row === endRow) return true;
    const doubled = 2 * error;
    if (doubled > -spanRow) {
      error -= spanRow;
      col += stepCol;
    }
    if (doubled < spanCol) {
      error += spanCol;
      row += stepRow;
    }
  }
}

/**
 * Everybody in my area with how loud they are, including level zero: "in my area, out of earshot" and "not in
 * my area" are different — walking away keeps a connection, a shut door cuts it — so the rule says which.
 */
export function within(
  cells: Grid,
  cellM: number,
  me: Person,
  everybody: Person[],
  reach: Map<number, number> = areaOf(cells, cellM, me),
): Audible[] {
  if (cells.length === 0) return [];
  const width = cells[0].length;
  const inReach = reach;

  const nearby: Audible[] = [];
  for (const other of everybody) {
    if (other.id === me.id) continue;
    if (!inside(cells, width, other, cellM)) continue;
    const key = cellOf(other.y, cellM) * width + cellOf(other.x, cellM);
    const steps = inReach.get(key);
    if (steps === undefined) continue; // a wall or a shut door between us, whatever the distance says
    // The distance sound travels: the straight line where it is clear, the way round where a wall stands in
    // it. A voice at arm's length across a wall is not in the area at all.
    const distance = clearPath(cells, cellM, me, other) ? Math.hypot(other.x - me.x, other.y - me.y) : steps * cellM;
    nearby.push({ id: other.id, level: levelAt(distance), distance });
  }
  return nearby.sort((a, b) => b.level - a.level || a.id - b.id);
}

/** Everybody in my area and loud enough to be a stream: the answer to "who do I connect to". */
/** My area: every cell reachable without a wall or a shut door. One fill, asked once per state message and
 *  handed to everything that needs it — the rule, the overlay and the room's own size. */
export function areaOf(cells: Grid, cellM: number, me: Person): Map<number, number> {
  if (cells.length === 0) return new Map();
  return area(cells, cellOf(me.x, cellM), cellOf(me.y, cellM));
}

export function audible(cells: Grid, cellM: number, me: Person, everybody: Person[]): Audible[] {
  return within(cells, cellM, me, everybody).filter(entry => entry.level > 0);
}

/**
 * Every cell I can be heard from: my area, within earshot. The same flood-fill and the same `EARSHOT_M` as the
 * rule — a second model beside it would be a second truth about the same floor.
 */
export function audibleArea(
  cells: Grid,
  cellM: number,
  me: Person,
  reach: Map<number, number> = areaOf(cells, cellM, me),
): Set<number> {
  const heardFrom = new Set<number>();
  if (cells.length === 0) return heardFrom;
  const width = cells[0].length;
  const inReach = reach;
  for (let row = 0; row < cells.length; row++) {
    for (let col = 0; col < cells[row].length; col++) {
      const key = row * width + col;
      if (!inReach.has(key)) continue;
      const cx = (col + 0.5) * cellM;
      const cy = (row + 0.5) * cellM;
      if (levelAt(Math.hypot(cx - me.x, cy - me.y)) > 0) heardFrom.add(key);
    }
  }
  return heardFrom;
}

function inside(cells: Grid, width: number, person: Person, cellM: number): boolean {
  const col = cellOf(person.x, cellM);
  const row = cellOf(person.y, cellM);
  return col >= 0 && col < width && row >= 0 && row < cells.length;
}
