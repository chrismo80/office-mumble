/**
 * A stair as the model builds one: a flight of treads you can count on the floor it climbs from, and a well
 * with the same treads going down into it on the floor it arrives at.
 *
 * The flight rises as high as a wall is drawn (`WALL_HEIGHT_M`) and stops there, cut off as the walls are: the
 * model is cut at one height, and a flight as high as a storey would stand twice as tall as every wall and
 * cover the room behind it. The well on the floor above is as deep. Two treads to a cell.
 *
 * Every tread is a box, drawn the way walls are drawn from behind (`standing.ts`): its top, and those of its
 * sides that look at the viewer and stand higher than what is next to them. A tread of the flight is ordered
 * among everything else that stands by its corner nearest the viewer. The well lies under everything: all of it
 * is below the floor, so it is seen only through its opening. Somebody on a stair stands on the tread under
 * their feet (`underfoot`): lifted by its height, drawn after it, and in the well cut off where the floor
 * around the opening covers them.
 */

import { shade } from './colour';
import { insideQuad, WALL_HEIGHT_M } from './depth';
import { look } from './look';
import type { Scene } from './scene';
import { overlapsFigure, type Standing } from './standing';
import { nearness, riseOf, toScreen, type Transform } from './view';
import type { Floor, Stair } from './wire';

/** How high a flight climbs, and how deep its well goes. */
export const STAIR_HEIGHT_M = WALL_HEIGHT_M;

/** Treads to a cell, along the flight. */
const PER_CELL = 2;

/** One tread: its footprint in plan metres, and how high its top is above the floor — below it, in a well. */
export type Tread = { x0: number; y0: number; x1: number; y1: number; z: number };

type Point = [number, number];

/** Whether a stair climbs from this floor or comes down into it. Floors are counted from the ground up. */
const climbs = (stair: Stair, storey: number): boolean => stair.to > storey;

/**
 * The treads of a flight, from the end it is entered at to the end it is left by. On the floor it climbs from,
 * the first stands one tread high and the last as high as the flight. In the well the first is level with the
 * floor and each one after it a tread deeper: the same treads, one flight lower.
 */
export function treadsOf(stair: Stair, storey: number, cellM: number): Tread[] {
  const rows = Math.max(1, stair.rows);
  const cols = Math.max(1, stair.cols);
  const alongCols = stair.exits === 'east' || stair.exits === 'west';
  const count = (alongCols ? cols : rows) * PER_CELL;
  const depth = cellM / PER_CELL;
  const towardsEnd = stair.exits === 'east' || stair.exits === 'south';
  const x = stair.col * cellM;
  const y = stair.row * cellM;
  const up = climbs(stair, storey);
  const treads: Tread[] = [];
  for (let k = 0; k < count; k++) {
    // Its place counted from the flight's west or north edge.
    const p = towardsEnd ? k : count - 1 - k;
    const z = up ? (STAIR_HEIGHT_M * (k + 1)) / count : (-STAIR_HEIGHT_M * k) / count;
    treads.push(
      alongCols
        ? { x0: x + p * depth, y0: y, x1: x + (p + 1) * depth, y1: y + rows * cellM, z }
        : { x0: x, y0: y + p * depth, x1: x + cols * cellM, y1: y + (p + 1) * depth, z },
    );
  }
  return treads;
}

/** The stair under a point of the floor, and the tread its feet stand on, or null off every stair. */
export function underfoot(
  floor: Floor,
  storey: number,
  cellM: number,
  x: number,
  y: number,
): { stair: Stair; tread: Tread; climbs: boolean } | null {
  for (const stair of floor.stairs ?? []) {
    const x0 = stair.col * cellM;
    const y0 = stair.row * cellM;
    if (x < x0 || y < y0 || x >= x0 + Math.max(1, stair.cols) * cellM || y >= y0 + Math.max(1, stair.rows) * cellM) continue;
    const tread = treadsOf(stair, storey, cellM).find(t => x >= t.x0 && x < t.x1 && y >= t.y0 && y < t.y1);
    if (tread) return { stair, tread, climbs: climbs(stair, storey) };
  }
  return null;
}

/** A point of the plan at a height, on the screen. */
function at(t: Transform, x: number, y: number, z: number): Point {
  const [sx, sy] = toScreen(t, x, y);
  return [sx, sy - z * riseOf(t) * t.scale];
}

/** How near the viewer a tread's nearest corner is: what orders it, and what somebody on it is drawn after. */
export function nearestCorner(t: Transform, tread: Tread): number {
  return Math.max(nearness(t, tread.x0, tread.y0), nearness(t, tread.x1, tread.y0), nearness(t, tread.x1, tread.y1), nearness(t, tread.x0, tread.y1));
}

/** The opening of a stair in the floor, on the screen: what a well is seen through. */
export function opening(t: Transform, stair: Stair, cellM: number): Point[] {
  const x0 = stair.col * cellM;
  const y0 = stair.row * cellM;
  const x1 = x0 + Math.max(1, stair.cols) * cellM;
  const y1 = y0 + Math.max(1, stair.rows) * cellM;
  return [at(t, x0, y0, 0), at(t, x1, y0, 0), at(t, x1, y1, 0), at(t, x0, y1, 0)];
}

/**
 * Cuts the drawing down to what is seen of somebody standing in a well: whatever of them is above the floor,
 * and whatever is below it only through the opening. `floorY` is where their feet would be on the screen at
 * floor level. The opening and the rest run the same way round, so together they are one region and not a hole.
 */
export function clipToWell(ctx: CanvasRenderingContext2D, t: Transform, stair: Stair, cellM: number, floorY: number): void {
  const quad = opening(t, stair, cellM);
  const far = 1e6;
  ctx.beginPath();
  ctx.moveTo(...quad[0]);
  for (const p of quad.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.rect(-far, -far, far * 2, floorY + far);
  ctx.clip();
}

/** One side of a tread: its outward normal in the plan, its two corners, and the height next to it. */
type Side = { n: Point; a: Point; b: Point; next: number };

/** The sides of a tread, each with the height of what stands next to it: the next tread, or `outside`. */
function sidesOf(treads: Tread[], k: number, outside: number): Side[] {
  const { x0, y0, x1, y1 } = treads[k];
  const height = (x: number, y: number): number =>
    treads.find(t => x > t.x0 && x < t.x1 && y > t.y0 && y < t.y1)?.z ?? outside;
  const e = 1e-3;
  return [
    { n: [0, -1], a: [x0, y0], b: [x1, y0], next: height((x0 + x1) / 2, y0 - e) },
    { n: [1, 0], a: [x1, y0], b: [x1, y1], next: height(x1 + e, (y0 + y1) / 2) },
    { n: [0, 1], a: [x1, y1], b: [x0, y1], next: height((x0 + x1) / 2, y1 + e) },
    { n: [-1, 0], a: [x0, y1], b: [x0, y0], next: height(x0 - e, (y0 + y1) / 2) },
  ];
}

/** The faces of a tread standing from `bottom` to its top, as a viewer sees them, filled in the stair's
 *  colours and lit from the upper left as every wall is; `dark` shades them for the depth of a well. */
function treadFaces(t: Transform, treads: Tread[], k: number, bottom: number, outside: number, dark: number): Array<{ pts: Point[]; fill: string }> {
  const tread = treads[k];
  const c = Math.cos(t.yaw ?? 0);
  const s = Math.sin(t.yaw ?? 0);
  const faces: Array<{ pts: Point[]; fill: string }> = [];
  for (const side of sidesOf(treads, k, outside)) {
    const facing = -side.n[0] * s + side.n[1] * c > 1e-3;
    if (!facing || side.next >= tread.z - 1e-6) continue;
    const across = side.n[0] * c + side.n[1] * s;
    const from = Math.max(bottom, side.next);
    faces.push({
      pts: [at(t, ...side.a, from), at(t, ...side.b, from), at(t, ...side.b, tread.z), at(t, ...side.a, tread.z)],
      fill: shade(shade(look.stair.side, across < 0 ? 0.1 * -across : -0.14 * across), dark),
    });
  }
  faces.push({
    pts: [at(t, tread.x0, tread.y0, tread.z), at(t, tread.x1, tread.y0, tread.z), at(t, tread.x1, tread.y1, tread.z), at(t, tread.x0, tread.y1, tread.z)],
    fill: shade(look.stair.top, dark),
  });
  return faces;
}

function fillFaces(ctx: CanvasRenderingContext2D, faces: Array<{ pts: Point[]; fill: string }>): void {
  for (const face of faces) {
    ctx.beginPath();
    ctx.moveTo(...face.pts[0]);
    for (const p of face.pts.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
    ctx.fillStyle = face.fill;
    ctx.fill();
    // The same colour once round the edge, so two faces meet without a hairline between them.
    ctx.strokeStyle = face.fill;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  // The nosing: the edge of each top, so the treads can be counted on a light floor.
  const top = faces[faces.length - 1].pts;
  ctx.strokeStyle = look.stair.outline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(...top[0]);
  for (const p of top.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.stroke();
}

/** Every stair on the floor as things that stand: each tread of a flight on its own, and each well as one
 *  thing under everything else. */
export function stairs(scene: Scene): Standing[] {
  const items: Standing[] = [];
  for (const stair of scene.floor.stairs ?? []) {
    if (climbs(stair, scene.storey)) items.push(...flight(scene, stair));
    else items.push(well(scene, stair));
    items.push(...railing(scene, stair));
  }
  return items;
}

/** How high the railing stands above what it guards: below a figure's shoulder, so nobody is hidden by it. */
const RAIL_M = 0.8;

/**
 * The railing: a pane of acrylic along every side of a stair that is not its foot. Those are the sides the walk
 * may not cross (`Stair::fences` on the server), so the railing is where the way round to the foot comes from.
 * Along a flight it runs up the long sides with the treads, its rail rising evenly; round a well it stands on
 * the floor at the opening, on the long sides and across the far end. Each piece is ordered by its own
 * nearest corner, just after whoever stands on the tread beside it, so a pane in front of somebody is in front.
 */
function railing(scene: Scene, stair: Stair): Standing[] {
  const { ctx, cellM, transform: t } = scene;
  const up = climbs(stair, scene.storey);
  const rows = Math.max(1, stair.rows);
  const cols = Math.max(1, stair.cols);
  const alongCols = stair.exits === 'east' || stair.exits === 'west';
  const length = (alongCols ? cols : rows) * cellM;
  const towardsEnd = stair.exits === 'east' || stair.exits === 'south';
  const x0 = stair.col * cellM;
  const y0 = stair.row * cellM;
  const x1 = x0 + cols * cellM;
  const y1 = y0 + rows * cellM;
  // How far a point is from the foot, along the flight.
  const fromFoot = ([x, y]: Point): number => {
    const along = alongCols ? x - x0 : y - y0;
    return towardsEnd ? along : length - along;
  };
  const panes: Array<{ a: Point; b: Point; za: number; zb: number; top: [number, number] }> = [];
  if (up) {
    // The long sides, a pane per tread: standing on its tread, the rail rising with the flight. Cut off where
    // the flight is, at the model's one height: the railing of the upper treads goes on in the storey above.
    const rail = (p: Point): number => Math.min(STAIR_HEIGHT_M, (STAIR_HEIGHT_M * fromFoot(p)) / length + RAIL_M);
    for (const tread of treadsOf(stair, scene.storey, cellM)) {
      if (tread.z >= STAIR_HEIGHT_M - 1e-6) continue;
      const sides: Array<[Point, Point]> = alongCols
        ? [[[tread.x0, y0], [tread.x1, y0]], [[tread.x0, y1], [tread.x1, y1]]]
        : [[[x0, tread.y0], [x0, tread.y1]], [[x1, tread.y0], [x1, tread.y1]]];
      for (const [a, b] of sides) panes.push({ a, b, za: tread.z, zb: tread.z, top: [rail(a), rail(b)] });
    }
  } else {
    // Round the opening, a pane per cell, on every side but the foot.
    const corners: Point[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const foot = { north: 2, south: 0, east: 3, west: 1 }[stair.exits];
    corners.forEach((a, side) => {
      if (side === foot) return;
      const b = corners[(side + 1) % 4];
      const cells = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / cellM);
      for (let i = 0; i < cells; i++) {
        const p: Point = [a[0] + ((b[0] - a[0]) * i) / cells, a[1] + ((b[1] - a[1]) * i) / cells];
        const q: Point = [a[0] + ((b[0] - a[0]) * (i + 1)) / cells, a[1] + ((b[1] - a[1]) * (i + 1)) / cells];
        panes.push({ a: p, b: q, za: 0, zb: 0, top: [RAIL_M, RAIL_M] });
      }
    });
  }
  return panes.map(pane => {
    const pts = [at(t, ...pane.a, pane.za), at(t, ...pane.b, pane.zb), at(t, ...pane.b, pane.top[1]), at(t, ...pane.a, pane.top[0])];
    return {
      base: Math.max(nearness(t, ...pane.a), nearness(t, ...pane.b)) + 2e-3,
      draw: () => {
        ctx.beginPath();
        ctx.moveTo(...pts[0]);
        for (const p of pts.slice(1)) ctx.lineTo(...p);
        ctx.closePath();
        ctx.fillStyle = look.stair.pane;
        ctx.fill();
        ctx.strokeStyle = look.stair.rail;
        ctx.lineWidth = Math.max(1, t.scale * 0.025);
        ctx.beginPath();
        ctx.moveTo(...pts[3]);
        ctx.lineTo(...pts[2]);
        ctx.stroke();
      },
    };
  });
}

/** A flight climbing from this floor: a box per tread, standing on the floor. */
function flight(scene: Scene, stair: Stair): Standing[] {
  const { ctx, cellM, transform: t } = scene;
  const treads = treadsOf(stair, scene.storey, cellM);
  return treads.map((tread, k) => {
    const faces = treadFaces(t, treads, k, 0, 0, 0);
    const body = new Path2D();
    for (const face of faces) {
      body.moveTo(...face.pts[0]);
      for (const p of face.pts.slice(1)) body.lineTo(...p);
      body.closePath();
    }
    const near = nearestCorner(t, tread);
    const xs = faces.flatMap(face => face.pts.map(p => p[0]));
    const ys = faces.flatMap(face => face.pts.map(p => p[1]));
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    // A tread between the camera and my figure that covers it is drawn see-through, as furniture there is.
    const covers =
      scene.furnitureGivesWay === true &&
      scene.cut !== undefined &&
      scene.mineAt !== undefined &&
      near > scene.cut + 1e-3 &&
      overlapsFigure(scene.mineAt, t.scale, left, top, Math.max(...xs) - left, Math.max(...ys) - top);
    return {
      base: near,
      shadow: (g, dx) => {
        g.save();
        g.translate(dx, 0);
        g.fill(body);
        g.restore();
      },
      draw: () => {
        if (covers) ctx.globalAlpha = 0.3;
        fillFaces(ctx, faces);
        ctx.globalAlpha = 1;
      },
    };
  });
}

/** A well coming down into this floor: its far walls and its treads, seen through the opening. */
function well(scene: Scene, stair: Stair): Standing {
  const { ctx, cellM, transform: t } = scene;
  const treads = treadsOf(stair, scene.storey, cellM);
  const bottom = -STAIR_HEIGHT_M;
  const x0 = stair.col * cellM;
  const y0 = stair.row * cellM;
  const x1 = x0 + Math.max(1, stair.cols) * cellM;
  const y1 = y0 + Math.max(1, stair.rows) * cellM;
  const c = Math.cos(t.yaw ?? 0);
  const s = Math.sin(t.yaw ?? 0);
  // A wall of the well is seen from inside when it faces the viewer: the far ones.
  const walls: Array<{ n: Point; a: Point; b: Point }> = [
    { n: [0, 1], a: [x0, y0], b: [x1, y0] },
    { n: [-1, 0], a: [x1, y0], b: [x1, y1] },
    { n: [0, -1], a: [x1, y1], b: [x0, y1] },
    { n: [1, 0], a: [x0, y1], b: [x0, y0] },
  ];
  const back = walls
    .filter(wall => -wall.n[0] * s + wall.n[1] * c > 1e-3)
    .map(wall => ({
      pts: [at(t, ...wall.a, bottom), at(t, ...wall.b, bottom), at(t, ...wall.b, 0), at(t, ...wall.a, 0)],
      fill: shade(look.stair.side, -0.25),
    }));
  const order = treads.map((tread, k) => ({ k, near: nearestCorner(t, tread) })).sort((a, b) => a.near - b.near);
  const quad = opening(t, stair, cellM);
  return {
    // Below the floor, so under everything that stands on it, the walls cut down to a skirting included.
    base: -1e9,
    draw: () => {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(...quad[0]);
      for (const p of quad.slice(1)) ctx.lineTo(...p);
      ctx.closePath();
      ctx.clip();
      for (const wall of back) {
        ctx.beginPath();
        ctx.moveTo(...wall.pts[0]);
        for (const p of wall.pts.slice(1)) ctx.lineTo(...p);
        ctx.closePath();
        ctx.fillStyle = wall.fill;
        ctx.fill();
      }
      // The deeper a tread, the less of the room's light reaches it.
      for (const { k } of order) fillFaces(ctx, treadFaces(t, treads, k, bottom, 0, -0.32 * (-treads[k].z / STAIR_HEIGHT_M)));
      ctx.restore();
      // The edge of the opening, so the floor reads as cut.
      ctx.strokeStyle = look.stair.outline;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(...quad[0]);
      for (const p of quad.slice(1)) ctx.lineTo(...p);
      ctx.closePath();
      ctx.stroke();
    },
  };
}

/**
 * The cell of a flight a point of the screen shows, and how near the viewer it is: the frontmost tread whose
 * top or sides cover the point. A tread stands up off the floor, so a click on it lands on the screen above the
 * cell it stands on. Only a flight: a well lies in the floor and is clicked where it is.
 */
export function flightCellAt(floor: Floor, storey: number, cellM: number, t: Transform, sx: number, sy: number): { cell: [number, number]; near: number } | null {
  let best: { cell: [number, number]; near: number } | null = null;
  for (const stair of floor.stairs ?? []) {
    if (!climbs(stair, storey)) continue;
    const treads = treadsOf(stair, storey, cellM);
    for (let k = 0; k < treads.length; k++) {
      const tread = treads[k];
      const near = nearestCorner(t, tread);
      if (best && near <= best.near) continue;
      if (!treadFaces(t, treads, k, 0, 0, 0).some(face => insideQuad(sx, sy, face.pts))) continue;
      best = { cell: [Math.floor((tread.y0 + tread.y1) / 2 / cellM), Math.floor((tread.x0 + tread.x1) / 2 / cellM)], near };
    }
  }
  return best;
}
