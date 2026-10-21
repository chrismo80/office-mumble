/** The people on the floor, drawn: where they are eased to, which way they face, whether they are walking,
 *  and the two facts a figure shows without a roster — talking, and a stopped microphone. A figure stands, so
 *  it is handed to `standing.ts` to be drawn in its place between the furniture; its name is drawn after
 *  everything, so nobody's name is ever behind a sofa. */

import { nearestWalkable } from './edit';
import { drawFigure, facingFrom, facingVector, FIGURE_HEIGHT_R, mouthFits, paletteOf, partsFor, type Facing } from './figure';
import { drawName, type Scene } from './scene';
import type { Standing } from './standing';
import { clipToWell, nearestCorner, underfoot } from './stair';
import { nearness, riseOf, toScreen, toView, type Transform } from './view';
import type { Figure, PersonView } from './wire';

/**
 * Where somebody's feet are drawn, and what they are drawn after. On a stair they stand on the tread under
 * them: lifted by its height and drawn after it on a flight, and in a well cut off where the floor around the
 * opening covers them.
 */
function placed(scene: Scene, x: number, y: number): { sx: number; sy: number; base: number; clip?: (ctx: CanvasRenderingContext2D) => void } {
  const t = scene.transform;
  const [sx, floorY] = toScreen(t, x, y);
  const base = nearness(t, x, y);
  const on = underfoot(scene.floor, scene.storey, scene.cellM, x, y);
  if (!on) return { sx, sy: floorY, base };
  const sy = floorY - on.tread.z * riseOf(t) * t.scale;
  if (on.climbs) return { sx, sy, base: Math.max(base, nearestCorner(t, on.tread) + 1e-3) };
  return { sx, sy, base, clip: ctx => clipToWell(ctx, t, on.stair, scene.cellM, floorY) };
}

/** How long my own figure stands still before it turns to the camera, in milliseconds. */
const TURN_TO_CAMERA_MS = 1200;

/**
 * The way somebody stands as the camera sees it. On the plan's own view, the plan's facing. On a turned view,
 * the true turn from facing the viewer — so a figure walking away across the diagonal is seen from behind and
 * to one side, not square from behind — eased, so a turn reads as a turn and not as a cut. `toCamera` turns a
 * figure's three-quarter face to the camera, on the side it already leans to: a camera behind me sees my back
 * as I walk, but standing, I am somebody to look at too.
 */
function poseOf(t: Transform, facing: Facing, was: number | undefined, toCamera: boolean, dt: number): { pose: Facing | number; turn?: number } {
  if (t.yaw === undefined) return { pose: facing };
  const [across, towards] = toView(t, ...facingVector(facing));
  const away = Math.atan2(-across, towards);
  const goal = toCamera ? Math.sign(away || 1) * (Math.PI / 4) : away;
  const from = was ?? goal;
  const turn = from + Math.atan2(Math.sin(goal - from), Math.cos(goal - from)) * (1 - Math.exp(-dt / 160));
  // Rounded for the picture, so a turn asks the figure's picture cache for a handful of drawings, not one a frame.
  return { pose: Math.round(turn * 20) / 20, turn };
}

/** What my own client knows about me ahead of the server: the figure I just chose, and my microphone. */
export type Myself = { id: number; figure: Figure | null; talking: boolean; muted: boolean };

/** A person as the last frame drew them: where they were eased to, which way they were walking, and whether
 *  they still were — a figure whose feet move while it stands still reads as a fault, not as a person. `still`
 *  is when they last walked; `turn`, on a turned view, how far they were drawn turned from facing the viewer. */
type Shown = { x: number; y: number; facing: Facing; walking: boolean; still: number; turn?: number };

/** Everybody on the floor, and where each of them was last drawn — which is what lets them glide. */
export class Crowd {
  private shown = new Map<number, Shown>();
  /** People who have just left: drawn for a moment longer, fading, so nobody blinks out of the room. */
  private leaving = new Map<number, { person: PersonView; shown: Shown; at: number }>();
  /** When they were first drawn, so an arrival can be a figure stepping into the room and not a cut. */
  private arrived = new Map<number, number>();
  /** When the last layout was drawn: the easing is in milliseconds, not in frames. */
  private last = 0;
  /** Everybody the server has named, so somebody can be drawn once more as they go. */
  private known = new Map<number, PersonView>();

  /** Where somebody was last drawn, eased — what anything drawn around a figure should follow. */
  shownAt(id: number): { x: number; y: number } | null {
    const at = this.shown.get(id);
    return at ? { x: at.x, y: at.y } : null;
  }

  /** The way somebody was last drawn facing: what the sound has to know to put a voice on the right side. */
  facingOf(id: number): Facing | null {
    return this.shown.get(id)?.facing ?? null;
  }

  /**
   * Everybody as things that stand, and, apart, their names — which go over everything, so nobody's name is
   * ever behind a sofa — and their ghosts: each figure once more, faintly, to be drawn over everything that
   * stands. Where a figure is in plain sight its ghost falls exactly on it and is not seen; behind a wall or a
   * sofa back it is what is left of them, so nobody is ever lost behind the furniture.
   */
  layout(
    scene: Scene,
    people: Map<number, PersonView>,
    myself: Myself,
    lockHolder: number | null,
    now: number,
  ): { figures: Standing[]; names: () => void; ghosts: () => void } {
    const { ctx, floor, cellM, transform } = scene;
    const radius = Math.max(4, 0.33 * transform.scale);
    // Milliseconds, so the same glide takes the same time on a slow screen and a fast one.
    const dt = this.last === 0 ? 16 : Math.min(120, Math.max(1, now - this.last));
    this.last = now;
    const chase = 1 - Math.exp(-dt / 70);
    const figures: Standing[] = [];
    const names: Array<() => void> = [];
    const ghosts: Array<() => void> = [];
    for (const person of people.values()) {
      const before = this.shown.get(person.id);
      // Positions are chased rather than set, so people glide between the server's ten updates a second.
      const x = before ? before.x + (person.x - before.x) * chase : person.x;
      const y = before ? before.y + (person.y - before.y) * chase : person.y;
      // Which way they face is the step they just took, held while they stand still.
      const facing = facingFrom(person.x - (before?.x ?? person.x), person.y - (before?.y ?? person.y), before?.facing ?? 'south');
      const walking = Math.hypot(person.x - x, person.y - y) > 0.01;
      const still = walking ? now : (before?.still ?? now);
      const mine = person.id === myself.id;
      const { pose, turn } = poseOf(transform, facing, before?.turn, mine && now - still > TURN_TO_CAMERA_MS, dt);
      this.shown.set(person.id, { x, y, facing, walking, still, turn });
      this.known.set(person.id, person);
      if (!this.arrived.has(person.id)) this.arrived.set(person.id, now);
      // Somebody who has just arrived grows into the room over a fifth of a second instead of appearing whole.
      const here = Math.min(1, (now - (this.arrived.get(person.id) ?? now)) / 220);
      const entrance = 0.72 + 0.28 * easeOut(here);

      // A plan can change under a figure; where they stand is drawn on the floor they stand on, never inside
      // a wall. The server moves them the same way, so this only covers the frame before its answer arrives.
      let seatX = x;
      let seatY = y;
      const hereCell = floor.cells[Math.floor(y / cellM)]?.[Math.floor(x / cellM)];
      if (hereCell !== 'floor' && hereCell !== 'doorOpen') {
        const seat = nearestWalkable(floor.cells, cellM, x, y);
        if (seat) {
          seatX = (seat[1] + 0.5) * cellM;
          seatY = (seat[0] + 0.5) * cellM;
        }
      }

      const spot = placed(scene, seatX, seatY);
      const [screenX, screenY] = [spot.sx, spot.sy];
      // My own figure is drawn from what I have just chosen, the moment I choose it, rather than waiting for
      // the server to say it back; everybody else's is the server's word. Both are the same shape otherwise.
      const worn = mine && myself.figure ? myself.figure : person.figure;
      // A stride only while the figure is actually moving, so somebody standing still stands still.
      const stride = walking ? Math.sin(now / 90 + person.id) : 0;
      figures.push({
        base: spot.base,
        draw: () => {
          ctx.save();
          spot.clip?.(ctx);
          if (here < 1) ctx.globalAlpha = 0.35 + 0.65 * here;
          // Whether somebody is talking is drawn on the figure itself — mine included — so the room reads
          // without a roster, and somebody whose microphone is stopped is never shown talking.
          // A mouth where a head is big enough to carry one; the ring on the floor only far out, where a mouth
          // would be a single pixel. One signal, read the size you are looking from.
          const talking = person.speaking || (mine && myself.talking);
          const mouthShows = mouthFits(radius * entrance);
          if (talking && !mouthShows) drawSpeaking(ctx, screenX, screenY, radius * entrance, now);
          drawFigure(ctx, screenX, screenY, radius * entrance, pose, paletteOf(worn), partsFor(person.id, worn), mine, stride, talking && mouthShows, now);
          if (person.muted || (mine && myself.muted)) drawMuted(ctx, screenX, screenY, radius * entrance);
          ctx.restore();
        },
      });
      ghosts.push(() => {
        ctx.save();
        ctx.globalAlpha = 0.3 * (here < 1 ? here : 1);
        drawFigure(ctx, screenX, screenY, radius * entrance, pose, paletteOf(worn), partsFor(person.id, worn), false, stride);
        ctx.restore();
      });
      names.push(() => {
        drawName(ctx, screenX, screenY + radius * 0.6 + 12, person.name);
        if (person.id === lockHolder) {
          // The edit lock, on the map where design.md says it belongs: whoever holds it is named where they stand.
          drawName(ctx, screenX, screenY - radius * FIGURE_HEIGHT_R - 8, '✎ editing');
        }
      });
    }

    // Somebody who has left fades where they stood for a moment, so the room does not lose a person in one
    // frame — and their name goes at once, because a name is for calling somebody.
    for (const [id, shown] of this.shown) {
      if (people.has(id)) continue;
      const person = this.known.get(id);
      if (person) this.leaving.set(id, { person, shown, at: now });
      this.shown.delete(id);
      this.arrived.delete(id);
      this.known.delete(id);
    }
    for (const [id, gone] of this.leaving) {
      const age = (now - gone.at) / 260;
      if (age >= 1) {
        this.leaving.delete(id);
        continue;
      }
      const fade = 1 - easeOut(age);
      const spot = placed(scene, gone.shown.x, gone.shown.y);
      const [screenX, screenY] = [spot.sx, spot.sy];
      figures.push({
        base: spot.base,
        draw: () => {
          ctx.save();
          spot.clip?.(ctx);
          ctx.globalAlpha = fade;
          drawFigure(ctx, screenX, screenY, radius * (0.85 + 0.15 * fade), transform.yaw === undefined ? gone.shown.facing : (gone.shown.turn ?? gone.shown.facing), paletteOf(gone.person.figure), partsFor(gone.person.id, gone.person.figure), false, 0);
          ctx.restore();
        },
      });
    }

    return { figures, names: () => names.forEach(name => name()), ghosts: () => ghosts.forEach(ghost => ghost()) };
  }
}

/** Ease-out cubic: fast at first, settling — the shape a thing takes when it is put down. */
function easeOut(t: number): number {
  const x = 1 - Math.max(0, Math.min(1, t));
  return 1 - x * x * x;
}

/** The answer to a click with no way to it: a red cross where the click landed, and the words. */
export function drawNoWay(scene: Scene, at: { x: number; y: number }): void {
  const { ctx, transform } = scene;
  const [x, y] = toScreen(transform, at.x, at.y);
  const k = 7;
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x - k, y - k);
  ctx.lineTo(x + k, y + k);
  ctx.moveTo(x + k, y - k);
  ctx.lineTo(x - k, y + k);
  ctx.stroke();
  drawName(ctx, x, y - k - 8, 'no way there');
}

/** The talking ring: a pulsing halo at the feet of somebody whose microphone is above the threshold. Steady
 *  would read as a state; the pulse reads as a voice being used. */
function drawSpeaking(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number): void {
  const pulse = 1 + 0.06 * Math.sin(now / 160);
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.95)';
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.35 * pulse, r * 0.62 * pulse, 0, 0, Math.PI * 2);
  ctx.stroke();
}

/** A stopped microphone, worn on the figure so nobody believes they were heard. */
function drawMuted(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const bx = x + r * 0.85;
  const by = y - r * (FIGURE_HEIGHT_R - 0.35);
  const br = Math.max(5, r * 0.46);
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = Math.max(1.5, br * 0.3);
  ctx.beginPath();
  ctx.moveTo(bx, by - br * 0.5);
  ctx.lineTo(bx, by + br * 0.3);
  ctx.moveTo(bx - br * 0.42, by + br * 0.55);
  ctx.lineTo(bx + br * 0.42, by - br * 0.55);
  ctx.stroke();
}
