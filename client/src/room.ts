import type { Floor } from './wire';

/** How much a surface eats, near enough at 500 Hz: textile swallows, stone bounces. */
const EATS: Record<string, number> = { carpet: 0.55, parquet: 0.1, tile: 0.05, concrete: 0.05 };

/** Furniture is absorption too, and it is what makes an office dry rather than bare. */
const SOFT = /sofa|loungeChair|chair|bench|pottedPlant|bookcase/i;

/** The floor as a room: how much it absorbs, and how many square metres it has. The rest — the tail, the
 *  dulling — follows from these two, the way it does for a real room. */
export type Room = { area: number; absorption: number };

/** What a plan says about its own acoustics: the surface underfoot, the rugs painted over it, and the soft
 *  things standing about. With a reach, only the part of the floor that reach covers — a room behind a shut
 *  door is not the whole floor, and a small room is not a big one. No height, so three metres are assumed. */
export function roomOf(floor: Floor, reach?: Map<number, number>): Room {
  const width = floor.cells[0]?.length ?? 0;
  const inside = (row: number, col: number) => !reach || reach.has(row * width + col);
  const paintedAt = new Map<number, string>();
  for (const painted of floor.painted) paintedAt.set(painted.row * width + painted.col, painted.surface);

  const counts = new Map<string, number>();
  let cells = 0;
  for (let row = 0; row < floor.cells.length; row++) {
    for (let col = 0; col < floor.cells[row].length; col++) {
      const cell = floor.cells[row][col];
      if (cell !== 'floor' && cell !== 'doorOpen' && cell !== 'doorShut') continue;
      if (!inside(row, col)) continue;
      const surface = paintedAt.get(row * width + col) ?? floor.surface;
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
      cells += 1;
    }
  }
  let weighted = 0;
  for (const [surface, count] of counts) weighted += (EATS[surface] ?? 0.1) * count;
  const bare = cells === 0 ? 0.1 : weighted / cells;

  // Each soft piece counts as a square metre of absorber, not as a bare floor cell: that is roughly what a
  // sofa or a full shelf does to a room.
  const soft = floor.objects.filter(object => SOFT.test(object.kind) && inside(object.row, object.col)).length;
  const area = cells * 0.25;
  const absorption = Math.min(0.8, bare + (soft / Math.max(1, area)) * 0.6);
  return { area, absorption };
}
