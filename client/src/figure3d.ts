// The modelled figure, kept beside the other styles on the art sheet to compare.

import { shade } from './colour';
import { RISE, SQUASH } from './depth';
import type { Facing, PartKey } from './figure';
import { ball, bar, cyl, drawPiece, loft, reachOf, type Paint, type Part, type Piece, type V3 } from './piece';
import type { Palette } from './wire';

// ── the body ─────────────────────────────────────────────────────────────────────────────────────────
// A person is modelled as the furniture is — a small solid in centimetres, drawn by `piece.ts` in the same
// light and from the same angle — so people and chairs belong to one world. Somebody is 1.70 m tall; `r`, the
// size `drawFigure` is asked for, is half a shoulder width, 33 cm, and fixes the scale.

/** Half a shoulder width, in centimetres: what `r` is in the model. */
const R_CM = 33;
/** The head: its centre's height and its radius, in centimetres. */
const HEAD_Z = 159;
const HEAD_CM = 14;
/** How far the face is turned up towards the viewer, in radians (see `onFace`). */
const FACE_TILT = 0.45;


/** Whether a figure of `r` has a head big enough for a mouth to be seen on it. Where it has not, the ring on
 *  the floor says it instead — one signal, read the size you are looking from. */
function mouthFits(r: number): boolean {
  return (r * HEAD_CM) / R_CM >= 5;
}

/**
 * How far a figure is turned from facing the viewer, in radians. East and west are a three-quarter view, not
 * a profile: whoever walks to the side still shows both eyes and their mouth, which is what a voice is read
 * from.
 */
const TURNS: Record<Facing, number> = { south: 0, north: Math.PI, east: -Math.PI / 4, west: Math.PI / 4 };

const SHOE = '#3a3633';
/** The ink a figure is outlined in, once, round the whole of it: what keeps a person readable on a floor full
 *  of furniture that has no outline. */
const INK = '#4a4038';

/** A ring round `(cx, cy)` at height `z`, `rx` across and `ry` deep: a section of a limb or a body. */
function ring(cx: number, cy: number, z: number, rx: number, ry: number, steps = 10): V3[] {
  return Array.from({ length: steps }, (_, i): V3 => {
    const a = (i / steps) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, z];
  });
}

/** A limb from one point to another, round in section, `r1` thick at the first and `r2` at the second. */
const limb = (from: V3, to: V3, r1: number, r2: number, colour: string): Part =>
  loft(ring(from[0], from[1], from[2], r1, r1, 8), ring(to[0], to[1], to[2], r2, r2, 8), colour);

/**
 * A person as a piece: facing south, feet at the middle of a 60 cm footprint. `stride` is −1…1 through a step:
 * a leg swings forward as the arm on its side swings back. The face is not part of it — it is painted on the
 * head afterwards (`onFace`), because it moves while the body stands.
 */
function body(palette: Palette, parts: Record<PartKey, string>, stride: number): Piece {
  const c = 30;
  const shoulders = parts.body === 'broad' ? 44 : parts.body === 'slight' ? 33 : 38;
  const hips = parts.body === 'broad' ? 33 : parts.body === 'slight' ? 26 : 29;
  const pieces: Part[] = [];

  for (const side of [-1, 1]) {
    const swing = stride * side;
    const x = c + side * hips * 0.26;
    const foot = c + swing * 15;
    const lift = Math.max(0, swing) * 4;
    pieces.push(loft(ring(x, foot + 3, lift, 5, 8.5), ring(x, foot + 2, lift + 6, 4.6, 7), SHOE));
    pieces.push(limb([x, foot, lift + 6], [x, c, 82], 4.6, 7.2, palette.trousers));
  }
  // The hips in the trousers, the body in the shirt, rounding in to the shoulders and the neck.
  pieces.push(loft(ring(c, c, 78, hips / 2, 9.5, 12), ring(c, c, 92, hips / 2, 9.5, 12), palette.trousers));
  pieces.push(loft(ring(c, c, 92, hips / 2 - 0.5, 9.5, 12), ring(c, c, 131, shoulders / 2, 11, 12), palette.shirt));
  pieces.push(loft(ring(c, c, 131, shoulders / 2, 11, 12), ring(c, c, 141, shoulders / 2 - 7, 7.5, 12), palette.shirt));

  for (const side of [-1, 1]) {
    const swing = -stride * side;
    const from: V3 = [c + side * (shoulders / 2 - 3.5), c, 132];
    if (parts.arms === 'folded') {
      // Upper arms down to the elbows; the forearms crossed in front, as one bar.
      pieces.push(limb(from, [c + side * (shoulders / 2 - 1), c + 6, 108], 4.6, 4.2, palette.shirt));
    } else {
      const open = parts.arms === 'open';
      const hand: V3 = [c + side * (shoulders / 2 + (open ? 15 : 2)), c + swing * 13 + (open ? 4 : 0), open ? 94 : 86];
      pieces.push(limb(from, hand, 4.6, 3.6, palette.shirt));
      pieces.push(ball(hand[0], hand[1], hand[2] - 3, 4.2, palette.skin));
    }
  }
  if (parts.arms === 'folded') {
    pieces.push(bar(c - shoulders / 2 + 1, c + 11, c + shoulders / 2 - 1, c + 11, 8.5, 104, 8, palette.shirt));
    for (const side of [-1, 1]) pieces.push(ball(c + side * (shoulders / 2 - 9), c + 15, 108, 3.6, palette.skin));
  }

  pieces.push(cyl(c, c, 140, 4.6, 6, palette.skin));
  pieces.push(ball(c, c, HEAD_Z, HEAD_CM, palette.skin));
  if (parts.head !== 'bald') {
    // Hair over the whole head, a little larger and higher than it, so it is drawn after it from every side;
    // the face is cleared out of it again afterwards (`revealFace`).
    pieces.push(ball(c, c - 1, 160.5, 14.8, palette.hair));
    if (parts.head === 'oval') {
      // Long hair falls behind to the shoulders and rests on them.
      pieces.push(loft(ring(c, c - 3, 141.5, 15.5, 9.5, 12), ring(c, c - 2.5, 161, 14.5, 11, 12), palette.hair));
    }
  }
  return { w: 2 * c, d: 2 * c, parts: pieces };
}

/** A figure drawn once for a view and kept: the solid, outlined, on a canvas of its own. */
type Sprite = { canvas: HTMLCanvasElement; ox: number; oy: number; w: number; h: number; k: number };
const sprites = new Map<string, Sprite>();

function sprite(palette: Palette, parts: Record<PartKey, string>, turn: number, r: number, stride: number, dpr: number): Sprite {
  // Sizes in steps of about three percent, a step in quarters: few enough to keep, too close to tell apart.
  const k = 2 ** (Math.round(Math.log2(r / R_CM) * 24) / 24);
  const step = Math.round(stride * 4) / 4;
  const key = `${palette.skin}${palette.hair}${palette.shirt}${palette.trousers}|${parts.head}${parts.body}${parts.arms}|${turn}|${step}|${k}|${dpr}|${RISE}`;
  const have = sprites.get(key);
  if (have) return have;
  if (sprites.size > 400) sprites.clear();

  const piece = body(palette, parts, step);
  const projection = { k: k * dpr, squash: SQUASH, rise: RISE };
  const reach = reachOf(piece, turn, projection);
  const ink = Math.max(1, 1.4 * k * dpr);
  const pad = Math.ceil(ink) + 2;
  const w = Math.ceil(reach.left + reach.right) + pad * 2;
  const h = Math.ceil(reach.up + reach.down) + pad * 2;
  const solid = document.createElement('canvas');
  solid.width = w;
  solid.height = h;
  const g = solid.getContext('2d')!;
  g.translate(reach.left + pad, reach.up + pad);
  drawPiece(g, piece, turn, projection);
  if (parts.head !== 'bald') revealFace(g, palette.skin, turn, k * dpr);

  // The outline: the solid stamped round itself in ink, then the solid on top.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const o = canvas.getContext('2d')!;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    o.drawImage(solid, Math.cos(a) * ink, Math.sin(a) * ink);
  }
  o.globalCompositeOperation = 'source-in';
  o.fillStyle = INK;
  o.fillRect(0, 0, w, h);
  o.globalCompositeOperation = 'source-over';
  o.drawImage(solid, 0, 0);

  const made = { canvas, ox: (reach.left + pad) / dpr, oy: (reach.up + pad) / dpr, w: w / dpr, h: h / dpr, k };
  sprites.set(key, made);
  return made;
}

/**
 * Paints on the head, as a decal on its surface: `paint` draws in centimetres of the face — `u` across to the
 * figure's left, `v` up — at a point `across` radians round from the front and `up` radians above the middle.
 * The decal turns and foreshortens with the head, the way the furniture's paints do with their faces, and a
 * point turned away from the viewer is not painted at all. `(x, y)` are the feet, `k` pixels per centimetre.
 *
 * The whole face is lifted by `FACE_TILT` towards the viewer: seen from 40° above, a face set where a real
 * one is would be a strip under the crown, so everybody looks up a little, as people do at a camera.
 */
function onFace(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, turn: number, across: number, level: number, paint: Paint): void {
  const up = level + FACE_TILT;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const turned = ([a, b, c]: V3): V3 => [a * cos - b * sin, a * sin + b * cos, c];
  const n = turned([Math.sin(across) * Math.cos(up), Math.cos(across) * Math.cos(up), Math.sin(up)]);
  // Facing away, or so nearly edge-on that the decal would be a smear: left out.
  if (n[1] * RISE + n[2] * SQUASH < 0.05) return;
  const u = turned([Math.cos(across), -Math.sin(across), 0]);
  const v = turned([-Math.sin(across) * Math.sin(up), -Math.cos(across) * Math.sin(up), Math.cos(up)]);
  const at: V3 = [n[0] * HEAD_CM, n[1] * HEAD_CM, HEAD_Z + n[2] * HEAD_CM];
  const screen = ([a, b, c]: V3): [number, number] => [x + a * k, y + b * k * SQUASH - c * k * RISE];
  const [ox, oy] = screen(at);
  const [ux, uy] = screen([at[0] + u[0], at[1] + u[1], at[2] + u[2]]);
  const [vx, vy] = screen([at[0] + v[0], at[1] + v[1], at[2] + v[2]]);
  ctx.save();
  ctx.transform(ux - ox, uy - oy, vx - ox, vy - oy, ox, oy);
  paint(ctx);
  ctx.restore();
}

/**
 * Clears the face out of the hair: an oval on the front of the head, filled with the head's own skin and its
 * own light — the same gradient `piece.ts` lights a ball with — and kept inside the head's outline. `g` is
 * drawn on from the feet, `k` pixels per centimetre.
 */
function revealFace(g: CanvasRenderingContext2D, skin: string, turn: number, k: number): void {
  const hx = 0;
  const hy = -HEAD_Z * k * RISE;
  const hr = HEAD_CM * k;
  const base = g.getTransform();
  const lit = g.createRadialGradient(hx - hr * 0.4, hy - hr * 0.45, hr * 0.1, hx, hy, hr * 1.05);
  lit.addColorStop(0, shade(skin, 0.12));
  lit.addColorStop(0.55, skin);
  lit.addColorStop(1, shade(skin, -0.24));
  g.save();
  g.beginPath();
  g.arc(hx, hy, hr, 0, Math.PI * 2);
  g.clip();
  onFace(g, 0, 0, k, turn, 0, -0.12, face => {
    face.beginPath();
    face.ellipse(0, 0, 9.6, 11, 0, 0, Math.PI * 2);
    // Back to the canvas's own space before filling, so the light is the head's and not the oval's.
    face.setTransform(base);
    face.fillStyle = lit;
    face.fill();
  });
  g.restore();
}

const dot = (u: number, v: number, rx: number, ry: number, colour: string): Paint => g => {
  g.fillStyle = colour;
  g.beginPath();
  g.ellipse(u, v, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
};

/** An eye: dark, a little taller than wide, with the light caught in it at the upper left. */
const EYE: Paint = g => {
  dot(0, 0, 1.45, 1.9, '#2a221c')(g);
  dot(-0.5, 0.7, 0.55, 0.55, 'rgba(255, 255, 255, 0.85)')(g);
};
const CHEEK = dot(0, 0, 2.4, 1.4, 'rgba(230, 120, 110, 0.22)');
/** A face at rest: a small smile, nothing that reads as a mood stronger than being glad to be there. */
const SMILE: Paint = g => {
  g.strokeStyle = 'rgba(60, 30, 26, 0.8)';
  g.lineWidth = 0.7;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-2.1, 0.45);
  g.quadraticCurveTo(0, -1.4, 2.1, 0.45);
  g.stroke();
};
/** A mouth speaking: `open` 0…1 how far the jaw has dropped, `wide` 0…1 how far the lips are drawn back. */
const speakingMouth = (open: number, wide: number): Paint => g => {
  const w = 1.9 + 0.8 * wide;
  const h = 0.6 + 2.3 * open;
  dot(0, -h * 0.35, w, h, 'rgba(58, 22, 22, 0.95)')(g);
  if (open > 0.35) dot(0, -h * 0.85, w * 0.55, h * 0.4, '#b5585a')(g);
};

/**
 * Draws one person with their feet at `(x, y)`. `r` is half the shoulder width in pixels, so the figure is
 * `FIGURE_HEIGHT_R` times `r` tall. `stride` is −1…1 through a step, 0 standing. `mine` adds the ring only
 * my own client draws. `speaking` opens and closes the mouth — only where `mouthFits`.
 */
export function drawFigure3d(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  facing: Facing | number,
  palette: Palette,
  parts: Record<PartKey, string>,
  mine: boolean,
  stride = 0,
  speaking = false,
  now = 0,
): void {
  ctx.fillStyle = 'rgba(48, 40, 30, 0.24)';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.62, r * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  if (mine) {
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // A facing the plan names is one of the four turns above; a number is the turn itself, as a turned view
  // sees it (`people.ts`).
  const turn = typeof facing === 'number' ? facing : TURNS[facing];
  const dpr = ctx.getTransform().a || 1;
  const shown = sprite(palette, parts, turn, r, stride, dpr);
  // The sprite was drawn at a step of the size; drawn now at the exact one.
  const scale = r / R_CM / shown.k;
  ctx.drawImage(shown.canvas, x - shown.ox * scale, y - shown.oy * scale, shown.w * scale, shown.h * scale);

  // The face, painted on the head: too small to see, it is left out rather than smudged in.
  const k = r / R_CM;
  if (HEAD_CM * k < 4) return;
  for (const side of [-1, 1]) {
    onFace(ctx, x, y, k, turn, side * 0.66, -0.22, CHEEK);
    onFace(ctx, x, y, k, turn, side * 0.36, 0.12, EYE);
  }
  if (speaking && mouthFits(r)) {
    // Two beats: the jaw drops and lifts on one, the lips narrow and widen on another. One beat alone reads as
    // a face changing its mind between serious and smiling rather than as a voice.
    onFace(ctx, x, y, k, turn, 0, -0.3, speakingMouth(Math.abs(Math.sin(now / 105)), 0.5 + 0.5 * Math.sin(now / 57)));
  } else {
    onFace(ctx, x, y, k, turn, 0, -0.3, SMILE);
  }
}
