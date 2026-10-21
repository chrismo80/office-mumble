/**
 * The art sheet: the office's furniture and figures on one page, drawn by the same code the office draws with,
 * from the seed plan and without a server. A place to look at a change to the art before walking through it.
 * `?panel=` picks what is shown: `overview` the whole ground floor, `close` a corner of it up close, `pieces`
 * every piece in the catalogue, `figures` every style in every facing. `&hour=` lights the floor as at that hour,
 * and `&floor=` draws another floor of the building than the ground floor.
 */

import plan from '../../fixtures/floor-t1.json';
import { RISE, SQUASH, WALL_HEIGHT_M } from './depth';
import { drawFigure, partsOf, setFigureStyle, type Facing, type FigureStyle } from './figure';
import { drawGround, type PaintedCells } from './floorArt';
import { CATALOGUE, nameOf } from './furniture';
import { drawHour, drawTable } from './light';
import { look } from './look';
import { Crowd } from './people';
import { drawName, onTheFloor, type Scene } from './scene';
import { drawPieceOn, drawStanding, furniture, wallsAndDoors } from './standing';
import { stairs } from './stair';
import { fit, toView, type Transform } from './view';
import type { Figure, Floor, PersonView } from './wire';

const canvas = document.getElementById('sheet') as HTMLCanvasElement;
const asked = new URLSearchParams(location.search);
const panel = asked.get('panel') ?? 'overview';
// `&style=flat|cute|ink|pictogram` draws the people in one of the styles.
setFigureStyle((asked.get('style') ?? 'flat') as FigureStyle);
/** Without an hour the floor is drawn in plain daylight, as the art itself is. */
const hour = asked.has('hour') ? Number(asked.get('hour')) : null;
const W = window.innerWidth;
const H = window.innerHeight;
const dpr = window.devicePixelRatio || 1;
canvas.width = W * dpr;
canvas.height = H * dpr;
canvas.style.width = `${W}px`;
canvas.style.height = `${H}px`;
const ctx = canvas.getContext('2d')!;
ctx.scale(dpr, dpr);

const storey = Math.max(0, Math.min(plan.floors.length - 1, Number(asked.get('floor') ?? 0)));
const floor = plan.floors[storey] as unknown as Floor;
const cellM = plan.cell_m;
const painted: PaintedCells = new Map(floor.painted.map(cell => [cell.row * 1000 + cell.col, cell.surface]));

/** People to look at: one of each style, in colours a team might wear. */
const CAST: Array<{ name: string; figure: Figure }> = [
  { name: 'Ada', figure: { parts: { head: 'oval', body: 'slight', arms: 'sides', top: 'sweater', extra: 'glasses' }, palette: { skin: '#f1c7a5', hair: '#6b3e26', shirt: '#2f6f73', trousers: '#2b3440' } } },
  { name: 'Bob', figure: { parts: { head: 'round', body: 'broad', arms: 'folded', top: 'hoodie', extra: 'beard' }, palette: { skin: '#c68a62', hair: '#1f1a17', shirt: '#d4643c', trousers: '#3b4252' } } },
  { name: 'Cid', figure: { parts: { head: 'bald', body: 'plain', arms: 'open', top: 'tee', extra: 'headphones' }, palette: { skin: '#8d5a3b', hair: '#1f1a17', shirt: '#e3b341', trousers: '#4a5568' } } },
  { name: 'Dee', figure: { parts: { head: 'bun', body: 'plain', arms: 'sides', top: 'blazer' }, palette: { skin: '#e8b98c', hair: '#c9a15a', shirt: '#5b6bbf', trousers: '#2b3440' } } },
  { name: 'Eli', figure: { parts: { head: 'bob', body: 'slight', arms: 'sides', top: 'dress' }, palette: { skin: '#f3d2b8', hair: '#a0522d', shirt: '#9c4f8a', trousers: '#3b4252' } } },
  { name: 'Fay', figure: { parts: { head: 'curly', body: 'plain', arms: 'open', top: 'tee' }, palette: { skin: '#b97a56', hair: '#2a2420', shirt: '#4e9a5b', trousers: '#c9b28a' } } },
  { name: 'Gil', figure: { parts: { head: 'ponytail', body: 'slight', arms: 'folded', top: 'sweater', extra: 'headphones' }, palette: { skin: '#f3d2b8', hair: '#d8b25a', shirt: '#c45a6a', trousers: '#2b3440' } } },
  { name: 'Hana', figure: { parts: { head: 'round', body: 'broad', arms: 'sides', top: 'blazer', extra: 'glasses' }, palette: { skin: '#e0ac69', hair: '#3a3a3a', shirt: '#4a4f5c', trousers: '#4a4f5c' } } },
];

function sceneFor(transform: Transform): Scene {
  return { ctx, floor, storey, cellM, transform, size: transform.scale * cellM, sizeY: transform.scale * cellM * (transform.squash ?? 1) };
}

/** The floor as the office draws it, with the cast standing at the given plan positions. */
function office(transform: Transform, at: Array<[number, number]>): void {
  const scene = sceneFor(transform);
  drawTable(ctx, W, H, { width: floor.cells[0].length * cellM, height: floor.cells.length * cellM, transform });
  onTheFloor(scene, flat => drawGround(flat, painted));
  const people = new Map<number, PersonView>();
  at.forEach(([x, y], i) => people.set(i + 1, { id: i + 1, name: CAST[i % CAST.length].name, x, y, figure: CAST[i % CAST.length].figure }));
  const crowd = new Crowd();
  const myself = { id: 1, figure: null, talking: false, muted: false };
  // Once to arrive, once to be there: a figure's first frame is the start of its entrance.
  crowd.layout(scene, people, myself, null, 1000);
  const laid = crowd.layout(scene, people, myself, null, 5000);
  drawStanding(scene, [...wallsAndDoors(scene), ...stairs(scene), ...furniture(scene), ...laid.figures]);
  laid.ghosts();
  if (hour !== null) drawHour(scene, W, H, hour);
  laid.names();
}

function overview(): void {
  const t = fit(floor.cells[0].length * cellM, floor.cells.length * cellM, W, H, 24, SQUASH, WALL_HEIGHT_M * RISE);
  office(t, [[2.6, 1.6], [13.6, 4.2], [11.5, 11.5], [7.2, 16.5], [16.8, 18.3], [18.6, 8.5]]);
}

function close(): void {
  // The lounge in the south and the desks beside it, about as close as the office zooms — or `&at=x,y` in
  // plan metres, and `&scale=` in pixels per metre. `&yaw=` in degrees looks as the view from behind does, along
  // that direction from north towards east and from that view's lower angle.
  const scale = Number(asked.get('scale') ?? 120);
  const [ax, ay] = (asked.get('at') ?? '13,17').split(',').map(Number);
  const yaw = asked.has('yaw') ? (Number(asked.get('yaw')) * Math.PI) / 180 : undefined;
  const squash = yaw === undefined ? SQUASH : Math.cos(Math.PI / 3);
  const [u, v] = toView({ scale, ox: 0, oy: 0, yaw }, ax, ay);
  const t: Transform = { scale, ox: W / 2 - u * scale, oy: H / 2 - v * scale * squash, squash, ...(yaw === undefined ? {} : { yaw }) };
  // `&people=x,y;x,y` stands the cast elsewhere: behind a wall, at a door.
  const people = asked.get('people')?.split(';').map(p => p.split(',').map(Number) as [number, number]);
  office(t, people ?? [[12.2, 16.6], [13.8, 18.0], [10.6, 18.2]]);
}

function pieces(): void {
  ctx.fillStyle = look.surfaces.parquet.base;
  ctx.fillRect(0, 0, W, H);
  // `&scale=` in pixels per metre, `&from=` the first piece shown: up close, a page holds only some of them.
  const scale = Number(asked.get('scale') ?? 110);
  const t: Transform = { scale, ox: 0, oy: 0, squash: SQUASH };
  const scene = sceneFor(t);
  const all = CATALOGUE.flatMap(shelf => shelf.pieces.map(piece => piece.kind)).slice(Number(asked.get('from') ?? 0));
  const cellW = scale * 1.9;
  const columns = Math.max(1, Math.floor(W / cellW));
  const rowH = scale * 2.3;
  all.forEach((kind, i) => {
    const cx = (i % columns) * cellW + cellW / 2;
    const cy = Math.floor(i / columns) * rowH + rowH * 0.72;
    // drawPieceOn puts a piece's footprint centre on a cell's centre; aim that cell at (cx, cy).
    const tAt: Transform = { scale, ox: cx - 0.5 * cellM * scale, oy: cy - 0.5 * cellM * scale * SQUASH, squash: SQUASH };
    drawPieceOn({ ...scene, transform: tAt }, kind, 'south', 0, 0, 1);
    drawName(ctx, cx, cy + scale * 0.48, nameOf(kind));
  });
}

function figures(): void {
  ctx.fillStyle = look.surfaces.parquet.base;
  ctx.fillRect(0, 0, W, H);
  const facings: Facing[] = ['south', 'east', 'north', 'west'];
  // Up close: the cast, each in all four facings, as many to a row as fit.
  const r = Number(asked.get('r') ?? 34);
  // `&talk=` in milliseconds: everybody speaking, caught at that moment of the mouth's two beats.
  const talk = asked.has('talk') ? Number(asked.get('talk')) : null;
  const group = r * 2.3 * facings.length + r * 1.2;
  const perRow = Math.max(1, Math.floor((W - 40) / group));
  CAST.forEach((member, i) => {
    let x = 40 + r + (i % perRow) * group;
    const y = r * 3.9 + Math.floor(i / perRow) * r * 4.5;
    for (const facing of facings) {
      drawFigure(ctx, x, y, r, facing, member.figure.palette!, partsOf(member.figure), false, 0, talk !== null, talk ?? 0);
      x += r * 2.3;
    }
  });
  // The overview's size: what tells two neighbours apart at a glance.
  let x = 50;
  const y = H - 60;
  for (const size of [12, 9, 6]) {
    CAST.forEach((member, i) => drawFigure(ctx, x + i * size * 3.4, y, size, 'south', member.figure.palette!, partsOf(member.figure), i === 0));
    x += size * 3.4 * CAST.length + 60;
  }
}

/** The styles side by side — each one row of the cast, front, three-quarters speaking, and back,
 *  and the same cast at the size the office is usually seen at. */
function styles(): void {
  ctx.fillStyle = look.surfaces.parquet.base;
  ctx.fillRect(0, 0, W, H);
  const list = (asked.get('styles') ?? 'flat,cute,ink,pictogram').split(',') as FigureStyle[];
  const r = Number(asked.get('r') ?? 26);
  const rowH = (H - 20) / list.length;
  list.forEach((style, row) => {
    setFigureStyle(style);
    const y = 10 + rowH * row + rowH - 22;
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#3a332b';
    ctx.textAlign = 'left';
    ctx.fillText(style, 12, 10 + rowH * row + 18);
    let x = 40 + r;
    CAST.forEach((member, i) => {
      const facing: Facing = i % 4 === 1 ? 'east' : i % 4 === 3 ? 'west' : 'south';
      drawFigure(ctx, x, y, r, facing, member.figure.palette!, partsOf(member.figure), false, 0, i % 2 === 1, 160);
      x += r * 2.5;
    });
    drawFigure(ctx, x, y, r, 'north', CAST[0].figure.palette!, partsOf(CAST[0].figure), false);
    x += r * 3;
    CAST.forEach((member, i) => drawFigure(ctx, x + i * 30, y, 10, 'south', member.figure.palette!, partsOf(member.figure), false));
  });
}

({ overview, close, pieces, figures, styles } as Record<string, () => void>)[panel]?.();
