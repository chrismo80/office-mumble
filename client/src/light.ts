/**
 * The light in the room: a dark table with a soft pool in the middle, the building's shadow, and the hour
 * tinting the room and switching the lamps on. Drawing only — no state, no protocol.
 *
 * Two rules keep it from being a filter over a diagram: the tint and vignette go on the room and never on
 * labels, which are drawn after them, and there is one light direction everywhere.
 */

import type { Scene } from './scene';
import { toScreen } from './view';

/** A keyframe of the day: what colour the room is tinted and how much, and how much the lamps are on. */
type Moment = { hour: number; tint: string; strength: number; lamps: number };

/**
 * The day as five moments, mixed between: a room at 20:40 is warmer than at 19:00 without anybody deciding it.
 */
const DAY: Moment[] = [
  { hour: 0, tint: '#39415a', strength: 0.85, lamps: 1 },   // deep night: dark, cool, and lit by the lamps
  { hour: 6, tint: '#5f6a86', strength: 0.55, lamps: 0.7 }, // first light, still dim
  { hour: 9, tint: '#ffffff', strength: 0, lamps: 0 },      // day: no tint at all
  { hour: 15, tint: '#fff3e4', strength: 0.10, lamps: 0.15 }, // dusk begins at three, gently
  { hour: 18, tint: '#e0a273', strength: 0.42, lamps: 0.7 },
  { hour: 21, tint: '#7a4f38', strength: 0.7, lamps: 1 },   // evening: warm and going down, lamps on
  { hour: 23, tint: '#3d4560', strength: 0.8, lamps: 1 },
];

const hex = (value: string): [number, number, number] => {
  const n = Number.parseInt(value.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** sRGB → linear, so a mix of two lights is a mix of light and not of gamma-encoded numbers. */
const toLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const toSrgb = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
};

/** Two colours mixed in linear light, which is what makes dusk pass through warm grey instead of mud. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a).map(toLinear) as [number, number, number];
  const [br, bg, bb] = hex(b).map(toLinear) as [number, number, number];
  const r = toSrgb(ar + (br - ar) * t);
  const g = toSrgb(ag + (bg - ag) * t);
  const bl = toSrgb(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/** An hour asked for in the page's address (`?stunde=21.5`), so the evening can be looked at at noon. */
const HOUR_ASKED = ((): number | null => {
  const raw = new URLSearchParams(globalThis.location?.search ?? '').get('stunde');
  if (raw === null || raw.trim() === '') return null;
  const asked = Number(raw.replace(',', '.'));
  return Number.isFinite(asked) && asked >= 0 && asked < 24 ? asked : null;
})();

/** The hour, as a fraction: 13.75 is a quarter to two in the afternoon. */
export function hourNow(clock: Date = new Date()): number {
  if (HOUR_ASKED !== null) return HOUR_ASKED;
  return clock.getHours() + clock.getMinutes() / 60;
}

/** What the room looks like at an hour: the tint, how strong it is, and how far the lamps are on. */
export function lightAt(hour: number): { tint: string; strength: number; lamps: number } {
  const h = ((hour % 24) + 24) % 24;
  let before = DAY[DAY.length - 1];
  let after = DAY[0];
  for (let i = 0; i < DAY.length; i++) {
    const a = DAY[i];
    const b = DAY[(i + 1) % DAY.length];
    const from = a.hour;
    const to = i === DAY.length - 1 ? b.hour + 24 : b.hour;
    const at = h < from ? h + 24 : h;
    if (at >= from && at <= to) {
      before = a;
      after = b;
      break;
    }
  }
  const from = before.hour;
  const to = after.hour < before.hour ? after.hour + 24 : after.hour;
  const at = h < from ? h + 24 : h;
  const t = to === from ? 0 : Math.max(0, Math.min(1, (at - from) / (to - from)));
  return {
    tint: mix(before.tint, after.tint, t),
    strength: before.strength + (after.strength - before.strength) * t,
    lamps: before.lamps + (after.lamps - before.lamps) * t,
  };
}

/**
 * The glass at an hour: the sky on the other side, and the room's own light caught in it. By day it is the pale
 * blue of a bright sky; as the lamps come on it goes to a deep evening blue with a warm band across it — the
 * one part of the drawing that says what time it is without showing a number.
 */
export function glassAt(hour: number): { sky: string; caught: string | null } {
  const { lamps } = lightAt(hour);
  const sky = mix('#eaf4fb', '#1b2740', lamps);
  const caught = lamps > 0.2 ? `rgba(255, 214, 150, ${Math.min(0.5, lamps * 0.5).toFixed(3)})` : null;
  return { sky, caught };
}

/**
 * The table: nearly black, one broadband pool under the building, corners falling away. The pool is placed on
 * the plan, not the viewport, so it travels with the building when the room is panned.
 */
export function drawTable(ctx: CanvasRenderingContext2D, w: number, h: number, plan: PlanBox | null): void {
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, w, h);
  if (!plan) return;
  const [cx, cy] = toScreen(plan.transform, plan.width / 2, plan.height / 2);
  const reach = Math.max(plan.width, plan.height) * plan.transform.scale * 0.95;
  const pool = ctx.createRadialGradient(cx, cy, reach * 0.15, cx, cy, reach);
  pool.addColorStop(0, 'rgba(126, 146, 190, 0.20)');
  pool.addColorStop(0.45, 'rgba(104, 122, 162, 0.12)');
  pool.addColorStop(1, 'rgba(80, 96, 130, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = pool;
  ctx.fillRect(cx - reach, cy - reach * (plan.transform.squash ?? 1), reach * 2, reach * 2 * (plan.transform.squash ?? 1));
  ctx.restore();
}

/** What the table needs to know about the plan standing on it. */
export type PlanBox = { width: number; height: number; transform: import('./view').Transform };

/** How far a lamp throws its light, in metres. Only a lamp makes light, so only a lamp is asked where the
 *  light is — a pool in the middle of a room is a pool where nothing is switched on. */
export const LAMP_REACH: Record<string, number> = {
  lampRoundFloor: 3.0,
  lampRoundTable: 1.6,
  lampDesk: 1.4,
};

/**
 * The hour over the room: a multiply pass for the tint, the lamps in additive light on top — one pool per lamp,
 * squashed by the tilt. Not a simulation; the difference between a floor plan and a place at nine in the evening.
 */
export function drawHour(scene: Scene, w: number, h: number, hour: number): void {
  const light = lightAt(hour);
  const { ctx, floor, cellM, transform } = scene;
  if (light.strength > 0.002) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = light.strength;
    ctx.fillStyle = light.tint;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  if (light.lamps <= 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = light.lamps;
  for (const object of floor.objects) {
    const reach = LAMP_REACH[object.kind];
    if (reach === undefined) continue;
    const [x, y] = toScreen(transform, (object.col + 0.5) * cellM, (object.row + 0.5) * cellM);
    // As far as this lamp really throws: a table lamp lights its table, a floor lamp the corner it stands in,
    // and the corridor between them stays dark because nothing stands there.
    const r = Math.max(20, transform.scale * reach);
    const pool = ctx.createRadialGradient(x, y, 0, x, y, r);
    pool.addColorStop(0, 'rgba(255, 214, 160, 0.34)');
    pool.addColorStop(0.45, 'rgba(255, 206, 150, 0.15)');
    pool.addColorStop(1, 'rgba(255, 200, 140, 0)');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, transform.squash ?? 1);
    ctx.translate(-x, -y);
    ctx.fillStyle = pool;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.restore();
}

/** A vignette: the corners of the table fall away. Cached per size; drawn as multiply so it darkens, never greys. */
let vignette: { w: number; h: number; fill: CanvasGradient | null } = { w: 0, h: 0, fill: null };

export function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (vignette.fill === null || vignette.w !== w || vignette.h !== h) {
    const g = ctx.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.22, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(255, 255, 255, 1)');
    g.addColorStop(0.62, 'rgba(190, 196, 210, 1)');
    g.addColorStop(1, 'rgba(78, 84, 98, 1)');
    vignette = { w, h, fill: g };
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = vignette.fill!;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** One tile of grain, made once: fine, colourless noise. Grain is what makes a vector scene stop looking printed. */
let grain: CanvasPattern | null = null;

function grainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (grain) return grain;
  const size = 128;
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const g = tile.getContext('2d');
  if (!g) return null;
  const image = g.createImageData(size, size);
  // A deterministic scatter, so the grain does not shimmer when the page is reloaded, and a fixed seed keeps two
  // screenshots of the same room comparable.
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 128 + (next() - 0.5) * 190;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  grain = ctx.createPattern(tile, 'repeat');
  return grain;
}

export function drawGrain(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.035): void {
  const pattern = grainPattern(ctx);
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
