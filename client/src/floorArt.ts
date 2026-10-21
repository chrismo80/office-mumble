/**
 * The floor, drawn: surfaces, walls, doors, furniture, room names. Who is on it and what the pointer does are
 * drawn on top, in `people.ts` and `overlay.ts`; the look is `look.ts`. Cells of one kind are gathered into one
 * path and filled once, so a wall is one mass and a room one surface — not a grid of tiles each with its edge.
 */

import { look, type Pattern } from './look';
import { castShadow, type Scene } from './scene';
import { toScreen } from './view';
import type { Cell } from './wire';

/** The colour a door's working is marked in wherever the pointer asks about one. */
export const DOOR_HANDLE = '#f59e0b';

/** Cells whose surface is not the floor's own, keyed by `row * 1000 + col` so a lookup is one step. */
export type PaintedCells = Map<number, string>;

/** Below this many pixels to a cell, a pattern is noise rather than texture, and the surface is flat. */
const PATTERN_FROM_PX = 12;

/** The surface a cell is drawn with: the floor's own, unless it was painted over. */
function surfaceAt(scene: Scene, painted: PaintedCells, row: number, col: number): string {
  return painted.get(row * 1000 + col) ?? scene.floor.surface ?? 'parquet';
}

const standsOn = (code: Cell | undefined): boolean => code === 'floor' || code === 'doorOpen' || code === 'doorShut';

/** The cells a test picks, as one path on the screen. Adjacent cells of one path fill without a seam. */
function cellsPath(scene: Scene, pick: (code: Cell, row: number, col: number) => boolean): Path2D {
  const { floor, cellM, transform, size, sizeY } = scene;
  const path = new Path2D();
  floor.cells.forEach((cells, row) => {
    cells.forEach((code, col) => {
      if (!pick(code, row, col)) return;
      const [x, y] = toScreen(transform, col * cellM, row * cellM);
      path.rect(x, y, size, sizeY);
    });
  });
  return path;
}

// ── surfaces ─────────────────────────────────────────────────────────────────────────────────────────

/** Pixels per cell a pattern tile is drawn at; the tile is two cells square and scaled to the view. */
const TILE_PX = 64;
const tiles = new Map<string, HTMLCanvasElement>();

/** A stable fraction for a number, so a pattern's scatter is the same on every page load. */
const hash = (n: number): number => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

/** The ink of one pattern on a transparent tile two cells square, made once per pattern and colour. */
function tile(pattern: Pattern, ink: string): HTMLCanvasElement {
  const key = `${pattern}|${ink}`;
  const have = tiles.get(key);
  if (have) return have;
  const R = TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = R * 2;
  const g = canvas.getContext('2d')!;
  g.fillStyle = ink;
  g.strokeStyle = ink;
  if (pattern === 'planks') {
    // Boards a quarter of a cell wide, a metre long, and every row's joint somewhere else.
    const board = R / 4;
    for (let i = 0; i < 8; i++) {
      g.fillRect(0, i * board, R * 2, 1);
      g.fillRect(Math.floor(hash(i + 3) * R * 2), i * board, 1, board);
    }
  } else if (pattern === 'tiles') {
    // One tile to a cell, the grout a line.
    g.fillRect(0, 0, R * 2, 2);
    g.fillRect(0, R, R * 2, 2);
    g.fillRect(0, 0, 2, R * 2);
    g.fillRect(R, 0, 2, R * 2);
  } else if (pattern === 'weave') {
    // A carpet at this distance is a fine, even grain.
    const step = R / 8;
    for (let y = 0; y < R * 2; y += step) {
      for (let x = (y / step) % 2 === 0 ? 0 : step / 2; x < R * 2; x += step) g.fillRect(x, y, 2, 2);
    }
  } else {
    // Concrete: an uneven scatter of flecks, of two sizes.
    for (let i = 0; i < 70; i++) {
      const d = i % 5 === 0 ? 3 : 1.5;
      g.fillRect(hash(i) * R * 2, hash(i + 101) * R * 2, d, d);
    }
  }
  tiles.set(key, canvas);
  return canvas;
}

/** Every surface on the floor: one fill per surface, and its pattern over it when the zoom can carry one. */
function drawSurfaces(scene: Scene, painted: PaintedCells): void {
  const { ctx, transform, size, sizeY } = scene;
  const bySurface = new Map<string, Path2D>();
  const kinds = new Set<string>([scene.floor.surface ?? 'parquet', ...painted.values()]);
  for (const kind of kinds) {
    bySurface.set(kind, cellsPath(scene, (code, row, col) => standsOn(code) && surfaceAt(scene, painted, row, col) === kind));
  }
  const strength = Math.min(1, (size - PATTERN_FROM_PX) / PATTERN_FROM_PX);
  for (const [kind, path] of bySurface) {
    const surface = look.surfaces[kind] ?? look.surfaces.parquet;
    ctx.fillStyle = surface.base;
    ctx.fill(path);
    if (strength <= 0) continue;
    const pattern = ctx.createPattern(tile(surface.pattern, surface.ink), 'repeat');
    if (!pattern) continue;
    // Anchored to the floor's own corner and scaled with it, so a pattern never crawls under a pan.
    pattern.setTransform(new DOMMatrix().translateSelf(transform.ox, transform.oy).scaleSelf(size / TILE_PX, sizeY / TILE_PX));
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.fillStyle = pattern;
    ctx.fill(path);
    ctx.restore();
  }
}

// ── doors ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An open door as a plan draws one: the leaf against its jamb and the arc it swung through, on floor that
 * shows through. A shut door stands like the wall it closes, so it is drawn with what stands (`standing.ts`).
 */
function drawOpenDoor(scene: Scene, x: number, y: number, row: number, col: number): void {
  const { ctx, size, sizeY } = scene;
  const cells = scene.floor.cells;
  // If the wall carries on to the left and right, the door sits in an east-west wall; otherwise in a
  // north-south one, and the same drawing is turned a quarter.
  const across = cells[row]?.[col - 1] === 'wall' && cells[row]?.[col + 1] === 'wall';
  ctx.save();
  ctx.translate(x + size / 2, y + sizeY / 2);
  // Drawn as on a square cell and squashed with the floor, so the arc lies on the floor as the floor does.
  ctx.scale(1, sizeY / size);
  if (!across) ctx.rotate(Math.PI / 2);
  const h = size / 2;
  const leaf = Math.max(2, size * 0.1);

  // The hinge at one corner, the leaf up its jamb, and the quarter it swept from across the opening.
  ctx.strokeStyle = look.door.arc;
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.setLineDash([Math.max(2, size * 0.08), Math.max(2, size * 0.06)]);
  ctx.beginPath();
  ctx.arc(-h, h, size - leaf / 2, -Math.PI / 2, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = look.door.leaf;
  ctx.beginPath();
  ctx.roundRect(-h, -h, leaf, size, leaf / 2);
  ctx.fill();
  ctx.restore();
}

// ── the ground ───────────────────────────────────────────────────────────────────────────────────────

/** Everything the floor itself is; what stands off it is drawn after, in `standing.ts`. */
export function drawGround(scene: Scene, painted: PaintedCells): void {
  const { ctx, cellM, transform, size } = scene;
  const cells = scene.floor.cells;

  // The whole building first, casting its shadow onto the ground: the floor is one object on the page.
  // Filled with the floor's own surface, so a hairline between two fills never shows the background.
  const building = cellsPath(scene, code => code !== 'void');
  // …and it sits *in* the table rather than on top of it: a short, dark contact shadow all the way round,
  // under the directional one, so the edge of the plan is a seam and not a crop.
  ctx.save();
  castShadow(ctx, 'rgba(3, 6, 12, 0.8)', Math.max(10, size * 0.6), Math.max(3, size * 0.14));
  ctx.fillStyle = '#000000';
  ctx.fill(building);
  ctx.restore();
  ctx.save();
  castShadow(ctx, look.buildingShadow, Math.min(48, size * 1.2), Math.min(16, size * 0.3));
  ctx.fillStyle = (look.surfaces[scene.floor.surface] ?? look.surfaces.parquet).base;
  ctx.fill(building);
  ctx.restore();

  drawSurfaces(scene, painted);

  // Ambient shade: a wall darkens the floor around it on every side, not only the side the light falls on.
  // The walls themselves are drawn after this and paint over their own footprint, so this is only their
  // shadow — and it is what makes a room read as a room at the zoom where the whole floor is on screen.
  ctx.save();
  castShadow(ctx, 'rgba(24, 18, 12, 0.55)', Math.max(6, size * 0.6), 0);
  ctx.fillStyle = '#000000';
  ctx.fill(cellsPath(scene, code => code === 'wall' || code === 'doorShut'));
  ctx.restore();

  for (let row = 0; row < cells.length; row++) {
    for (let col = 0; col < cells[row].length; col++) {
      if (cells[row][col] !== 'doorOpen') continue;
      const [x, y] = toScreen(transform, col * cellM, row * cellM);
      drawOpenDoor(scene, x, y, row, col);
    }
  }
}

