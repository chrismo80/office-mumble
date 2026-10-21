/**
 * Everything that stands off the floor — walls, shut doors, furniture, people — drawn back to front. Each is a
 * `Standing`: the southern edge of its footprint and how to draw it. Sorted by that edge, whatever stands
 * further south covers what is behind it, which is what makes the room read as depth (see `depth.ts`).
 */

import { shade } from './colour';
import { CUT_M, footprint, heightIn, RISE, RISES, risePx, WALL_HEIGHT_M } from './depth';
import { glassAt, hourNow } from './light';
import { isMissing, PIECES } from './furniture';
import { look } from './look';
import { castShadow, type Scene } from './scene';
import { drawPiece, reachOf, TURN } from './piece';
import { nearness, riseOf, squashOf, toScreen } from './view';

/** The glass of every window on the floor: asked once an hour, not once a pane. */
let glassHour = Number.NaN;
let glassPane = glassAt(0);
function glassNow(): { sky: string; caught: string | null } {
  const hour = hourNow();
  if (hour !== glassHour) {
    glassHour = hour;
    glassPane = glassAt(hour);
  }
  return glassPane;
}

/** One thing that stands: the southern edge of its footprint in plan metres, its shadow, and itself. */
export type Standing = {
  base: number;
  shadow?: (ctx: CanvasRenderingContext2D, dx: number) => void;
  draw: () => void;
};

/** How far off the canvas a shape is drawn when only its shadow is wanted back. */
const AWAY = 100_000;

/** Draws everything that stands: every shadow first, then every thing in order from the back to the front. */
export function drawStanding(scene: Scene, items: Standing[]): void {
  const { ctx, size } = scene;
  ctx.save();
  castShadow(ctx, look.furnitureShadow, Math.min(10, size * 0.22), Math.min(5, size * 0.1), AWAY);
  ctx.fillStyle = '#000';
  for (const item of items) item.shadow?.(ctx, -AWAY);
  ctx.restore();
  const ordered = [...items].sort((a, b) => a.base - b.base);
  for (const item of ordered) item.draw();
}

// ── walls and shut doors ─────────────────────────────────────────────────────────────────────────────

const isWall = (code: string | undefined): boolean => code === 'wall';

/**
 * Walls and shut doors. A wall stands on its footprint and rises from it, as furniture does: its top is its
 * footprint lifted by its height, and its front runs from there down to the floor only where the cell to its
 * south is open floor, so a north-south wall shows its front at its southern end alone. A shut door is a leaf
 * as high as the wall it closes, in the one loud colour on the floor.
 */
export function wallsAndDoors(scene: Scene): Standing[] {
  if (scene.transform.yaw !== undefined) return wallsTurned(scene);
  const { ctx, floor, cellM, transform, size, sizeY } = scene;
  const rise = risePx(WALL_HEIGHT_M, transform.scale);
  const items: Standing[] = [];

  floor.cells.forEach((cells, row) => {
    // The row's walls as runs, so a stretch of wall is one shape: one fill, one outline, no seam per cell.
    const tops = new Path2D();
    const fronts = new Path2D();
    const outline = new Path2D();
    const lit: Array<[number, number, number]> = [];
    // Where the row's tops are on screen: the footprint's own row, lifted by the wall's height.
    const y = toScreen(transform, 0, row * cellM)[1] - rise;
    // A front wherever the cell to the south is not wall: over a door too, since a wall rises from its foot and
    // the face over a doorway is all that a wall running away from the eye shows of it.
    const exposed = (col: number): boolean => !isWall(floor.cells[row + 1]?.[col]);
    const xAt = (col: number): number => toScreen(transform, col * cellM, 0)[0];
    let any = false;
    for (let col = 0; col < cells.length; ) {
      if (!isWall(cells[col])) { col++; continue; }
      any = true;
      let end = col;
      while (isWall(cells[end + 1])) end++;
      const x0 = xAt(col);
      const x1 = xAt(end + 1);
      tops.rect(x0, y, x1 - x0, sizeY);
      // The top's outline: only where it meets something that is not wall.
      outline.moveTo(x0, y); outline.lineTo(x0, y + sizeY);
      outline.moveTo(x1, y); outline.lineTo(x1, y + sizeY);
      for (let c = col; c <= end; c++) {
        const cx = xAt(c);
        if (!isWall(floor.cells[row - 1]?.[c])) { outline.moveTo(cx, y); outline.lineTo(cx + size, y); }
        if (!isWall(floor.cells[row + 1]?.[c])) { outline.moveTo(cx, y + sizeY); outline.lineTo(cx + size, y + sizeY); }
      }
      // Fronts: the stretches of this run with open floor to the south.
      for (let c = col; c <= end; ) {
        if (!exposed(c)) { c++; continue; }
        let last = c;
        while (last + 1 <= end && exposed(last + 1)) last++;
        const fx0 = xAt(c);
        const fx1 = xAt(last + 1);
        fronts.rect(fx0, y + sizeY, fx1 - fx0, rise);
        lit.push([fx0, y + sizeY, fx1 - fx0]);
        c = last + 1;
      }
      col = end + 1;
    }
    if (!any) return;
    const body = new Path2D();
    body.addPath(tops);
    body.addPath(fronts);
    items.push({
      base: (row + 1) * cellM,
      shadow: (c, dx) => {
        c.save();
        c.translate(dx, 0);
        c.fill(body);
        c.restore();
      },
      draw: () => {
        ctx.fillStyle = look.wall.front;
        ctx.fill(fronts);
        ctx.fillStyle = look.wall.top;
        ctx.fill(tops);
        // The edge where the top meets the front catches the light: one line, and the wall has a corner.
        ctx.fillStyle = look.wall.edge;
        for (const [lx, ly, lw] of lit) ctx.fillRect(lx, ly, lw, Math.max(1, rise * 0.06));
        ctx.strokeStyle = look.wall.outline;
        ctx.lineWidth = 1;
        ctx.stroke(outline);
        ctx.stroke(fronts);
      },
    });

    // A window is a gap in the wall with glass in it. The wall's run stops on either side, the opening is
    // filled with the sky of that hour, and three thin lines across it are the glass — the plan's own
    // convention. It stands as high as the wall: a sill of wall below, glass above it.
    cells.forEach((code, col) => {
      if (code !== 'window') return;
      const [x, foot] = toScreen(transform, col * cellM, row * cellM);
      const y = foot - rise;
      const along = cells[col - 1] === 'window' || cells[col + 1] === 'window' || isWall(cells[col - 1]) || isWall(cells[col + 1]);
      const open = exposed(col);
      items.push({
        base: (row + 1) * cellM,
        // The day comes through: a window casts no shadow of its own.
        shadow: () => {},
        draw: () => {
          const pane = glassNow();
          if (open) {
            // Its front: the sill as wall, and the glass from the sill up to the top.
            const sill = rise * 0.45;
            ctx.fillStyle = look.wall.front;
            ctx.fillRect(x, y + sizeY + rise - sill, size, sill);
            ctx.fillStyle = pane.sky;
            ctx.fillRect(x, y + sizeY, size, rise - sill);
            ctx.strokeStyle = look.wall.outline;
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + sizeY + 0.5, size - 1, rise - 1);
          }
          ctx.fillStyle = pane.sky;
          ctx.fillRect(x, y, size, sizeY);
          if (pane.caught) {
            // The room's light caught in the glass, on the half that faces into it.
            ctx.fillStyle = pane.caught;
            ctx.fillRect(x + size * 0.32, y + sizeY * 0.15, size * 0.36, sizeY * 0.7);
          }
          ctx.strokeStyle = look.window.line;
          ctx.lineWidth = Math.max(1, size * 0.05);
          ctx.beginPath();
          for (const at of [0.3, 0.5, 0.7]) {
            if (along) {
              ctx.moveTo(x, y + sizeY * at);
              ctx.lineTo(x + size, y + sizeY * at);
            } else {
              ctx.moveTo(x + size * at, y);
              ctx.lineTo(x + size * at, y + sizeY);
            }
          }
          ctx.stroke();
          // The jambs: the wall's own edge, so the opening reads as cut into it.
          ctx.strokeStyle = look.wall.outline;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, size - 1, sizeY - 1);
        },
      });
    });

    cells.forEach((code, col) => {
      if (code !== 'doorShut') return;
      const [x, foot] = toScreen(transform, col * cellM, row * cellM);
      const y = foot - rise;
      const across = isWall(cells[col - 1]) && isWall(cells[col + 1]);
      const t = size * 0.26;
      const tY = sizeY * 0.26;
      // The leaf's top, across the opening or along it, and its face down to the floor, as a wall's is.
      const top: [number, number, number, number] = across
        ? [x, y + (sizeY - tY) / 2, size, tY]
        : [x + (size - t) / 2, y, t, sizeY];
      const face: [number, number, number, number] = [top[0], top[1] + top[3], top[2], rise];
      items.push({
        base: (row + 1) * cellM,
        shadow: (c, dx) => c.fillRect(top[0] + dx, top[1], top[2], top[3] + rise),
        draw: () => {
          ctx.fillStyle = look.door.shutFront;
          ctx.fillRect(...face);
          ctx.fillStyle = look.door.shut;
          ctx.fillRect(...top);
          ctx.strokeStyle = look.door.edge;
          ctx.lineWidth = Math.max(1, size * 0.04);
          ctx.strokeRect(top[0], top[1], top[2], top[3] + rise);
        },
      });
    });
  });
  return items;
}

// ── walls, turned ────────────────────────────────────────────────────────────────────────────────────

type Point = [number, number];
type Side = { n: Point; a: Point; b: Point; next: Point };

/**
 * Walls, windows and shut doors for a turned view: each cell a box, drawn as those of its faces that look at
 * the viewer. The plan's own view draws runs of wall with their fronts to the south; a view that turns has no
 * south to put a front on, so every cell shows whichever of its sides the camera can see, and hides a side
 * where the next cell rises as high as it.
 */
function wallsTurned(scene: Scene): Standing[] {
  const { ctx, floor, cellM, transform: t } = scene;
  const cells = floor.cells;
  const lift = riseOf(t) * t.scale;
  const yaw = t.yaw ?? 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (x: number, y: number, z: number): Point => {
    const [sx, sy] = toScreen(t, x, y);
    return [sx, sy - z * lift];
  };
  const heightOf = (row: number, col: number): number => heightIn(cells, cellM, t, row, col, scene.cut);
  const lower = (next: Point, h: number): boolean => cells[next[0]]?.[next[1]] === 'doorShut' || heightOf(next[0], next[1]) < h;
  const pane = glassNow();
  // Every wall's shadow as one shape, cast once: a soft shadow is the dearest thing a canvas fills.
  const shadows = new Path2D();
  const items: Standing[] = [{
    base: -Infinity,
    shadow: (g, dx) => {
      g.save();
      g.translate(dx, 0);
      g.fill(shadows);
      g.restore();
    },
    draw: () => {},
  }];

  cells.forEach((line, row) => line.forEach((code, col) => {
    if (!RISES.has(code)) return;
    const h = heightOf(row, col);
    const [x0, y0, x1, y1] = footprint(cells, cellM, row, col);
    const sides: Side[] = [
      { n: [0, -1], a: [x0, y0], b: [x1, y0], next: [row - 1, col] },
      { n: [1, 0], a: [x1, y0], b: [x1, y1], next: [row, col + 1] },
      { n: [0, 1], a: [x1, y1], b: [x0, y1], next: [row + 1, col] },
      { n: [-1, 0], a: [x0, y1], b: [x0, y0], next: [row, col - 1] },
    ];
    // What it is built of, from the floor up: a window is a sill of wall with the glass of the hour on it.
    const layers =
      code === 'window' && h > CUT_M
        ? [{ z0: 0, z1: h * 0.45, side: look.wall.front, top: look.wall.top }, { z0: h * 0.45, z1: h, side: pane.sky, top: pane.sky }]
        : code === 'doorShut'
          ? [{ z0: 0, z1: h, side: look.door.shutFront, top: look.door.shut }]
          : [{ z0: 0, z1: h, side: look.wall.front, top: look.wall.top }];
    // A side is seen when it faces the viewer and nothing as high stands against it.
    const seen = sides.filter(side => -side.n[0] * s + side.n[1] * c > 1e-3 && (code === 'doorShut' || lower(side.next, h)));
    const faces: Array<{ path: Path2D; fill: string }> = [];
    const body = new Path2D();
    const face = (pts: Point[], fill: string): void => {
      const path = new Path2D();
      path.moveTo(...pts[0]);
      for (const p of pts.slice(1)) path.lineTo(...p);
      path.closePath();
      body.addPath(path);
      faces.push({ path, fill });
    };
    for (const layer of layers) {
      for (const side of seen) {
        // Lit from the upper left of the screen, as every piece of furniture is: a side facing left is lighter.
        const across = side.n[0] * c + side.n[1] * s;
        face(
          [at(...side.a, layer.z0), at(...side.b, layer.z0), at(...side.b, layer.z1), at(...side.a, layer.z1)],
          shade(layer.side, across < 0 ? 0.1 * -across : -0.14 * across),
        );
      }
      face([at(x0, y0, layer.z1), at(x1, y0, layer.z1), at(x1, y1, layer.z1), at(x0, y1, layer.z1)], layer.top);
    }
    // The top's outline where it meets something lower, so a light wall keeps an edge on a light floor.
    const edges = sides.filter(side => code === 'doorShut' || lower(side.next, h)).map(side => [at(...side.a, h), at(...side.b, h)]);
    // The day comes through a window: it casts no shadow of its own.
    if (code !== 'window') shadows.addPath(body);
    const near = Math.max(nearness(t, x0, y0), nearness(t, x1, y0), nearness(t, x1, y1), nearness(t, x0, y1));
    items.push({
      // A wall cut down to a skirting lies with the floor, under everything that stands: it is where a wall
      // runs, not a thing in front of anybody's feet.
      base: h < WALL_HEIGHT_M ? near - 1e6 : near,
      draw: () => {
        for (const { path, fill } of faces) {
          ctx.fillStyle = fill;
          ctx.fill(path);
          // The same colour once round the edge, so two faces meet without a hairline between them.
          ctx.strokeStyle = fill;
          ctx.lineWidth = 0.6;
          ctx.stroke(path);
        }
        ctx.strokeStyle = code === 'doorShut' ? look.door.edge : look.wall.outline;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [p, q] of edges) {
          ctx.moveTo(...p);
          ctx.lineTo(...q);
        }
        ctx.stroke();
      },
    });
  }));
  return items;
}

/** Whether a box on the screen overlaps a figure standing with its feet at `feet`, drawn for a view of
 *  `scale` pixels a metre — a figure is about 1.1 m tall and half a metre wide as drawn (`people.ts`). */
export function overlapsFigure(feet: [number, number], scale: number, left: number, top: number, w: number, h: number): boolean {
  const r = Math.max(4, 0.33 * scale);
  return left < feet[0] + r * 1.2 && left + w > feet[0] - r * 1.2 && top < feet[1] && top + h > feet[1] - r * 3.5;
}

/**
 * Every piece of furniture for a turned view, at its angle to the camera. Kept as pictures, as the plan's own
 * view keeps them: the camera stands still between two turns, so a picture drawn once serves every frame
 * until the next. Angle and tilt are rounded, so the frames of a turn do not each ask for new ones.
 */
function furnitureTurned(scene: Scene): Standing[] {
  const { ctx, floor, cellM, transform: t, size } = scene;
  const dpr = ctx.getTransform().a;
  const squash = Math.round(squashOf(t) * 100) / 100;
  const rise = Math.sqrt(1 - squash * squash);
  return floor.objects.map(object => {
    const cx = (object.col + 0.5) * cellM;
    const cy = (object.row + 0.5) * cellM;
    const [sx, sy] = toScreen(t, cx, cy);
    const piece = PIECES[object.kind];
    if (!piece) {
      return {
        base: nearness(t, cx, cy),
        draw: () => {
          if (!isMissing(object.kind)) return;
          ctx.strokeStyle = '#f43f5e';
          ctx.lineWidth = 2;
          ctx.strokeRect(sx - size / 3, sy - size / 3, (size * 2) / 3, (size * 2) / 3);
        },
      };
    }
    // Its own turn on the plan, less the camera's: the angle it is seen at, the short way round and rounded.
    const turn = (TURN[object.facing] ?? 0) - (t.yaw ?? 0);
    const angle = Math.round(Math.atan2(Math.sin(turn), Math.cos(turn)) * 50) / 50;
    const hw = piece.w / 200;
    const hd = piece.d / 200;
    // The corner of its footprint nearest the viewer orders it among everything else that stands.
    const reach = Math.max(...[[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([dx, dy]) => dx * Math.sin(angle) + dy * Math.cos(angle)));
    const shown = render(object.kind, angle, t.scale, squash, rise, dpr);
    if (!shown) return { base: nearness(t, cx, cy), draw: () => {} };
    const k = t.scale / 100 / shown.step;
    const left = sx - shown.ox * k;
    const top = sy - shown.oy * k;
    const base = nearness(t, cx, cy) + reach;
    // A piece between the camera and my figure that covers it on the screen is drawn see-through, as the walls
    // there are cut down: from behind, nothing stands in front of me.
    const covers = scene.cut !== undefined && scene.mineAt !== undefined && base > scene.cut && overlapsFigure(scene.mineAt, t.scale, left, top, shown.w * k, shown.h * k);
    return {
      base,
      shadow: (g, dx) => g.drawImage(shown.canvas, left + dx, top, shown.w * k, shown.h * k),
      draw: () => {
        if (covers) ctx.globalAlpha = 0.3;
        ctx.drawImage(shown.canvas, left, top, shown.w * k, shown.h * k);
        ctx.globalAlpha = 1;
      },
    };
  });
}

// ── furniture ────────────────────────────────────────────────────────────────────────────────────────

/** A piece rendered for one view, and where the centre of its footprint is on that canvas. */
type Rendered = { canvas: HTMLCanvasElement; w: number; h: number; ox: number; oy: number; step: number };

const rendered = new Map<string, Rendered>();

/**
 * A piece drawn for a view, once, and kept. Zooms are rounded to steps of about two percent, so a slow wheel
 * does not redraw every piece every frame; the step is drawn at the exact size, which no eye can tell apart.
 */
function render(kind: string, facing: string | number, scale: number, squash: number, rise: number, dpr: number): Rendered | null {
  const piece = PIECES[kind];
  if (!piece) return null;
  const perCm = scale / 100;
  const step = 2 ** (Math.round(Math.log2(perCm) * 32) / 32);
  const key = `${kind}|${facing}|${step}|${squash}|${rise}|${dpr}`;
  const have = rendered.get(key);
  if (have) return have;
  if (rendered.size > 600) rendered.clear();

  const projection = { k: step * dpr, squash, rise };
  const reach = reachOf(piece, facing, projection);
  const pad = 2;
  const W = Math.max(1, Math.ceil(reach.left + reach.right) + pad * 2);
  const H = Math.max(1, Math.ceil(reach.up + reach.down) + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.translate(reach.left + pad, reach.up + pad);
  drawPiece(g, piece, facing, projection);
  // Sizes are kept in the step's own CSS pixels; the draw scales them to the exact zoom.
  const made: Rendered = { canvas, w: W / dpr, h: H / dpr, ox: (reach.left + pad) / dpr, oy: (reach.up + pad) / dpr, step };
  rendered.set(key, made);
  return made;
}

/** Every piece of furniture on the floor, standing on its footprint and rising up the screen from it. */
export function furniture(scene: Scene): Standing[] {
  if (scene.transform.yaw !== undefined) return furnitureTurned(scene);
  const { ctx, floor, cellM, transform, size } = scene;
  const dpr = ctx.getTransform().a;
  const squash = squashOf(transform);
  return floor.objects.map(object => {
    const cx = (object.col + 0.5) * cellM;
    const cy = (object.row + 0.5) * cellM;
    const [sx, sy] = toScreen(transform, cx, cy);
    const piece = PIECES[object.kind];
    const shown = render(object.kind, object.facing, transform.scale, squash, RISE, dpr);
    if (!piece || !shown) {
      return {
        base: cy,
        draw: () => {
          if (!isMissing(object.kind)) return;
          // A name the plan carries that nothing was modelled for: shown, so a mistake in the plan is visible
          // rather than swallowed into an empty cell.
          ctx.strokeStyle = '#f43f5e';
          ctx.lineWidth = 2;
          ctx.strokeRect(sx - size / 3, sy - size / 3, (size * 2) / 3, (size * 2) / 3);
        },
      };
    }
    const k = transform.scale / 100 / shown.step;
    const left = sx - shown.ox * k;
    const top = sy - shown.oy * k;
    const quarter = object.facing === 'east' || object.facing === 'west';
    const depthM = (quarter ? piece.w : piece.d) / 100;
    return {
      // The southern edge of the footprint, in plan metres: what orders it among everything else that stands.
      base: cy + depthM / 2,
      shadow: (c, dx) => c.drawImage(shown.canvas, left + dx, top, shown.w * k, shown.h * k),
      draw: () => ctx.drawImage(shown.canvas, left, top, shown.w * k, shown.h * k),
    };
  });
}

/**
 * A piece drawn where it would stand, see-through: the editor's preview. The same picture the floor draws, so
 * what is previewed is what will stand there.
 */
export function drawPieceOn(scene: Scene, kind: string, facing: string, row: number, col: number, alpha: number): void {
  const { ctx, cellM, transform } = scene;
  const shown = render(kind, facing, transform.scale, squashOf(transform), RISE, ctx.getTransform().a);
  if (!shown) return;
  const [sx, sy] = toScreen(transform, (col + 0.5) * cellM, (row + 0.5) * cellM);
  const k = transform.scale / 100 / shown.step;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(shown.canvas, sx - shown.ox * k, sy - shown.oy * k, shown.w * k, shown.h * k);
  ctx.restore();
}

/**
 * A piece as a small picture for the catalogue: facing the viewer, by the same projection the floor uses.
 */
export function thumbnail(kind: string, px: number, squash: number): HTMLCanvasElement | null {
  const piece = PIECES[kind];
  if (!piece) return null;
  const dpr = window.devicePixelRatio || 1;
  const unit = reachOf(piece, 'south', { k: 1, squash, rise: RISE });
  const span = Math.max(unit.left + unit.right, unit.up + unit.down);
  const k = ((px - 6) * dpr) / span;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(px * dpr);
  canvas.height = Math.round(px * dpr);
  const g = canvas.getContext('2d')!;
  // The piece's own middle on screen is half-way between how far it reaches either side.
  g.translate(canvas.width / 2 + ((unit.left - unit.right) * k) / 2, canvas.height / 2 + ((unit.up - unit.down) * k) / 2);
  drawPiece(g, piece, 'south', { k, squash, rise: RISE });
  return canvas;
}
