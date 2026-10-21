/**
 * A piece of furniture as a small solid in centimetres, and how one is drawn.
 *
 * A piece is a handful of parts, and a part is a closed solid made of flat faces — built by the shapes below
 * rather than listed by hand — or a ball. Every shape a piece of furniture needs comes from three of them:
 *
 * - `loft` joins two outlines of the same number of corners, one above the other: a box, a tapered leg, a
 *   cone of a lamp shade, a splayed table leg, a turned bowl.
 * - `prism` pulls a side view through the piece's width (or depth): the profile of a sofa, a shell chair, a
 *   reclining back.
 * - `ball`: plant crowns, knobs.
 *
 * Modelled once facing south and projected for any facing and viewing angle: depth is foreshortened as the
 * floor is, height shows by the sine of the angle, and a face turned away is not drawn. Each face takes its
 * light from its own slope towards a light above the upper left, so a slanted back, a cone and a box are lit
 * by one rule and never by a number picked per piece. Details are painted in a face's own coordinates, so they
 * turn and foreshorten with it.
 */

/** One painter for a flat face, in that face's own centimetres. */
export type Paint = (g: CanvasRenderingContext2D) => void;

/** A side of a box, named for where it faces when the piece faces south. */
export type Side = 's' | 'n' | 'e' | 'w';

/** A point of a piece: `x` across, `y` into the page (south is larger), `z` up — centimetres. */
export type V3 = [number, number, number];
/** A point of an outline or a profile. */
export type P2 = [number, number];

/** A flat face of a solid, with its outward normal and, optionally, what is painted on it. A paint's frame
 *  is three points: where its origin is, and one centimetre along each of its axes. */
type Face = { pts: V3[]; n: V3; paint?: { draw: Paint; frame: [V3, V3, V3] } };

export type Part =
  | {
      faces: Face[];
      colour: string;
      /** Lit more gently — for white things and glass, which would otherwise turn grey on every side. */
      soft?: boolean;
    }
  | { ball: { x: number; y: number; z: number; r: number }; colour: string };

/** A piece: its footprint, `w` across and `d` deep in centimetres facing south, and what it is made of. */
export type Piece = { w: number; d: number; parts: Part[] };

import { shade } from './colour';

export { shade };

// ── vectors ──────────────────────────────────────────────────────────────────────────────────────────

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
const mean = (pts: V3[]): V3 => {
  const sum: V3 = [0, 0, 0];
  for (const p of pts) for (let i = 0; i < 3; i++) sum[i] += p[i];
  return [sum[0] / pts.length, sum[1] / pts.length, sum[2] / pts.length];
};
/** The normal of a flat polygon, by Newell's method: robust for any number of corners. */
function newell(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}
/** Twice the signed area of an outline: positive when it runs counter-clockwise in its own axes. */
const area2 = (pts: P2[]): number =>
  pts.reduce((sum, [u, v], i) => {
    const [u2, v2] = pts[(i + 1) % pts.length];
    return sum + u * v2 - u2 * v;
  }, 0);

// ── shapes ───────────────────────────────────────────────────────────────────────────────────────────

/** How a solid is finished: a paint on its top, and whether it is lit gently. */
export type Finish = { top?: Paint; soft?: boolean };

/**
 * A solid joining two outlines of the same number of corners, `low` and `high`: each pair of neighbouring
 * corners makes a side. Convex, which is what lets the outward side of each face be found from the middle.
 * The underside is never drawn, since nothing is ever seen from below.
 */
export function loft(low: V3[], high: V3[], colour: string, finish: Finish = {}): Part {
  const faces: V3[][] = [high];
  for (let i = 0; i < low.length; i++) {
    const j = (i + 1) % low.length;
    faces.push([low[i], low[j], high[j], high[i]]);
  }
  const middle = mean([...low, ...high]);
  const out: Face[] = [];
  for (const pts of faces) {
    const raw = newell(pts);
    if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-6) continue;
    const n = unit(raw);
    out.push({ pts, n: dot(n, sub(mean(pts), middle)) < 0 ? [-n[0], -n[1], -n[2]] : n });
  }
  const top = out[0];
  if (finish.top && top && top.pts === high) {
    const z = high[0][2];
    top.paint = { draw: finish.top, frame: [[0, 0, z], [1, 0, z], [0, 1, z]] };
  }
  return { faces: out, colour, soft: finish.soft };
}

/** An outline on the floor plan, `z` up, raised by `h`. */
export function extrude(outline: P2[], z: number, h: number, colour: string, finish: Finish = {}): Part {
  return loft(
    outline.map(([x, y]) => [x, y, z] as V3),
    outline.map(([x, y]) => [x, y, z + h] as V3),
    colour,
    finish,
  );
}

/** A rectangle's outline with its corners rounded by `r`, in `steps` straight pieces each. */
export function rounded(x: number, y: number, w: number, d: number, r: number, steps = 4): P2[] {
  const rr = Math.max(0, Math.min(r, w / 2, d / 2));
  if (rr === 0) return [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
  const corners: Array<[number, number, number]> = [
    [x + w - rr, y + rr, -Math.PI / 2],
    [x + w - rr, y + d - rr, 0],
    [x + rr, y + d - rr, Math.PI / 2],
    [x + rr, y + rr, Math.PI],
  ];
  const pts: P2[] = [];
  for (const [cx, cy, from] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = from + (i / steps) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  }
  return pts;
}

/** A circle's outline, as a polygon of `steps` corners. */
export function circle(cx: number, cy: number, r: number, steps = 24): P2[] {
  return Array.from({ length: steps }, (_, i): P2 => {
    const a = (i / steps) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

/** Paints on the four sides of a box, each in that side's own centimetres: `u` across it as seen from
 *  outside, `v` up from its bottom edge. */
export type SidePaints = Partial<Record<Side, Paint>>;

/** A box — rounded at its corners in plan by `round` — with paints on its top and its sides. */
export function box(
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  colour: string,
  more: Finish & { round?: number; faces?: SidePaints } = {},
): Part {
  const part = extrude(rounded(x, y, w, d, more.round ?? 0), z, h, colour, more);
  if (!('faces' in part) || !more.faces) return part;
  const frames: Record<Side, { n: V3; frame: [V3, V3, V3] }> = {
    s: { n: [0, 1, 0], frame: [[x, y + d, z], [x + 1, y + d, z], [x, y + d, z + 1]] },
    n: { n: [0, -1, 0], frame: [[x + w, y, z], [x + w - 1, y, z], [x + w, y, z + 1]] },
    e: { n: [1, 0, 0], frame: [[x + w, y + d, z], [x + w, y + d - 1, z], [x + w, y + d, z + 1]] },
    w: { n: [-1, 0, 0], frame: [[x, y, z], [x, y + 1, z], [x, y, z + 1]] },
  };
  for (const side of Object.keys(more.faces) as Side[]) {
    const draw = more.faces[side];
    if (!draw) continue;
    const { n, frame } = frames[side];
    // The flat face of that side: on a rounded box the longest of those that look exactly that way.
    let best: Face | null = null;
    let bestLength = -1;
    for (const face of part.faces) {
      if (dot(face.n, n) < 0.999) continue;
      const length = Math.hypot(...sub(face.pts[1], face.pts[0]));
      if (length > bestLength) {
        best = face;
        bestLength = length;
      }
    }
    if (best) best.paint = { draw, frame };
  }
  return part;
}

/**
 * A side view pulled through the piece: `profile` is drawn in the plane across `axis` — `(y, z)` for `'x'`,
 * `(x, z)` for `'y'` — and stretched from `from` for `length` along it. Need not be convex: a profile is free to
 * be an L, a shell or a sofa.
 */
export function prism(profile: P2[], axis: 'x' | 'y', from: number, length: number, colour: string, finish: Finish = {}): Part {
  const at = (along: number, [u, v]: P2): V3 => (axis === 'x' ? [along, u, v] : [u, along, v]);
  const turn = area2(profile) > 0 ? 1 : -1;
  const faces: Face[] = [];
  const ends: Array<[number, number]> = [
    [from, -1],
    [from + length, 1],
  ];
  for (const [along, sign] of ends) {
    faces.push({ pts: profile.map(p => at(along, p)), n: axis === 'x' ? [sign, 0, 0] : [0, sign, 0] });
  }
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    const du = b[0] - a[0];
    const dv = b[1] - a[1];
    const length2 = Math.hypot(du, dv);
    if (length2 < 1e-6) continue;
    // Outward, for an outline running counter-clockwise: the edge turned a quarter clockwise.
    const nu = (turn * dv) / length2;
    const nv = (-turn * du) / length2;
    faces.push({
      pts: [at(from, a), at(from, b), at(from + length, b), at(from + length, a)],
      n: axis === 'x' ? [0, nu, nv] : [nu, 0, nv],
    });
  }
  return { faces, colour, soft: finish.soft };
}

/** An upright cylinder, or a cone cut off at `r2` when the top is narrower than the foot. */
export function cyl(x: number, y: number, z: number, r: number, h: number, colour: string, finish: Finish & { r2?: number } = {}): Part {
  const steps = r > 8 ? 28 : 16;
  return loft(
    circle(x, y, r, steps).map(([px, py]) => [px, py, z] as V3),
    circle(x, y, finish.r2 ?? r, steps).map(([px, py]) => [px, py, z + h] as V3),
    colour,
    finish,
  );
}

export function ball(x: number, y: number, z: number, r: number, colour: string): Part {
  return { ball: { x, y, z, r }, colour };
}

/** A straight bar on the floor plan from `(x1, y1)` to `(x2, y2)`, `width` wide, from `z` for `h`: a star
 *  foot's arm, a slat at an angle. */
export function bar(x1: number, y1: number, x2: number, y2: number, width: number, z: number, h: number, colour: string): Part {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (-(y2 - y1) / length) * (width / 2);
  const ny = ((x2 - x1) / length) * (width / 2);
  return extrude(
    [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ],
    z,
    h,
    colour,
  );
}

/** A leg from a point under a top down to a point on the floor, square in section and as thick as `size`: a
 *  splayed leg when the two differ, a plain one when they do not. `taper` thins it towards the floor. */
export function leg(top: V3, foot: P2, size: number, colour: string, taper = 1): Part {
  const square = (cx: number, cy: number, z: number, s: number): V3[] => [
    [cx - s / 2, cy - s / 2, z],
    [cx + s / 2, cy - s / 2, z],
    [cx + s / 2, cy + s / 2, z],
    [cx - s / 2, cy + s / 2, z],
  ];
  return loft(square(foot[0], foot[1], 0, size * taper), square(top[0], top[1], top[2], size), colour);
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────────

/** How a facing turns a piece: south is no turn, the others quarter turns of it, as the plan means them. */
export const TURN: Record<string, number> = { south: 0, west: Math.PI / 2, north: Math.PI, east: -Math.PI / 2 };

/** How a view projects: pixels per centimetre across, the squash of depth, the rise of height. */
export type Projection = { k: number; squash: number; rise: number };

type Point = [number, number];

/** Where the light comes from: above, a little from the west and a little from the north — the upper left of
 *  the screen, as everywhere in the office. */
const LIGHT = unit([-0.45, -0.25, 0.86]);
const UP_LIT = LIGHT[2];

/** The colour a face of `colour` takes facing `n`: a top shows its own colour, everything else is darker by
 *  how far it turns from the light. Gentle things turn less. */
function lit(colour: string, n: V3, soft: boolean | undefined): string {
  const amount = (dot(n, LIGHT) - UP_LIT) * (soft ? 0.1 : 0.26);
  return Math.abs(amount) < 0.004 ? colour : shade(colour, Math.max(-0.4, amount));
}

/** A part placed for a view: its faces' points turned, and its extent, which decides what covers what. */
type Placed = {
  part: Part;
  min: V3;
  max: V3;
  /** How near the viewer its middle is: what decides when nothing else does. */
  near: number;
};

/**
 * The order the parts are drawn in, back to front. A part resting on another is drawn after it; a part wholly
 * north of another before it; parts that never share a column of the screen in either order. That is a
 * partial order — sorted by repeatedly taking a part nothing still undrawn must precede, nearest-last among
 * equals, and by nearness alone if parts that cut into each other ever make a ring of it.
 */
function backToFront(placed: Placed[]): Placed[] {
  const eps = 0.01;
  const n = placed.length;
  const after: number[][] = Array.from({ length: n }, () => []);
  const waiting = new Array<number>(n).fill(0);
  const overlaps = (a: Placed, b: Placed, axis: number): boolean => a.min[axis] < b.max[axis] - eps && b.min[axis] < a.max[axis] - eps;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!overlaps(a, b, 0)) continue;
      let first: number | null = null;
      if (overlaps(a, b, 1) && a.max[2] <= b.min[2] + eps) first = i;
      else if (overlaps(a, b, 1) && b.max[2] <= a.min[2] + eps) first = j;
      else if (a.max[1] <= b.min[1] + eps) first = i;
      else if (b.max[1] <= a.min[1] + eps) first = j;
      if (first === null) continue;
      const second = first === i ? j : i;
      after[first].push(second);
      waiting[second]++;
    }
  }
  const done = new Array<boolean>(n).fill(false);
  const order: Placed[] = [];
  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (done[i] || waiting[i] > 0) continue;
      if (pick < 0 || placed[i].near < placed[pick].near) pick = i;
    }
    if (pick < 0) {
      for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || placed[i].near < placed[pick].near)) pick = i;
    }
    done[pick] = true;
    order.push(placed[pick]);
    for (const next of after[pick]) waiting[next]--;
  }
  return order;
}

/** How a piece is turned: a facing the plan names, exactly a quarter turn; or any angle, in radians, from
 *  south towards west — a person in three-quarter view. */
function turnOf(facing: string | number): [number, number] {
  if (typeof facing === 'number') return [Math.cos(facing), Math.sin(facing)];
  const turn = TURN[facing] ?? 0;
  return [Math.round(Math.cos(turn)), Math.round(Math.sin(turn))];
}

/** Draws a piece with the centre of its footprint at the canvas's origin. */
export function drawPiece(g: CanvasRenderingContext2D, piece: Piece, facing: string | number, p: Projection): void {
  const [cos, sin] = turnOf(facing);
  const turned = (v: V3): V3 => {
    const dx = v[0] - piece.w / 2;
    const dy = v[1] - piece.d / 2;
    return [dx * cos - dy * sin, dx * sin + dy * cos, v[2]];
  };
  const turnedNormal = (n: V3): V3 => [n[0] * cos - n[1] * sin, n[0] * sin + n[1] * cos, n[2]];
  const screen = (t: V3): Point => [t[0] * p.k, t[1] * p.k * p.squash - t[2] * p.k * p.rise];
  const toViewer: V3 = [0, p.rise, p.squash];
  const nearness = (t: V3): number => dot(t, toViewer);
  const base = g.getTransform();

  const placed: Placed[] = piece.parts.map(part => {
    if ('ball' in part) {
      const { x, y, z, r } = part.ball;
      const c = turned([x, y, z]);
      return { part, min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r], near: nearness(c) };
    }
    const pts = part.faces.flatMap(face => face.pts.map(turned));
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const t of pts) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], t[i]);
        max[i] = Math.max(max[i], t[i]);
      }
    }
    return { part, min, max, near: nearness(mean(pts)) };
  });

  for (const { part } of backToFront(placed)) {
    g.setTransform(base);
    if ('ball' in part) {
      const { x, y, z, r } = part.ball;
      const [cx, cy] = screen(turned([x, y, z]));
      const rr = r * p.k;
      // Lit from the upper left like every face: a broad lit side and a soft dark one, no gloss.
      const round = g.createRadialGradient(cx - rr * 0.4, cy - rr * 0.45, rr * 0.1, cx, cy, rr * 1.05);
      round.addColorStop(0, shade(part.colour, 0.12));
      round.addColorStop(0.55, part.colour);
      round.addColorStop(1, shade(part.colour, -0.24));
      g.fillStyle = round;
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    const seen = part.faces
      .map(face => ({ face, n: turnedNormal(face.n), pts: face.pts.map(turned) }))
      .filter(({ n }) => dot(n, toViewer) > 1e-3)
      .sort((a, b) => nearness(mean(a.pts)) - nearness(mean(b.pts)));
    for (const { face, n, pts } of seen) {
      const fill = lit(part.colour, n, part.soft);
      g.beginPath();
      pts.forEach((t, i) => {
        const [sx, sy] = screen(t);
        if (i === 0) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
      });
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      // The same colour once round the edge, so two faces meet without a hairline of background between them.
      g.strokeStyle = fill;
      g.lineWidth = 0.6;
      g.lineJoin = 'round';
      g.stroke();
      if (face.paint) {
        const [o, u, v] = face.paint.frame.map(q => screen(turned(q)));
        g.save();
        g.clip();
        g.transform(u[0] - o[0], u[1] - o[1], v[0] - o[0], v[1] - o[1], o[0], o[1]);
        face.paint.draw(g);
        g.restore();
      }
    }
  }
  g.setTransform(base);
}

/**
 * How far a piece reaches on screen from the centre of its footprint, so a canvas can be cut to fit it:
 * left, up, right and down, in pixels. Measured by projecting every corner of every part.
 */
export function reachOf(piece: Piece, facing: string | number, p: Projection): { left: number; up: number; right: number; down: number } {
  const [cos, sin] = turnOf(facing);
  const at = ([x, y, z]: V3): Point => {
    const dx = x - piece.w / 2;
    const dy = y - piece.d / 2;
    return [(dx * cos - dy * sin) * p.k, (dx * sin + dy * cos) * p.k * p.squash - z * p.k * p.rise];
  };
  const xs: number[] = [];
  const ys: number[] = [];
  const add = ([px, py]: Point, pad = 0) => {
    xs.push(px - pad, px + pad);
    ys.push(py - pad, py + pad);
  };
  for (const part of piece.parts) {
    if ('ball' in part) add(at([part.ball.x, part.ball.y, part.ball.z]), part.ball.r * p.k);
    else for (const face of part.faces) for (const q of face.pts) add(at(q));
  }
  return { left: -Math.min(...xs), up: -Math.min(...ys), right: Math.max(...xs), down: Math.max(...ys) };
}
