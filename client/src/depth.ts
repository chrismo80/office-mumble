import { nearness, riseOf, toPlan, toScreen, type Transform } from './view';

/**
 * Height: how tall what stands on the floor is, and how that height is drawn.
 *
 * The room is looked down at from the south, `ANGLE_DEG` from straight down: a metre of depth
 * is drawn shorter than a metre across by the cosine of that angle, and a height shows as a front by its sine.
 * Both come from the one angle, which is what keeps the floor and the fronts on it looking at the same room —
 * a plan drawn straight down with fronts hanging off it looks at two rooms at once. Everything that stands —
 * walls, doors, furniture — stands on its footprint and rises up the screen from it, by one rule, so a counter
 * against a wall stands in front of the wall and not inside it. People stand upright on their feet, never
 * squashed.
 *
 * The price is the floor behind a wall: a wall covers a strip of it as deep as its height looks, and whoever
 * stands there. So people are drawn a second time, faintly, over everything (`people.ts`), and a click on a
 * wall's face or a door's leaf means that wall or that door, not the floor hidden behind it (`frontCell`).
 *
 * What makes it read as depth is the order: everything that stands is drawn from the back of the room to the
 * front, by the southern edge of its footprint — see `standing.ts`.
 */

/** How far from straight down the room is looked at, in degrees: 0 is a plan, 90 would be standing in it.
 *  Steep enough that furniture shows its legs and its profile — the room reads as a model of itself, not as
 *  a plan with symbols on it. `?winkel=` on the page tries another. */
export const ANGLE_DEG = (() => {
  const raw = new URLSearchParams(globalThis.location?.search ?? '').get('winkel');
  const asked = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(asked) && asked >= 0 && asked <= 70 ? asked : 40;
})();

/** How much shorter a metre of depth is drawn than a metre across. */
export const SQUASH = Math.cos((ANGLE_DEG * Math.PI) / 180);

/** Screen metres of front per metre of height. */
export const RISE = Math.sin((ANGLE_DEG * Math.PI) / 180);

/** How tall a wall is drawn. Lower than a real wall on purpose: a front this tall already says "wall", and a
 *  taller one would cover more of the floor in front of it that people stand on. */
export const WALL_HEIGHT_M = 1.3;

/** What stands as high as a wall: a wall, a window, a shut door. An open door lies on the floor. */
export const RISES = new Set(['wall', 'window', 'doorShut']);

/**
 * The cell a point of the floor plan shows, read as `standing.ts` draws: the frontmost wall, window or shut
 * door whose top or front covers the point, or else the cell the point lies in. So a click on a wall's face is
 * a click on that wall, not on the floor hidden behind it; a click on a shut door's leaf is a click on the door
 * wherever on the leaf it lands; and the face over an open door — all a wall running away from the eye shows
 * of a doorway — is the door's.
 */
export function frontCell(cells: string[][], cellM: number, x: number, y: number, squash = SQUASH): [number, number] {
  const row = Math.floor(y / cellM);
  const col = Math.floor(x / cellM);
  // How far a wall's top lies up the plan from its footprint, in plan metres.
  const reach = (WALL_HEIGHT_M * RISE) / squash;
  // Frontmost first: whatever stands further south is drawn later, over what stands behind it.
  for (let r = Math.floor((y + reach) / cellM); r >= row; r--) {
    const code = cells[r]?.[col] ?? '';
    if (!RISES.has(code)) continue;
    const top = r * cellM - reach;
    // Its top always; its front down to the floor where the cell to its south is not wall, or for a door.
    const bottom = code === 'doorShut' || cells[r + 1]?.[col] !== 'wall' ? (r + 1) * cellM : top + cellM;
    if (y < top || y >= bottom) continue;
    return cells[r + 1]?.[col] === 'doorOpen' ? [r + 1, col] : [r, col];
  }
  return [row, col];
}

/** Pixels a height takes on screen, for a view drawing one metre `scale` pixels wide. */
export function risePx(metres: number, scale: number): number {
  return metres * RISE * scale;
}

// ── a turned view ────────────────────────────────────────────────────────────────────────────────────

/** How high a wall between the camera and the figure is drawn from behind (`Scene.cut`): a skirting, so the
 *  room keeps its edge and nobody stands hidden behind it. */
export const CUT_M = 0.18;

/** The footprint of what rises from a cell, in plan metres `[x0, y0, x1, y1]`: the whole cell, or for a shut
 *  door a leaf a quarter of a cell thick — across the opening or along it, as the plan's own view draws it. */
export function footprint(cells: string[][], cellM: number, row: number, col: number): [number, number, number, number] {
  const x0 = col * cellM;
  const y0 = row * cellM;
  if (cells[row]?.[col] !== 'doorShut') return [x0, y0, x0 + cellM, y0 + cellM];
  const half = cellM * 0.13;
  return cells[row]?.[col - 1] === 'wall' && cells[row]?.[col + 1] === 'wall'
    ? [x0, y0 + cellM / 2 - half, x0 + cellM, y0 + cellM / 2 + half]
    : [x0 + cellM / 2 - half, y0, x0 + cellM / 2 + half, y0 + cellM];
}

/** How high a cell rises in a turned view: a wall's height, a skirting where it is nearer the camera than
 *  `cut`, nothing for open floor. */
export function heightIn(cells: string[][], cellM: number, t: Transform, row: number, col: number, cut?: number): number {
  if (!RISES.has(cells[row]?.[col] ?? '')) return 0;
  const nearer = cut !== undefined && nearness(t, (col + 0.5) * cellM, (row + 0.5) * cellM) > cut + cellM * 0.5;
  return nearer ? CUT_M : WALL_HEIGHT_M;
}

/** Whether a point lies inside a convex four-cornered shape, whichever way round its corners run. */
export function insideQuad(px: number, py: number, quad: Array<[number, number]>): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/**
 * The cell a point of the screen shows in a turned view: the frontmost wall, window or shut door whose box
 * covers it, or else the floor cell under it — `frontCell` for a view that is not looking north. A box's
 * picture is the union of its top and its four sides, so a point is on it when it is on one of those.
 */
export function frontCellTurned(cells: string[][], cellM: number, t: Transform, sx: number, sy: number, cut?: number): [number, number] {
  const lift = riseOf(t) * t.scale;
  const at = (x: number, y: number, z: number): [number, number] => {
    const [ax, ay] = toScreen(t, x, y);
    return [ax, ay - z * lift];
  };
  let best: [number, number] | null = null;
  let bestNear = -Infinity;
  for (let row = 0; row < cells.length; row++) {
    for (let col = 0; col < cells[row].length; col++) {
      if (!RISES.has(cells[row][col])) continue;
      // Frontmost wins: what is nearer the viewer is drawn over what is behind it.
      const near = nearness(t, (col + 0.5) * cellM, (row + 0.5) * cellM);
      if (near <= bestNear) continue;
      const h = heightIn(cells, cellM, t, row, col, cut);
      const [x0, y0, x1, y1] = footprint(cells, cellM, row, col);
      const corners: Array<[number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const top = corners.map(([x, y]) => at(x, y, h));
      const sides = corners.map(([x, y], i) => {
        const [nx, ny] = corners[(i + 1) % 4];
        return [at(x, y, 0), at(nx, ny, 0), at(nx, ny, h), at(x, y, h)];
      });
      if (![top, ...sides].some(quad => insideQuad(sx, sy, quad))) continue;
      best = [row, col];
      bestNear = near;
    }
  }
  if (best) return best;
  const [x, y] = toPlan(t, sx, sy);
  return [Math.floor(y / cellM), Math.floor(x / cellM)];
}
