/**
 * The figure a person is: their parts, their colours, and how that becomes a body on the canvas. Drawn from
 * code rather than loaded, so it stays sharp at any zoom and carries no licence but this repository's. A name
 * the drawing does not know falls back to the default, so nobody is ever undrawable.
 */

import { shade } from './colour';
import type { Figure, Palette } from './wire';
import { drawFigure3d } from './figure3d';
import { host } from './host';

/** The four ways a floor has, which is all a top-down figure can face. */
export type Facing = 'north' | 'east' | 'south' | 'west';

export type PartKey = 'head' | 'body' | 'arms';
export type PaletteKey = 'skin' | 'hair' | 'shirt' | 'trousers';

/**
 * The styles each part is drawn in, kept in step with `crates/wire/src/figure.rs`, which refuses a name it
 * does not know. The first of each is the default. A style changes a shape, never only a shade.
 */
export const PART_STYLES: Record<PartKey, readonly string[]> = {
  head: ['round', 'oval', 'bald'],
  body: ['plain', 'broad', 'slight'],
  arms: ['sides', 'folded', 'open'],
};

/** The style each part draws as when nothing was chosen. The same three the server's `None` means. */
export const DEFAULT_PART: Record<PartKey, string> = { head: 'round', body: 'plain', arms: 'sides' };

/** What a figure wears when nothing arrived with it, so every client draws the same thing. */
export const DEFAULT_PALETTE: Palette = {
  skin: '#e8b98c',
  hair: '#3a2a20',
  shirt: '#38bdf8',
  trousers: '#334155',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A colour off the wire, or the fallback — a typo leaves somebody in the default colours, not invisible. */
export function colour(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && HEX.test(value) ? value : fallback;
}

export function paletteOf(figure?: Figure): Palette {
  return {
    skin: colour(figure?.palette?.skin, DEFAULT_PALETTE.skin),
    hair: colour(figure?.palette?.hair, DEFAULT_PALETTE.hair),
    shirt: colour(figure?.palette?.shirt, DEFAULT_PALETTE.shirt),
    trousers: colour(figure?.palette?.trousers, DEFAULT_PALETTE.trousers),
  };
}

export function partsOf(figure?: Figure): Record<PartKey, string> & Extras {
  return {
    head: styleOf(figure?.parts?.head, 'head'),
    body: styleOf(figure?.parts?.body, 'body'),
    arms: styleOf(figure?.parts?.arms, 'arms'),
    top: figure?.parts?.top ?? undefined,
    extra: figure?.parts?.extra ?? undefined,
  };
}

function styleOf(name: string | null | undefined, part: PartKey): string {
  return typeof name === 'string' && PART_STYLES[part].includes(name) ? name : DEFAULT_PART[part];
}

/**
 * A figure with one colour set, or `null` when the colour is not one a canvas can paint. Refused rather than
 * repaired: the same rule the server keeps.
 */
export function withColour(figure: Figure, key: PaletteKey, value: string): Figure | null {
  if (!HEX.test(value)) return null;
  // The rest of the palette is kept as it arrived, not filled in: a whole figure stays whole.
  const palette = { ...(figure.palette ?? DEFAULT_PALETTE), [key]: value };
  return { ...figure, palette };
}

export function withPart(figure: Figure, part: PartKey, name: string): Figure | null {
  if (!PART_STYLES[part].includes(name)) return null;
  return { ...figure, parts: { ...figure.parts, [part]: name } };
}

/**
 * The way somebody is walking: the longer axis of the step, so a diagonal is mostly one direction. No step
 * keeps the previous facing, which stops a standing figure spinning.
 */
export function facingFrom(dx: number, dy: number, previous: Facing): Facing {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return previous;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
}

/** The way a facing points, in plan metres. Rows grow downward, so north is -1. */
export function facingVector(facing: Facing): [number, number] {
  switch (facing) {
    case 'north':
      return [0, -1];
    case 'east':
      return [1, 0];
    case 'south':
      return [0, 1];
    case 'west':
      return [-1, 0];
  }
}

// ── the drawing ──────────────────────────────────────────────────────────────────────────────────────
// A person is a flat illustration: clear shapes in their own colours, no outline, and a second, darker tone
// where the light does not reach — the far leg, under the chin, the side away from the upper left. Drawn in
// units of `r` with y pointing up from the feet, so every number below is a proportion of the figure.

/** How tall a figure stands, in multiples of its `r`: what anything placed above a head measures from. */
export const FIGURE_HEIGHT_R = 3.45;

/** Heights, from the feet up, in units of `r`. */
const SHOE = 0.1;
let HIP = 1.46;
let SHOULDER = 2.55;
let HEAD_Y = 2.98;
/** The head's radius: large enough to carry a face at the size the office is usually seen at. */
let HR = 0.37;
/** How large the eyes are drawn, against the flat style's. */
let EYES = 1;

// The styles an office can wear. The app starts in `bean`, a browser tab in `flat`, `?figur=` tries any of
// them in the office, and the art sheet puts them side by side.
export type FigureStyle = 'flat' | 'cute' | 'ink' | 'pictogram' | 'bean' | 'pixel' | 'paper' | '3d';
let STYLE: FigureStyle = 'flat';
let INK = false;
export function setFigureStyle(style: FigureStyle): void {
  STYLE = style;
  INK = style === 'ink';
  const cute = style === 'cute' || style === 'pixel';
  HIP = cute ? 0.95 : 1.46;
  SHOULDER = cute ? 1.78 : 2.55;
  HR = cute ? 0.66 : 0.37;
  HEAD_Y = cute ? 2.55 : 2.98;
  EYES = cute ? 1.6 : 1;
}
// `?figur=bean` on the office's own page tries a style in action, as `?winkel=` tries an angle.
const STYLES: readonly FigureStyle[] = ['flat', 'cute', 'ink', 'pictogram', 'bean', 'pixel', 'paper', '3d'];

/**
 * The style a client wears when nobody has chosen one. The app has its own drawing and wears the bean; a
 * browser tab, which shares its page with eight other styles on the art sheet, stays flat.
 */
export function defaultStyle(shell: boolean): FigureStyle {
  return shell ? 'bean' : 'flat';
}

const asked = new URLSearchParams(globalThis.location?.search ?? '').get('figur') as FigureStyle | null;
// Without a window there is no shell to ask — a test, or a build step. Then the flat style stands.
const shell = typeof window !== 'undefined' && host().kind === 'shell';
setFigureStyle(asked && STYLES.includes(asked) ? asked : defaultStyle(shell));

/**
 * What somebody wears who chose nothing — a hairstyle, a garment and one thing more, read off their
 * id, so a room of people who never opened the editor is still a room of different people. Belongs on the
 * server (`Figure::for_id`) once the vocabulary is on the wire.
 */
export function partsFor(id: number, figure?: Figure): Record<PartKey, string> & Extras {
  const chosen = partsOf(figure);
  const p = figure?.parts;
  if (p && (p.head || p.body || p.arms || p.top || p.extra)) return chosen;
  const hairs = ['round', 'oval', 'curly', 'bun', 'bob', 'ponytail', 'bald'];
  const tops = ['tee', 'hoodie', 'sweater', 'blazer', 'dress', 'tee'];
  const extras = ['none', 'glasses', 'none', 'headphones', 'beard', 'none', 'glasses'];
  const builds = ['plain', 'slight', 'broad'];
  const poses = ['sides', 'sides', 'folded', 'open'];
  return {
    head: hairs[id % hairs.length],
    body: builds[(id * 5) % builds.length],
    arms: poses[(id * 3) % poses.length],
    top: tops[(id * 7) % tops.length],
    extra: extras[(id * 11) % extras.length],
  };
}
const INK_LINE = 0.035;
const INK_COLOUR = '#24201d';

/** Whether a figure of `r` has a head big enough for a mouth to be seen on it. Where it has not, the ring on
 *  the floor says it instead — one signal, read the size you are looking from. */
export function mouthFits(r: number): boolean {
  return r * HR >= 5;
}

/** What a person wears beyond the three parts every figure has: the garment and one thing more. */
export type Extras = { top?: string; extra?: string };

const SHOE_COLOUR = '#34302d';
const INNER = '#f6f4ef';

type View = 'front' | 'side' | 'back';
type G = CanvasRenderingContext2D;

const fill = (g: G, colour: string, path: () => void): void => {
  g.beginPath();
  path();
  g.fillStyle = colour;
  g.fill();
  if (INK) {
    g.strokeStyle = INK_COLOUR;
    g.lineWidth = INK_LINE;
    g.lineJoin = 'round';
    g.stroke();
  }
};

/** A limb as a thick round-ended stroke through its points: the simplest shape that still reads as an arm. */
const limb = (g: G, colour: string, width: number, ...pts: Array<[number, number]>): void => {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (INK && width > 0.05) {
    g.strokeStyle = INK_COLOUR;
    g.lineWidth = width + INK_LINE * 2;
    g.stroke();
  }
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.stroke();
};

/** `shape` again in `colour`, but only on the side away from the light: right of `from`. */
const shadeRight = (g: G, colour: string, from: number, shape: () => void): void => {
  if (INK || STYLE === 'cute') return;
  g.save();
  g.beginPath();
  shape();
  g.clip();
  g.fillStyle = colour;
  g.fillRect(from, -1, 10, 10);
  g.restore();
};

/** The drawn view nearest a turn from facing the viewer: the front near it, the back from square on round,
 *  and the three-quarter view between — its face in sight. */
function facingOfTurn(turn: number): Facing {
  const t = Math.atan2(Math.sin(turn), Math.cos(turn));
  if (Math.abs(t) <= Math.PI / 8) return 'south';
  if (Math.abs(t) >= Math.PI / 2) return 'north';
  return t > 0 ? 'west' : 'east';
}

/**
 * Draws one person with their feet at `(x, y)`. `r` sets the size, and the figure is `FIGURE_HEIGHT_R` times
 * `r` tall. `stride` is −1…1 through a step, 0 standing. `mine` adds the ring only my own client draws.
 * `speaking` opens and closes the mouth — only where `mouthFits`. East and west are a three-quarter view, not
 * a profile, so a face and its mouth stay in sight from every side but the back.
 *
 * `pose` is a facing the plan names, or a turn in radians from facing the viewer — positive towards the
 * viewer's left — as a turned view sees a figure. The modelled figure takes the turn as it is; the drawn
 * styles have their four views and take the nearest.
 */
export function drawFigure(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  pose: Facing | number,
  palette: Palette,
  parts: Record<PartKey, string> & Extras,
  mine: boolean,
  stride = 0,
  speaking = false,
  now = 0,
): void {
  if (STYLE === '3d') return drawFigure3d(ctx, x, y, r, pose, palette, parts, mine, stride, speaking, now);
  const facing = typeof pose === 'number' ? facingOfTurn(pose) : pose;
  ctx.fillStyle = 'rgba(48, 40, 30, 0.22)';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.6, r * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  if (mine) {
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.05, r * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const view: View = facing === 'south' ? 'front' : facing === 'north' ? 'back' : 'side';
  const talking = speaking && mouthFits(r) ? now : null;
  if (STYLE === 'pixel' || STYLE === 'paper') {
    // Drawn on a canvas of its own first: at a few pixels and blown up hard for pixel art; at full size and
    // edged in white paper, lifted off the floor by its shadow, for the paper cut-out.
    const dpr = ctx.getTransform().a || 1;
    const pixel = STYLE === 'pixel';
    const rr = pixel ? Math.max(5, r / 2.6) : r * dpr;
    const pad = Math.ceil(rr * 0.25) + 2;
    const w = Math.ceil(rr * 3) + pad * 2;
    const h = Math.ceil(rr * (FIGURE_HEIGHT_R + 0.6)) + pad * 2;
    const solid = document.createElement('canvas');
    solid.width = w;
    solid.height = h;
    const s = solid.getContext('2d')!;
    s.translate(w / 2, h - pad - rr * 0.15);
    s.scale(facing === 'west' ? -rr : rr, -rr);
    person(s, view, palette, parts, stride, true, talking);
    const edged = document.createElement('canvas');
    edged.width = w;
    edged.height = h;
    const e = edged.getContext('2d')!;
    const edge = pixel ? 1 : rr * 0.07;
    for (let i = 0; i < (pixel ? 4 : 16); i++) {
      const a = (i / (pixel ? 4 : 16)) * Math.PI * 2;
      e.drawImage(solid, Math.round(Math.cos(a) * edge), Math.round(Math.sin(a) * edge));
    }
    e.globalCompositeOperation = 'source-in';
    e.fillStyle = pixel ? '#2a2420' : '#fdfcf8';
    e.fillRect(0, 0, w, h);
    e.globalCompositeOperation = 'source-over';
    e.drawImage(solid, 0, 0);
    const k = pixel ? r / rr : 1 / dpr;
    ctx.save();
    ctx.imageSmoothingEnabled = !pixel;
    if (!pixel) {
      ctx.shadowColor = 'rgba(40, 30, 20, 0.3)';
      ctx.shadowBlur = r * 0.18 * dpr;
      ctx.shadowOffsetX = r * 0.08 * dpr;
      ctx.shadowOffsetY = r * 0.06 * dpr;
    }
    ctx.drawImage(edged, x - (w / 2) * k, y - (h - pad - rr * 0.15) * k, w * k, h * k);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  // y up, in units of `r`; west is east in a mirror.
  ctx.scale(facing === 'west' ? -r : r, -r);
  if (STYLE === 'bean') bean(ctx, view, palette, parts, stride, r >= 9, talking);
  else if (STYLE === 'pictogram') pictogram(ctx, view, palette, parts, stride, talking);
  else if (INK) {
    // Ink: everything paper and line, but the one colour a person wears on top; hair as solid ink.
    const paper = '#fbfaf6';
    person(ctx, view, { skin: paper, hair: '#2b2724', shirt: palette.shirt, trousers: paper }, parts, stride, r >= 9, talking);
  } else person(ctx, view, palette, parts, stride, r >= 9, talking);
  ctx.restore();
}

/**
 * Bean: one rounded capsule for head and body in the colour a person wears, a window of skin for
 * the face, stubby legs and arms, and the hair as what sits on top.
 */
function bean(g: G, view: View, palette: Palette, parts: Record<PartKey, string> & Extras, stride: number, fine: boolean, talking: number | null): void {
  const w = parts.body === 'broad' ? 1.22 : parts.body === 'slight' ? 0.98 : 1.1;
  const side = view === 'side';
  const back = view === 'back';
  const fx = side ? 0.2 : 0;
  const top = 2.9;
  const hair = palette.hair;
  const bodyColour = parts.top === 'dress' ? palette.shirt : palette.shirt;
  // Legs: two stubs under the capsule.
  for (const s of [-1, 1]) {
    const swing = stride * s;
    const x = side ? swing * 0.18 : s * 0.22;
    limb(g, side && s === -1 ? shade(palette.trousers, -0.15) : palette.trousers, 0.24, [x, 0.42], [x + (side ? swing * 0.1 : 0), 0.16]);
    fill(g, SHOE_COLOUR, () => g.ellipse(x + (side ? 0.06 + swing * 0.1 : 0), 0.08, 0.15, 0.08, 0, 0, Math.PI * 2));
  }
  // Long hair falls behind the capsule.
  if (!back && (parts.head === 'oval' || parts.head === 'ponytail')) {
    fill(g, shade(hair, -0.1), () => g.roundRect(-w / 2 - 0.06 - fx, 1.7, w + 0.12, top - 1.65, [0.1, 0.1, w * 0.55, w * 0.55]));
  }
  // The capsule, a step darker on the side away from the light.
  const capsule = (): void => {
    g.roundRect(-w / 2, 0.36, w, top - 0.36, w / 2);
  };
  fill(g, bodyColour, capsule);
  if (fine) shadeRight(g, shade(bodyColour, -0.14), w * 0.18, capsule);
  if (parts.top === 'blazer' && !back) fill(g, INNER, () => { g.moveTo(fx - 0.14, 1.72); g.lineTo(fx + 0.14, 1.72); g.lineTo(fx, 1.25); });
  if (parts.top === 'hoodie') fill(g, shade(bodyColour, -0.12), () => g.ellipse(-fx * 0.5, 1.78, w * 0.46, 0.13, 0, 0, Math.PI * 2));
  // Arms: two nubs, or crossed in front, or held out.
  const nub = shade(bodyColour, -0.1);
  if (parts.arms === 'folded' && !back) limb(g, nub, 0.2, [-w * 0.38, 1.25], [w * 0.38, 1.3]);
  else for (const s of side ? [1] : [-1, 1]) {
    const open = parts.arms === 'open';
    const ax = side ? -0.05 : s * w * 0.5;
    limb(g, nub, 0.2, [ax, 1.45], [ax + (side ? -stride * 0.2 : s * (open ? 0.32 : 0.12)), open ? 1.6 : 1.05]);
  }
  // The face window, and the face.
  if (!back) {
    fill(g, palette.skin, () => g.ellipse(fx, 2.22, (side ? 0.32 : 0.38), 0.33, 0, 0, Math.PI * 2));
    if (parts.extra === 'beard') fill(g, hair, () => g.ellipse(fx, 2.02, side ? 0.28 : 0.33, 0.15, 0, Math.PI, Math.PI * 2));
    const eyes = side ? [fx - 0.06, fx + 0.16] : [-0.14, 0.14];
    for (const ex of eyes) {
      fill(g, '#2a221c', () => g.ellipse(ex, 2.27, 0.055, 0.075, 0, 0, Math.PI * 2));
      if (fine) fill(g, 'rgba(255, 255, 255, 0.9)', () => g.arc(ex - 0.018, 2.3, 0.02, 0, Math.PI * 2));
    }
    if (parts.extra === 'glasses') for (const ex of eyes) {
      g.beginPath();
      g.arc(ex, 2.27, 0.11, 0, Math.PI * 2);
      g.strokeStyle = '#2a221c';
      g.lineWidth = 0.03;
      g.stroke();
    }
    if (talking !== null) {
      const open = Math.abs(Math.sin(talking / 105));
      fill(g, '#3a1616', () => g.ellipse(fx + (side ? 0.05 : 0), 2.07, 0.07, 0.02 + 0.07 * open, 0, 0, Math.PI * 2));
    } else if (fine && parts.extra !== 'beard') {
      limb(g, 'rgba(60, 30, 26, 0.85)', 0.03, [fx - 0.07, 2.1], [fx, 2.06], [fx + 0.07, 2.1]);
    }
  }
  // Hair on top.
  const crown = (): void => {
    g.moveTo(-w / 2 + 0.02, 2.45);
    g.bezierCurveTo(-w / 2, top + 0.25, w / 2, top + 0.25, w / 2 - 0.02, 2.45);
    g.quadraticCurveTo(fx + 0.15, back ? 2.4 : 2.62, -w / 2 + 0.02, 2.45);
  };
  if (parts.head === 'round' || parts.head === 'oval' || parts.head === 'ponytail' || parts.head === 'bob') fill(g, hair, crown);
  if (parts.head === 'bob') for (const s of [-1, 1]) fill(g, hair, () => g.roundRect(s * (w / 2 - 0.1) - 0.1, 1.95, 0.2, 0.6, 0.08));
  if (parts.head === 'curly') for (const a of [0.1, 0.3, 0.5, 0.7, 0.9]) fill(g, hair, () => g.arc(Math.cos(a * Math.PI) * w * 0.42, top - 0.2 + Math.sin(a * Math.PI) * 0.22, 0.2, 0, Math.PI * 2));
  if (parts.head === 'bun') fill(g, hair, () => g.arc(0, top + 0.08, 0.2, 0, Math.PI * 2));
  if (parts.head === 'ponytail' && (side || back)) fill(g, shade(hair, -0.08), () => g.ellipse(side ? -w / 2 : 0, 2.35, 0.12, 0.3, 0, 0, Math.PI * 2));
  if (parts.extra === 'headphones') {
    g.beginPath();
    g.arc(0, 2.3, w / 2 + 0.04, Math.PI * 0.1, Math.PI * 0.9);
    g.strokeStyle = '#2f2c2a';
    g.lineWidth = 0.06;
    g.stroke();
    for (const s of side ? [-1] : [-1, 1]) fill(g, '#2f2c2a', () => g.roundRect(s * (w / 2) - 0.08, 2.12, 0.16, 0.26, 0.06));
  }
}

/**
 * Pictogram: pure geometry — a circle, a rounded trapezoid, pills for limbs — in the person's
 * own colours, and no face but a mouth when they speak.
 */
function pictogram(g: G, view: View, palette: Palette, parts: Record<PartKey, string> & Extras, stride: number, talking: number | null): void {
  const W = parts.body === 'broad' ? 1.18 : parts.body === 'slight' ? 0.86 : 1;
  const sw = W * (view === 'side' ? 0.78 : 1);
  const top = parts.top ?? 'tee';
  const pill = (colour: string, width: number, ...pts: Array<[number, number]>) => limb(g, colour, width, ...pts);
  // Legs: two pills; in three-quarters they swing along the way of walking.
  for (const side of [-1, 1]) {
    const swing = stride * side;
    const x = view === 'side' ? 0 : side * 0.17;
    const foot = view === 'side' ? swing * 0.3 : x;
    pill(view === 'side' && side === -1 ? shade(palette.trousers, -0.15) : palette.trousers, 0.26, [x, 1.4], [foot, 0.13]);
  }
  if (top === 'dress') fill(g, palette.shirt, () => { g.moveTo(-sw * 0.36, 1.7); g.lineTo(-sw * 0.55, 0.85); g.lineTo(sw * 0.55, 0.85); g.lineTo(sw * 0.36, 1.7); });
  // The body: a rounded trapezoid, shoulders wider than hips.
  fill(g, palette.shirt, () => {
    g.moveTo(-sw * 0.36, 1.32);
    g.lineTo(-sw / 2, 2.38);
    g.quadraticCurveTo(-sw / 2, 2.56, -sw / 2 + 0.18, 2.56);
    g.lineTo(sw / 2 - 0.18, 2.56);
    g.quadraticCurveTo(sw / 2, 2.56, sw / 2, 2.38);
    g.lineTo(sw * 0.36, 1.32);
    g.closePath();
  });
  // Arms: pills from the shoulders, in the body's colour, a shade apart.
  const arm = shade(palette.shirt, -0.12);
  const open = parts.arms === 'open' ? 0.3 : 0;
  if (parts.arms === 'folded' && view !== 'back') pill(arm, 0.2, [-sw * 0.42, 2.0], [sw * 0.42, 2.0]);
  else if (view === 'side') pill(arm, 0.2, [0, 2.4], [stride * 0.25 + open, 1.5 + open]);
  else for (const side of [-1, 1]) pill(arm, 0.2, [side * (sw / 2 + 0.06), 2.4], [side * (sw / 2 + 0.1 + open), 1.5 + open]);
  // The head: a circle, and the hair as a second circle or a cap in its own colour.
  const hy = 3.0;
  const hr = 0.38;
  if (parts.head === 'oval' || parts.head === 'bob') fill(g, palette.hair, () => g.roundRect(-hr * 1.1, hy - hr * (parts.head === 'bob' ? 0.9 : 1.7), hr * 2.2, hr * (parts.head === 'bob' ? 1.9 : 2.7), [hr * 0.2, hr * 0.2, hr * 1.1, hr * 1.1]));
  fill(g, palette.skin, () => g.arc(0, hy, hr, 0, Math.PI * 2));
  if (parts.head !== 'bald') {
    const back = view === 'back';
    fill(g, palette.hair, () => (back ? g.arc(0, hy + 0.02, hr * 1.04, 0, Math.PI * 2) : g.arc(0, hy + 0.02, hr * 1.04, 0, Math.PI)));
    if (parts.head === 'bun' || parts.head === 'ponytail') fill(g, palette.hair, () => g.arc(view === 'side' ? -hr * 0.8 : 0, hy + hr * (parts.head === 'bun' ? 1.1 : 0.3), hr * 0.38, 0, Math.PI * 2));
    if (parts.head === 'curly') for (const a of [0.15, 0.5, 0.85]) fill(g, palette.hair, () => g.arc(Math.cos(a * Math.PI) * hr, hy + Math.sin(a * Math.PI) * hr, hr * 0.42, 0, Math.PI * 2));
  }
  if (talking !== null && view !== 'back') {
    const open2 = Math.abs(Math.sin(talking / 105));
    fill(g, '#3a1616', () => g.ellipse(view === 'side' ? hr * 0.35 : 0, hy - hr * 0.45, 0.07, 0.02 + 0.06 * open2, 0, 0, Math.PI * 2));
  }
}

function person(g: G, view: View, palette: Palette, parts: Record<PartKey, string> & Extras, stride: number, fine: boolean, talking: number | null): void {
  const top = parts.top ?? 'tee';
  const extra = parts.extra ?? 'none';
  const hair = parts.head;
  const W = parts.body === 'broad' ? 1.16 : parts.body === 'slight' ? 0.86 : 1;
  const turn = view === 'side' ? 0.8 : 1;
  const sw = W * turn;
  const hw = sw * (parts.body === 'broad' ? 0.84 : 0.78);
  const shirt = palette.shirt;
  const shirtDark = shade(shirt, -0.16);
  const skin = palette.skin;
  const skinDark = shade(skin, -0.14);
  const hairColour = palette.hair;
  const legColour = top === 'dress' ? skin : palette.trousers;
  const sleeves = top === 'tee' || top === 'dress' ? 'short' : 'long';
  // Where the face is turned: the middle of the head in front, a third of the way round in three-quarters.
  const fx = view === 'side' ? HR * 0.34 : 0;
  const bob = Math.abs(stride) * 0.04;
  g.translate(0, -bob);

  // ── behind everything: long hair, a ponytail, a hood ──
  if (view !== 'back') hairBehind(g, view, hair, hairColour, fx);
  if (top === 'hoodie' && view !== 'back') {
    fill(g, shirtDark, () => g.ellipse(-fx * 0.6, SHOULDER + 0.06, sw * 0.36, 0.2, 0, 0, Math.PI * 2));
  }

  // ── legs and shoes ──
  const legs: Array<{ x: number; foot: number; lift: number; far: boolean }> = [];
  for (const side of [-1, 1]) {
    const swing = stride * side;
    if (view === 'side') {
      legs.push({ x: -0.02, foot: swing * 0.34, lift: Math.max(0, swing) * 0.06, far: side === -1 });
    } else {
      legs.push({ x: side * hw * 0.24, foot: side * hw * 0.24, lift: Math.max(0, swing) * 0.1, far: side === 1 });
    }
  }
  legs.sort((a, b) => Number(b.far) - Number(a.far));
  for (const leg of legs) {
    const colour = leg.far ? shade(legColour, -0.12) : legColour;
    const ankle = SHOE + leg.lift;
    fill(g, colour, () => {
      g.moveTo(leg.x - 0.14, HIP + 0.06);
      g.lineTo(leg.x + 0.14, HIP + 0.06);
      g.quadraticCurveTo(leg.foot + 0.12, (HIP + ankle) / 2, leg.foot + 0.085, ankle);
      g.lineTo(leg.foot - 0.085, ankle);
      g.quadraticCurveTo(leg.foot - 0.13, (HIP + ankle) / 2, leg.x - 0.14, HIP + 0.06);
    });
    const shoe = leg.far ? shade(SHOE_COLOUR, 0.08) : SHOE_COLOUR;
    if (view === 'side') {
      fill(g, shoe, () => g.roundRect(leg.foot - 0.1, ankle - SHOE, 0.3, SHOE + 0.02, [0.03, 0.03, 0.09, 0.04]));
    } else {
      fill(g, shoe, () => g.roundRect(leg.foot - 0.12, ankle - SHOE, 0.24, SHOE + 0.03, [0.03, 0.03, 0.09, 0.09]));
    }
  }

  // ── the far arm, behind the body ──
  const arms = armPaths(parts.arms, view, sw, stride);
  for (const arm of arms.filter(a => a.behind)) drawArm(g, arm.pts, sleeves, shirtDark, shade(skin, -0.1), fine);

  // ── the body: the garment ──
  const torso = (): void => {
    g.moveTo(-hw / 2, HIP - 0.08);
    g.quadraticCurveTo(-sw * 0.42, 2.0, -sw / 2, SHOULDER - 0.16);
    g.quadraticCurveTo(-sw / 2, SHOULDER + 0.02, -sw / 2 + 0.2, SHOULDER + 0.03);
    g.lineTo(sw / 2 - 0.2, SHOULDER + 0.03);
    g.quadraticCurveTo(sw / 2, SHOULDER + 0.02, sw / 2, SHOULDER - 0.16);
    g.quadraticCurveTo(sw * 0.42, 2.0, hw / 2, HIP - 0.08);
    g.quadraticCurveTo(0, HIP - 0.12, -hw / 2, HIP - 0.08);
  };
  if (top === 'dress') {
    // A skirt flaring from the waist to the knee.
    fill(g, shirt, () => {
      g.moveTo(-hw * 0.48, 1.62);
      g.quadraticCurveTo(-hw * 0.7, 1.1, -hw * 0.78, 0.82);
      g.quadraticCurveTo(0, 0.74, hw * 0.78, 0.82);
      g.quadraticCurveTo(hw * 0.7, 1.1, hw * 0.48, 1.62);
    });
    shadeRight(g, shirtDark, hw * 0.22, () => {
      g.moveTo(-hw * 0.48, 1.62);
      g.lineTo(-hw * 0.78, 0.82);
      g.lineTo(hw * 0.78, 0.82);
      g.lineTo(hw * 0.48, 1.62);
    });
  }
  fill(g, shirt, torso);
  if (fine) shadeRight(g, shirtDark, sw * 0.2 + fx * 0.3, torso);

  if (view !== 'back') garmentFront(g, top, sw, shirtDark, skin, fx, fine);
  else if (top === 'hoodie') fill(g, shirtDark, () => g.ellipse(0, SHOULDER - 0.05, sw * 0.3, 0.2, 0, 0, Math.PI * 2));

  // ── neck and head ──
  fill(g, skinDark, () => g.rect(-0.09 + fx * 0.3, SHOULDER - 0.04, 0.18, HEAD_Y - SHOULDER - HR * 0.4));
  if (top !== 'hoodie' && top !== 'blazer' && view !== 'back' && fine) {
    // The throat, under the neckline.
    fill(g, skinDark, () => g.ellipse(fx * 0.4, SHOULDER + 0.02, 0.15, 0.1, 0, Math.PI, Math.PI * 2));
  }
  // Ears, at the sides of the head; in three-quarters only the far one shows, at the back of the head.
  if (fine) {
    if (view === 'front') for (const side of [-1, 1]) fill(g, skinDark, () => g.ellipse(side * HR * 0.96, HEAD_Y - 0.02, 0.065, 0.085, 0, 0, Math.PI * 2));
    if (view === 'side') fill(g, skinDark, () => g.ellipse(-HR * 0.42, HEAD_Y - 0.02, 0.06, 0.085, 0, 0, Math.PI * 2));
  }
  fill(g, skin, () => g.arc(0, HEAD_Y, HR, 0, Math.PI * 2));
  if (fine) {
    shadeRight(g, skinDark, HR * 0.45 + fx * 0.5, () => g.arc(0, HEAD_Y, HR, 0, Math.PI * 2));
    if (view === 'side') fill(g, skin, () => g.ellipse(HR * 0.93, HEAD_Y - 0.06, 0.055, 0.065, 0, 0, Math.PI * 2));
  }

  // The face in a frame of its own that grows with the head: drawn for a head of 0.37 and scaled to this one.
  const fs = HR / 0.37;
  g.save();
  g.translate(0, HEAD_Y);
  g.scale(fs, fs);
  g.translate(0, -HEAD_Y);
  if (view !== 'back') face(g, view, fx / fs, palette, hair, extra, fine, talking);
  if (view !== 'back' && extra === 'glasses' && fine) glasses(g, view, fx / fs);
  g.restore();
  hairFront(g, view, hair, hairColour, fx);
  if (extra === 'headphones') headphones(g, view);

  // ── the near arm, in front of the body ──
  for (const arm of arms.filter(a => !a.behind)) drawArm(g, arm.pts, sleeves, shirt, skin, fine);
}

type Arm = { pts: Array<[number, number]>; behind: boolean };

/** Where the arms go, as polylines from the shoulder: hanging, crossed in front, or held open. */
function armPaths(pose: string, view: View, sw: number, stride: number): Arm[] {
  const sx = sw / 2 - 0.08;
  const shoulderY = SHOULDER - 0.1;
  if (view === 'side') {
    // Three-quarters: the near arm in front of the body, the far one mostly hidden behind it.
    const swing = -stride * 0.3;
    if (pose === 'folded') {
      return [
        { pts: [[sx * 0.5, shoulderY], [sx * 0.75, 2.02], [sx + 0.12, 2.08]], behind: true },
        { pts: [[-sx * 0.4, shoulderY], [-sx * 0.25, 1.98], [sx + 0.05, 2.06]], behind: false },
      ];
    }
    const out = pose === 'open' ? 0.3 : 0;
    return [
      { pts: [[sx * 0.55, shoulderY], [sx * 0.6 - swing * 0.5 + out * 0.6, 1.95], [sx * 0.55 - swing + out, HIP + (pose === 'open' ? 0.3 : 0)]], behind: true },
      { pts: [[-sx * 0.35, shoulderY], [-sx * 0.35 + swing * 0.5, 1.95], [-sx * 0.3 + swing + out * 0.4, HIP + (pose === 'open' ? 0.3 : 0)]], behind: false },
    ];
  }
  const back = view === 'back';
  return [-1, 1].map(side => {
    const lift = view === 'front' ? stride * side * 0.05 : 0;
    if (pose === 'folded' && !back) {
      // Crossed: each forearm across to the other elbow; the right arm over the left.
      return { pts: [[side * sx, shoulderY], [side * (sx + 0.06), 2.0], [-side * sx * 0.7, 2.1 + side * 0.03]], behind: false };
    }
    if (pose === 'folded') return { pts: [[side * sx, shoulderY], [side * (sx + 0.08), 2.0]], behind: false };
    if (pose === 'open') return { pts: [[side * sx, shoulderY], [side * (sx + 0.2), 1.95], [side * (sx + 0.42), HIP + 0.32]], behind: false };
    return { pts: [[side * sx, shoulderY], [side * (sx + 0.07), 1.98 + lift], [side * (sx + 0.06), HIP + 0.02 + lift]], behind: false };
  });
}

/** One arm: the sleeve, the forearm in skin when the sleeve is short, and the hand. */
function drawArm(g: G, pts: Array<[number, number]>, sleeves: 'short' | 'long', sleeve: string, skin: string, fine: boolean): void {
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[1];
  const hand = pts[pts.length - 1];
  if (sleeves === 'short') {
    limb(g, skin, 0.15, ...pts);
    limb(g, sleeve, 0.23, [sx, sy], [sx + (ex - sx) * 0.42, sy + (ey - sy) * 0.42]);
  } else {
    limb(g, sleeve, 0.19, ...pts);
  }
  if (fine || pts.length > 2) fill(g, skin, () => g.arc(hand[0], hand[1], 0.085, 0, Math.PI * 2));
}

/** What the front of the garment shows: a neckline, lapels and a shirt, a pocket, a ribbed hem. */
function garmentFront(g: G, top: string, sw: number, dark: string, skin: string, fx: number, fine: boolean): void {
  if (!fine) return;
  const cx = fx * 0.5;
  if (top === 'blazer') {
    // The shirt in the opening, the lapels either side of it, two buttons.
    fill(g, INNER, () => {
      g.moveTo(cx - 0.17, SHOULDER + 0.03);
      g.lineTo(cx + 0.17, SHOULDER + 0.03);
      g.lineTo(cx, SHOULDER - 0.52);
    });
    fill(g, dark, () => {
      g.moveTo(cx - 0.17, SHOULDER + 0.03);
      g.lineTo(cx - 0.05, SHOULDER - 0.4);
      g.lineTo(cx - 0.24, SHOULDER - 0.18);
    });
    fill(g, dark, () => {
      g.moveTo(cx + 0.17, SHOULDER + 0.03);
      g.lineTo(cx + 0.05, SHOULDER - 0.4);
      g.lineTo(cx + 0.24, SHOULDER - 0.18);
    });
    for (const by of [1.92, 1.74]) fill(g, dark, () => g.arc(cx, by, 0.028, 0, Math.PI * 2));
  } else if (top === 'hoodie') {
    fill(g, dark, () => g.roundRect(cx - sw * 0.27, 1.6, sw * 0.54, 0.26, [0.1, 0.1, 0.03, 0.03]));
    for (const side of [-1, 1]) limb(g, INNER, 0.025, [cx + side * 0.07, SHOULDER - 0.02], [cx + side * 0.08, SHOULDER - 0.3]);
  } else if (top === 'sweater') {
    fill(g, dark, () => g.roundRect(-sw * 0.39, HIP - 0.1, sw * 0.78, 0.09, 0.03));
    fill(g, skin, () => g.ellipse(cx, SHOULDER + 0.03, 0.14, 0.09, 0, Math.PI, Math.PI * 2));
    limb(g, dark, 0.035, [cx - 0.15, SHOULDER + 0.02], [cx, SHOULDER - 0.08], [cx + 0.15, SHOULDER + 0.02]);
  } else {
    fill(g, skin, () => g.ellipse(cx, SHOULDER + 0.03, 0.14, 0.1, 0, Math.PI, Math.PI * 2));
  }
}

/** Eyes, brows, nose, cheeks and the mouth — at rest a small smile, speaking an opening on two beats. */
function face(g: G, view: View, fx: number, palette: Palette, hair: string, extra: string, fine: boolean, talking: number | null): void {
  const side = view === 'side';
  const eyeY = HEAD_Y + 0.02;
  const eyes: Array<[number, number]> = side ? [[fx - 0.1, 0.85], [fx + 0.15, 0.95]] : [[-0.13, 1], [0.13, 1]];
  if (fine) {
    for (const [ex] of eyes) fill(g, 'rgba(230, 120, 110, 0.22)', () => g.ellipse(ex + (side ? 0 : Math.sign(ex) * 0.04), HEAD_Y - 0.11, 0.07, 0.04, 0, 0, Math.PI * 2));
  }
  for (const [ex, size] of eyes) {
    fill(g, '#2a221c', () => g.ellipse(ex, eyeY, 0.032 * size * EYES, 0.042 * size * EYES, 0, 0, Math.PI * 2));
    if (fine) fill(g, 'rgba(255, 255, 255, 0.85)', () => g.arc(ex - 0.01 * EYES, eyeY + 0.015 * EYES, 0.011 * EYES, 0, Math.PI * 2));
  }
  if (fine && hair !== 'bald') {
    for (const [ex, size] of eyes) limb(g, shade(palette.hair, -0.1), 0.022, [ex - 0.045 * size, eyeY + 0.085], [ex, eyeY + 0.1], [ex + 0.045 * size, eyeY + 0.085]);
  }
  if (fine && !side) limb(g, shade(palette.skin, -0.22), 0.018, [-0.012, HEAD_Y - 0.04], [0.012, HEAD_Y - 0.075], [-0.01, HEAD_Y - 0.08]);
  if (extra === 'beard') {
    fill(g, palette.hair, () => {
      g.moveTo(fx - 0.37 * 0.92, HEAD_Y - 0.02);
      g.quadraticCurveTo(fx - 0.37 * 0.75, HEAD_Y - 0.37 * 1.25, fx, HEAD_Y - 0.37 * 1.12);
      g.quadraticCurveTo(fx + 0.37 * 0.75, HEAD_Y - 0.37 * 1.25, fx + 0.37 * 0.92, HEAD_Y - 0.02);
      g.quadraticCurveTo(fx + 0.37 * 0.45, HEAD_Y - 0.2, fx, HEAD_Y - 0.13);
      g.quadraticCurveTo(fx - 0.37 * 0.45, HEAD_Y - 0.2, fx - 0.37 * 0.92, HEAD_Y - 0.02);
    });
  }
  const mx = fx + (side ? 0.03 : 0);
  const my = HEAD_Y - 0.17;
  if (talking !== null) {
    // Two beats: the jaw drops and lifts on one, the lips narrow and widen on another. One beat alone reads as
    // a face changing its mind between serious and smiling rather than as a voice.
    const open = Math.abs(Math.sin(talking / 105));
    const wide = 0.5 + 0.5 * Math.sin(talking / 57);
    const w = (0.05 + 0.025 * wide) * (side ? 0.85 : 1);
    const h = 0.018 + 0.062 * open;
    fill(g, '#3a1616', () => g.ellipse(mx, my - h * 0.3, w, h, 0, 0, Math.PI * 2));
    if (open > 0.35) fill(g, '#b5585a', () => g.ellipse(mx, my - h * 0.85, w * 0.55, h * 0.4, 0, 0, Math.PI * 2));
  } else if (fine && extra !== 'beard') {
    limb(g, 'rgba(60, 30, 26, 0.85)', 0.022, [mx - 0.06, my + 0.012], [mx, my - 0.022], [mx + 0.06, my + 0.012]);
  }
}

/** The hair that is behind the head and body: long hair to below the shoulders, a ponytail, a bun's base. */
function hairBehind(g: G, view: View, hair: string, colour: string, fx: number): void {
  const back = -fx * 0.5;
  if (hair === 'oval') {
    fill(g, shade(colour, -0.12), () => g.roundRect(back - HR * 1.12, SHOULDER - 0.38, HR * 2.24, HEAD_Y - SHOULDER + 0.38 + HR * 0.6, [0.12, 0.12, HR, HR]));
  } else if (hair === 'ponytail' && view === 'side') {
    fill(g, shade(colour, -0.08), () => {
      g.moveTo(-HR * 0.6, HEAD_Y + HR * 0.4);
      g.quadraticCurveTo(-HR * 1.6, HEAD_Y + HR * 0.2, -HR * 1.25, HEAD_Y - HR * 1.6);
      g.quadraticCurveTo(-HR * 0.9, HEAD_Y - HR * 0.6, -HR * 0.4, HEAD_Y + HR * 0.1);
    });
  } else if (hair === 'curly') {
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (-0.15 + (i / 8) * 1.3);
      fill(g, shade(colour, -0.08), () => g.arc(back * 0.5 + Math.cos(a) * HR * 1.02, HEAD_Y + Math.sin(a) * HR * 0.98, HR * 0.42, 0, Math.PI * 2));
    }
  } else if (hair === 'bob') {
    fill(g, shade(colour, -0.1), () => g.roundRect(back - HR * 1.1, HEAD_Y - HR * 0.95, HR * 2.2, HR * 2.0, [HR * 0.3, HR * 0.3, HR, HR]));
  }
}

/** The hair over the head: its outline is what tells one person from another at a glance. */
function hairFront(g: G, view: View, hair: string, colour: string, fx: number): void {
  if (hair === 'bald') return;
  const dark = shade(colour, -0.12);
  if (view === 'back') {
    // From behind the hair covers the head, and shows its length.
    if (hair === 'oval') fill(g, colour, () => g.roundRect(-HR * 1.12, SHOULDER - 0.4, HR * 2.24, HEAD_Y - SHOULDER + 0.4 + HR * 1.04, [0.12, 0.12, HR * 1.1, HR * 1.1]));
    else if (hair === 'bob') fill(g, colour, () => g.roundRect(-HR * 1.1, HEAD_Y - HR * 0.95, HR * 2.2, HR * 2.0, [HR * 0.3, HR * 0.3, HR, HR]));
    else fill(g, colour, () => g.arc(0, HEAD_Y + HR * 0.03, HR * 1.04, 0, Math.PI * 2));
    if (hair === 'curly') for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      fill(g, colour, () => g.arc(Math.cos(a) * HR * 0.95, HEAD_Y + Math.sin(a) * HR * 0.95, HR * 0.38, 0, Math.PI * 2));
    }
    if (hair === 'bun') fill(g, dark, () => g.arc(0, HEAD_Y + HR * 1.05, HR * 0.42, 0, Math.PI * 2));
    if (hair === 'ponytail') fill(g, dark, () => g.roundRect(-HR * 0.22, HEAD_Y - HR * 1.7, HR * 0.44, HR * 1.4, HR * 0.2));
    return;
  }
  const cx = fx * 0.6;
  // The crown: always there, cut at the hairline over the forehead.
  const cap = (fringe: number, sweep: number): void => {
    g.moveTo(-HR * 1.03, HEAD_Y + 0.02);
    g.bezierCurveTo(-HR * 1.1, HEAD_Y + HR * 1.35, HR * 1.1, HEAD_Y + HR * 1.35, HR * 1.03, HEAD_Y + 0.02);
    g.quadraticCurveTo(HR * 0.8, HEAD_Y + HR * 0.55, cx + sweep, HEAD_Y + HR * fringe);
    g.quadraticCurveTo(-HR * 0.7, HEAD_Y + HR * 0.6, -HR * 1.03, HEAD_Y + 0.02);
  };
  if (hair === 'round') {
    fill(g, colour, () => cap(0.42, HR * 0.35));
  } else if (hair === 'oval') {
    // Parted in the middle, falling either side of the face to the shoulders.
    fill(g, colour, () => {
      g.moveTo(cx, HEAD_Y + HR * 0.85);
      g.quadraticCurveTo(cx - HR * 0.7, HEAD_Y + HR * 0.7, cx - HR * 0.82, HEAD_Y - HR * 0.2);
      g.lineTo(-HR * 1.12 - fx * 0.3, SHOULDER - 0.3);
      g.lineTo(-HR * 1.12 - fx * 0.3, HEAD_Y);
      g.bezierCurveTo(-HR * 1.1, HEAD_Y + HR * 1.4, HR * 1.1, HEAD_Y + HR * 1.4, HR * 1.12, HEAD_Y);
      if (view === 'front') g.lineTo(HR * 1.12, SHOULDER - 0.3);
      g.lineTo(cx + HR * 0.82, HEAD_Y - HR * 0.2);
      g.quadraticCurveTo(cx + HR * 0.7, HEAD_Y + HR * 0.7, cx, HEAD_Y + HR * 0.85);
    });
  } else if (hair === 'curly') {
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (0.08 + (i / 6) * 0.84);
      fill(g, colour, () => g.arc(Math.cos(a) * HR * 0.9, HEAD_Y + Math.sin(a) * HR * 0.92, HR * 0.36, 0, Math.PI * 2));
    }
  } else if (hair === 'bun') {
    fill(g, colour, () => cap(0.62, 0));
    fill(g, dark, () => g.arc(-fx * 0.4, HEAD_Y + HR * 1.12, HR * 0.42, 0, Math.PI * 2));
  } else if (hair === 'bob') {
    // A straight fringe, and the sides to the jaw.
    fill(g, colour, () => {
      g.moveTo(-HR * 1.1, HEAD_Y - HR * 0.9);
      g.lineTo(-HR * 1.1, HEAD_Y);
      g.bezierCurveTo(-HR * 1.1, HEAD_Y + HR * 1.4, HR * 1.1, HEAD_Y + HR * 1.4, HR * 1.1, HEAD_Y);
      g.lineTo(HR * 1.1, HEAD_Y - HR * 0.9);
      g.lineTo(cx + HR * 0.78, HEAD_Y - HR * 0.9);
      g.lineTo(cx + HR * 0.78, HEAD_Y + HR * 0.35);
      g.lineTo(cx - HR * 0.78, HEAD_Y + HR * 0.35);
      g.lineTo(cx - HR * 0.78, HEAD_Y - HR * 0.9);
    });
  } else if (hair === 'ponytail') {
    fill(g, colour, () => cap(0.6, -HR * 0.1));
    fill(g, dark, () => g.ellipse(-HR * 0.9, HEAD_Y + HR * 0.15, HR * 0.16, HR * 0.12, 0, 0, Math.PI * 2));
  }
}

function glasses(g: G, view: View, fx: number): void {
  const eyes = view === 'side' ? [fx - 0.1, fx + 0.15] : [-0.13, 0.13];
  for (const ex of eyes) {
    g.beginPath();
    g.arc(ex, HEAD_Y + 0.02, 0.075, 0, Math.PI * 2);
    g.strokeStyle = '#2a221c';
    g.lineWidth = 0.022;
    g.stroke();
  }
  limb(g, '#2a221c', 0.02, [eyes[0] + 0.075, HEAD_Y + 0.03], [eyes[1] - 0.075, HEAD_Y + 0.03]);
}

function headphones(g: G, view: View): void {
  const band = '#2f2c2a';
  g.beginPath();
  g.arc(0, HEAD_Y + 0.02, HR * 1.12, Math.PI * 0.08, Math.PI * 0.92);
  g.strokeStyle = band;
  g.lineWidth = 0.05;
  g.stroke();
  const cups = view === 'side' ? [-HR * 0.42] : [-HR * 1.05, HR * 1.05];
  for (const cx of cups) fill(g, band, () => g.roundRect(cx - 0.065, HEAD_Y - 0.11, 0.13, 0.2, 0.05));
}
