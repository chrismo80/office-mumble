/**
 * Bauen: the building editor — tools on the left, the floor in the middle, what is selected on the right.
 * Every gesture is previewed whole and sent as one message when it is let go, so a stroke, a moved group or a
 * resized floor is applied by the server whole or refused whole. `mayBuild` is asked before anything is sent.
 */

import {
  arranged,
  arrangementProblem,
  applyChanges,
  movesBy,
  paintCells,
  pieceAt,
  piecesIn,
  placementProblem,
  resizeFor,
  stampAt,
  stampOf,
  stampSize,
  strokeFor,
  survivingChanges,
  turnMoves,
  turnStamp,
  FACINGS,
  type At,
  type Edge,
  type Edges,
  type Stamp,
  type Tool,
} from './edit';
import {

  drawEdges,
  drawGhosts,
  drawLabelGhost,
  drawMarquee,
  drawResize,
  drawStroke,
  edgeAt,
  metres,
  outlineCell,
  outlinePiece,
  PAINT_INK,
  tintCells,
} from './buildOverlay';
import { SQUASH } from './depth';
import type { PaintedCells } from './floorArt';
import { nameOf, PIECES, searchCatalogue } from './furniture';
import { SURFACE_NAMES } from './look';
import { mayBuild, type View } from './router';
import type { Scene } from './scene';
import { thumbnail } from './standing';
import type { Edit, Floor, Object as Piece, PersonView } from './wire';

/** Who holds the building, by the server's word: `holder` is `null` when nobody does. */
export type Lock = { holder: number | null; name: string | null };

/** The state of the building in a few words, for the title row and the rail. */
export function lockSentence(lock: Lock, me: number): string {
  if (lock.holder === null) return 'the building is free';
  if (lock.holder === me) return 'you hold the building';
  return `${lock.name ?? 'someone'} is building — you watch`;
}

/** What the editor needs from the client around it: the floor, the wire, and the status bar. */
export type Host = {
  view(): View;
  floor(): Floor | null;
  cellM(): number;
  painted(): PaintedCells;
  send(change: Edit): void;
  refuse(reason: string): void;
  /** The floor is about to grow or shrink at these edges, so the camera can keep the building still. */
  resizing(edges: Edges): void;
  fit(): void;
};

/** Where the pointer is, in every frame of reference a gesture needs. */
export type PointerAt = {
  /** The cell under the pointer, clamped to the floor; null while there is no floor. */
  cell: At | null;
  /** Whether the pointer is on the floor at all, rather than clamped onto its edge. */
  on: boolean;
  /** The point on the plan, in metres. */
  x: number;
  y: number;
  /** The point on the canvas, in CSS pixels. */
  sx: number;
  sy: number;
  shift: boolean;
  alt: boolean;
};

type Gesture =
  | { kind: 'stroke'; tool: Tool; from: At; to: At }
  | { kind: 'marquee'; from: At; to: At; base: Set<string> }
  | { kind: 'carry'; from: At; grab: At; to: At; copy: boolean }
  | { kind: 'edge'; edge: Edge; outward: number }
  | null;

type ToolInfo = { tool: Tool; name: string; key: string; hint: string; icon: string };

/** The tools, in the order the toolbar shows them, with the letter that picks each and a line on what it does. */
const TOOLS: ToolInfo[] = [
  { tool: 'select', name: 'Select', key: 'V', hint: 'The tools are on the left — click one, then drag on the plan. Click selects a piece; dragging on open floor draws a marquee', icon: 'M6 3l12 9-5.5 1.2L10 19z' },
  { tool: 'hand', name: 'Hand', key: 'H', hint: 'Drag to move the view — as the space bar does with every tool', icon: 'M8 12V6a1.5 1.5 0 013 0v5m0-1V4.5a1.5 1.5 0 013 0V10m0-.5V6a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-.5a6 6 0 01-5-2.6L4.2 13a1.5 1.5 0 012.4-1.8L8 13' },
  { tool: 'room', name: 'Room', key: 'G', hint: 'Drag a rectangle: walls outside, floor inside; doors in the outline stay', icon: 'M4 4h16v16H4z M9 20v-3h4v3' },
  { tool: 'wall', name: 'Wall', key: 'W', hint: 'Drag draws a straight wall', icon: 'M3 9h18v6H3z M9 9v6 M15 9v6' },
  { tool: 'door', name: 'Door', key: 'T', hint: 'Click or drag puts a door in a wall', icon: 'M6 21V3h11v18 M14 12h.5 M3 21h18' },
  { tool: 'window', name: 'Window', key: 'I', hint: 'Click or drag: wall becomes a window; a window already there grows longer', icon: 'M3 9h18v6H3z M3 12h18 M9 9v6 M15 9v6' },
  { tool: 'floor', name: 'Floor', key: 'F', hint: 'Drag a rectangle to lay floor', icon: 'M4 4h16v16H4z M4 12h16 M12 4v16' },
  { tool: 'surface', name: 'Surface', key: 'P', hint: 'Drag a rectangle to lay the chosen surface', icon: 'M4 20c2.5 0 3.5-1.5 3.5-3.5S9 13 10.5 13 M10 13.5l8.5-8.5a2 2 0 00-3-3L7 10.5' },
  { tool: 'erase', name: 'Erase', key: 'E', hint: 'Drag a rectangle to take away wall, floor and what stands on it', icon: 'M8 20h12 M4 15.5l9.5-9.5 6 6L13 18.5H7z' },
  { tool: 'furniture', name: 'Furniture', key: 'O', hint: 'Click places the piece, R turns it first, Esc ends', icon: 'M4 11a2 2 0 012 2v2h12v-2a2 2 0 114 0v6H2v-6a2 2 0 012-2z M6 11V8a2 2 0 012-2h8a2 2 0 012 2v3' },
  { tool: 'label', name: 'Name', key: 'N', hint: 'Click puts the room name from the field on the right; empty takes one away', icon: 'M3 12V4h8l10 10-8 8z M7.5 8h.5' },
];

/** The keyboard, as the shortcut list shows it. */
const SHORTCUTS: Array<[string, string]> = [
  ['V H G W T I F P E O N', 'choose a tool'],
  ['Space + drag', 'move the view'],
  ['Wheel', 'zoom'],
  ['Shift + 1', 'show the whole floor plan'],
  ['Shift + click', 'extend the selection'],
  ['Ctrl + A', 'select all furniture'],
  ['Arrow keys', 'nudge the selection (with Shift: 2 m)'],
  ['R / Shift + R', 'turn'],
  ['Alt + drag', 'drag a copy'],
  ['Ctrl + D', 'duplicate'],
  ['Ctrl + C / Ctrl + V', 'copy and paste'],
  ['Del', 'delete'],
  ['Esc', 'cancel, then clear the selection'],
];

const SURFACE_WORDS: Record<string, string> = { parquet: 'Parquet', tile: 'Tiles', carpet: 'Carpet', concrete: 'Concrete' };

const keyOf = (row: number, col: number) => `${row},${col}`;
const same = (a: At, b: At) => a[0] === b[0] && a[1] === b[1];
const sizeOf = (kind: string) => PIECES[kind];

function svgIcon(path: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(ns, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

export class BuildingEditor {
  tool: Tool = 'select';
  surface = 'parquet';
  /** What the furniture tool puts down: one piece from the catalogue, or a copied group. */
  stamp: Stamp = [{ kind: 'desk', dr: 0, dc: 0, facing: 'south' }];
  /** The selected pieces, by the cell each stands on. */
  readonly selection = new Set<string>();
  private clipboard: Stamp | null = null;
  private labelText = '';
  private gesture: Gesture = null;
  private hover: PointerAt | null = null;
  /** The piece being dragged in from the catalogue, while it is over the floor. */
  private dropping: string | null = null;
  private lock: Lock = { holder: null, name: null };
  private me = 0;

  private readonly toolbar = document.querySelector<HTMLElement>('#toolbar')!;
  private readonly inspector = document.querySelector<HTMLElement>('#inspector')!;
  private readonly catalogue = document.querySelector<HTMLElement>('#catalogue')!;
  private readonly search = document.querySelector<HTMLInputElement>('#catalogue-search')!;
  private readonly banner = document.querySelector<HTMLElement>('#build-banner')!;

  constructor(private readonly host: Host, private readonly changed: () => void) {}

  /** Put the toolbar, the inspector and the catalogue in. */
  fill(): void {
    for (const info of TOOLS) {
      const button = element('button', 'tool');
      button.type = 'button';
      button.dataset.tool = info.tool;
      button.title = `${info.name} (${info.key}) — ${info.hint}`;
      button.setAttribute('aria-label', info.name);
      button.append(svgIcon(info.icon), element('span', 'tool-name', info.name), element('span', 'tool-key', info.key));
      button.addEventListener('click', () => this.pick(info.tool));
      this.toolbar.append(button);
    }
    this.search.addEventListener('input', () => this.fillCatalogue());
    this.fillCatalogue();
    this.render();
  }

  pick(next: Tool): void {
    this.tool = next;
    this.gesture = null;
    this.render();
  }

  /** The keys that pick a tool. Heard only while Bauen is open — see the keyboard in `main.ts`. */
  toolForKey(key: string): Tool | undefined {
    return TOOLS.find(info => info.key.toLowerCase() === key.toLowerCase())?.tool;
  }

  /** The line under the floor that says what the tool on does. */
  hint(): string {
    if (!this.mayEdit()) return `${this.lock.name ?? 'Someone'} is building — you watch; selecting and looking around still work`;
    return TOOLS.find(info => info.tool === this.tool)?.hint ?? '';
  }

  // ── the lock ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The line the editor always carries: who holds the building and who is watching. The lock is taken by starting
 * to edit, not by picking a tool, and this screen says so.
 */
  showLock(lock: Lock, me: number, people: Map<number, PersonView>): void {
    this.lock = lock;
    this.me = me;
    const watchers = [...people.values()].filter(person => person.id !== me && person.id !== lock.holder).map(person => person.name);
    const who = watchers.length === 0 ? 'nobody is watching' : `${watchers.join(', ')} are watching`;
    this.banner.classList.toggle('mine', lock.holder === me);
    this.banner.textContent = '';
    const mark = element('span', undefined, lock.holder === null ? '○' : '◉');
    const text = element('span');
    if (lock.holder === me) {
      text.textContent = `You are building — ${who}. Nobody builds beside you: the building is yours until your connection ends.`;
    } else if (lock.holder !== null) {
      text.textContent = `${lock.name ?? 'Someone'} is building. You watch; you can change things again once the building is free.`;
    } else {
      text.textContent = 'The building is free. Whoever touches it first holds it — and everybody else watches.';
    }
    this.banner.append(mark, text);
  }

  private mayEdit(): boolean {
    return this.lock.holder === null || this.lock.holder === this.me;
  }

  /** Nobody else is building, and Bauen is the place that is open — or the reason it is not, told. */
  private allowed(): boolean {
    if (!mayBuild(this.host.view())) return false;
    if (this.mayEdit()) return true;
    this.host.refuse(`${this.lock.name ?? 'Someone'} is building — you can change things once the building is free`);
    return false;
  }

  /** A new plan arrived: forget a selection of pieces that are no longer there, and show the floor's size. */
  planArrived(): void {
    const floor = this.host.floor();
    const standing = new Set((floor?.objects ?? []).map(o => keyOf(o.row, o.col)));
    for (const at of [...this.selection]) if (!standing.has(at)) this.selection.delete(at);
    this.render();
  }

  // ── the pointer ────────────────────────────────────────────────────────────────────────────────────

  /** Whether a press here is the editor's: a tool, a selection or an edge. Otherwise the floor is panned. */
  down(p: PointerAt, scene: Scene | null): boolean {
    const floor = this.host.floor();
    if (!floor || !p.cell || !mayBuild(this.host.view()) || this.tool === 'hand') return false;
    this.hover = p;

    const edge = scene ? edgeAt(scene, p.sx, p.sy) : null;
    if (edge) {
      if (this.allowed()) this.gesture = { kind: 'edge', edge, outward: 0 };
      return true;
    }
    // Off the floor a press means nothing to a tool: it pans, like the space bar — except for the marquee,
    // which may well start beside the floor to catch what stands along its edge.
    if (!p.on && this.tool !== 'select') return false;
    switch (this.tool) {
      case 'select':
        this.pressSelect(floor, p);
        return true;
      case 'furniture':
        this.putStamp(floor, p.cell);
        return true;
      case 'label':
        this.writeLabel(floor, p.cell);
        return true;
      default:
        if (this.allowed()) this.gesture = { kind: 'stroke', tool: this.tool, from: p.cell, to: p.cell };
        return true;
    }
  }

  private pressSelect(floor: Floor, p: PointerAt): void {
    const hit = pieceAt(floor.objects, sizeOf, this.host.cellM(), p.x, p.y);
    if (!hit) {
      const base = p.shift ? new Set(this.selection) : new Set<string>();
      if (!p.shift) this.selection.clear();
      this.gesture = { kind: 'marquee', from: p.cell!, to: p.cell!, base };
      this.render();
      return;
    }
    const at = keyOf(hit.row, hit.col);
    if (p.shift) {
      if (this.selection.has(at)) this.selection.delete(at);
      else this.selection.add(at);
      this.render();
      if (!this.selection.has(at)) return;
    } else if (!this.selection.has(at)) {
      this.selection.clear();
      this.selection.add(at);
      this.render();
    }
    this.gesture = { kind: 'carry', from: [hit.row, hit.col], grab: p.cell!, to: [hit.row, hit.col], copy: p.alt };
  }

  move(p: PointerAt): void {
    this.hover = p;
    const gesture = this.gesture;
    if (!gesture || !p.cell) return;
    if (gesture.kind === 'edge') {
      const floor = this.host.floor();
      if (!floor) return;
      const cellM = this.host.cellM();
      const rows = floor.cells.length;
      const cols = floor.cells[0]?.length ?? 0;
      const outward = {
        top: -p.y / cellM,
        bottom: p.y / cellM - rows,
        left: -p.x / cellM,
        right: p.x / cellM - cols,
      }[gesture.edge];
      gesture.outward = Math.round(outward);
      return;
    }
    if (gesture.kind === 'carry') {
      // A carried piece follows the cell under the pointer from where it was grabbed, so a sofa held by its
      // end does not jump to put its anchor under the pointer.
      gesture.to = [gesture.from[0] + p.cell[0] - gesture.grab[0], gesture.from[1] + p.cell[1] - gesture.grab[1]];
      return;
    }
    gesture.to = p.cell;
  }

  up(): void {
    const gesture = this.gesture;
    this.gesture = null;
    const floor = this.host.floor();
    if (!gesture || !floor) return;
    switch (gesture.kind) {
      case 'stroke':
        this.finishStroke(floor, gesture.tool, gesture.from, gesture.to);
        return;
      case 'marquee': {
        for (const piece of piecesIn(floor.objects, gesture.from, gesture.to)) gesture.base.add(keyOf(piece.row, piece.col));
        this.selection.clear();
        for (const at of gesture.base) this.selection.add(at);
        this.render();
        return;
      }
      case 'carry': {
        const [dr, dc] = [gesture.to[0] - gesture.from[0], gesture.to[1] - gesture.from[1]];
        if (dr === 0 && dc === 0) return;
        if (gesture.copy) this.copyBy(floor, dr, dc);
        else this.moveBy(floor, dr, dc);
        return;
      }
      case 'edge': {
        if (gesture.outward === 0) return;
        const edges = resizeFor(gesture.edge, gesture.outward, floor.cells.length, floor.cells[0]?.length ?? 0);
        this.host.resizing(edges);
        this.host.send({ action: 'resize', ...edges });
        return;
      }
    }
  }

  cancel(): void {
    this.gesture = null;
  }

  leave(): void {
    this.hover = null;
  }

  /** The cursor that says what a press would do here. */
  cursor(p: PointerAt | null, scene: Scene | null): string {
    if (this.tool === 'hand') return 'grab';
    if (this.gesture?.kind === 'carry') return 'grabbing';
    const edge = this.gesture?.kind === 'edge' ? this.gesture.edge : p && scene ? edgeAt(scene, p.sx, p.sy) : null;
    if (edge) return edge === 'top' || edge === 'bottom' ? 'ns-resize' : 'ew-resize';
    if (this.tool === 'select') {
      const floor = this.host.floor();
      const hit = floor && p ? pieceAt(floor.objects, sizeOf, this.host.cellM(), p.x, p.y) : null;
      return hit ? 'move' : 'default';
    }
    if (this.tool === 'furniture' || this.tool === 'label') return 'copy';
    return 'crosshair';
  }

  // ── drag and drop from the catalogue ───────────────────────────────────────────────────────────────

  dragOver(p: PointerAt): void {
    this.hover = p;
  }

  /** A piece dragged in from the catalogue and let go over the floor: put down, and selected. */
  drop(p: PointerAt): void {
    const kind = this.dropping;
    this.dropping = null;
    const floor = this.host.floor();
    if (!kind || !floor || !p.cell || !p.on) return;
    const pieces = stampAt([{ kind, dr: 0, dc: 0, facing: this.stamp[0]?.facing ?? 'south' }], p.cell[0], p.cell[1]);
    if (this.place(floor, pieces)) {
      this.tool = 'select';
      this.selection.clear();
      for (const piece of pieces) this.selection.add(keyOf(piece.row, piece.col));
      this.render();
    }
  }

  // ── what a gesture sends ───────────────────────────────────────────────────────────────────────────

  private finishStroke(floor: Floor, tool: Tool, from: At, to: At): void {
    if (!this.allowed()) return;
    if (tool === 'surface') {
      const cells = paintCells(floor.cells, from, to);
      if (cells.length === 0) return;
      this.host.send({ action: 'paint', cells: cells.map(([row, col]) => ({ row, col, surface: this.surface })) });
      const painted = this.host.painted();
      for (const [row, col] of cells) painted.set(row * 1000 + col, this.surface);
      return;
    }
    const changes = strokeFor(tool, floor.cells, from, to);
    if (changes.length === 0) {
      if (tool === 'door') this.host.refuse('a door belongs in a wall');
      if (tool === 'window') this.host.refuse('a window belongs in a wall');
      return;
    }
    this.host.send({ action: 'cells', cells: changes });
    // Drawn now, until the server's plan arrives and prints over it — the server applies the same rules.
    floor.cells = applyChanges(floor.cells, changes);
    floor.objects = survivingChanges(floor.objects, changes);
    floor.labels = survivingChanges(floor.labels, changes);
    const painted = this.host.painted();
    for (const change of changes) if (change.cell === 'void') painted.delete(change.row * 1000 + change.col);
    this.selection.clear();
  }

  /** Put pieces down if they fit, and say why not if they do not. True when they were sent. */
  private place(floor: Floor, pieces: Piece[]): boolean {
    if (!this.allowed()) return false;
    const problem = placementProblem(floor, pieces);
    if (problem) {
      this.host.refuse(`hier nicht: ${problem}`);
      return false;
    }
    this.host.send({ action: 'place', objects: pieces });
    floor.objects = [...floor.objects, ...pieces];
    return true;
  }

  private putStamp(floor: Floor, cell: At): void {
    this.place(floor, stampAt(this.stamp, cell[0], cell[1]));
  }

  private writeLabel(floor: Floor, [row, col]: At): void {
    if (!this.allowed()) return;
    const text = this.labelText.trim();
    floor.labels = floor.labels.filter(label => !(label.row === row && label.col === col));
    if (text) {
      this.host.send({ action: 'label', row, col, text });
      floor.labels.push({ text, row, col });
    } else {
      this.host.send({ action: 'unlabel', row, col });
    }
  }

  private selected(floor: Floor): Piece[] {
    return floor.objects.filter(o => this.selection.has(keyOf(o.row, o.col)));
  }

  /** Carry the selection, whole, and keep it selected where it lands. */
  private arrange(floor: Floor, moves: ReturnType<typeof movesBy>): void {
    if (moves.length === 0 || !this.allowed()) return;
    const problem = arrangementProblem(floor, moves);
    if (problem) {
      this.host.refuse(`geht nicht: ${problem}`);
      return;
    }
    this.host.send({ action: 'arrange', moves });
    floor.objects = arranged(floor.objects, moves);
    this.selection.clear();
    for (const move of moves) this.selection.add(keyOf(move.to_row, move.to_col));
    this.render();
  }

  private moveBy(floor: Floor, dr: number, dc: number): void {
    this.arrange(floor, movesBy(this.selected(floor), dr, dc));
  }

  /** Put a copy of the selection down, offset, and select the copy. */
  private copyBy(floor: Floor, dr: number, dc: number): boolean {
    const copies = this.selected(floor).map(piece => ({ ...piece, row: piece.row + dr, col: piece.col + dc }));
    if (copies.length === 0 || !this.place(floor, copies)) return false;
    this.selection.clear();
    for (const piece of copies) this.selection.add(keyOf(piece.row, piece.col));
    this.render();
    return true;
  }

  private turnSelection(clockwise: boolean): void {
    const floor = this.host.floor();
    if (floor) this.arrange(floor, turnMoves(this.selected(floor), clockwise));
  }

  private faceSelection(facing: string): void {
    const floor = this.host.floor();
    if (!floor) return;
    this.arrange(floor, this.selected(floor).map(p => ({ row: p.row, col: p.col, to_row: p.row, to_col: p.col, facing })));
  }

  private deleteSelection(): void {
    const floor = this.host.floor();
    if (!floor || this.selection.size === 0 || !this.allowed()) return;
    const cells = this.selected(floor).map(p => ({ row: p.row, col: p.col }));
    this.host.send({ action: 'clear', cells });
    floor.objects = floor.objects.filter(o => !this.selection.has(keyOf(o.row, o.col)));
    this.selection.clear();
    this.render();
  }

  /** A copy beside the original — to the right if there is room, else below. */
  private duplicate(): void {
    const floor = this.host.floor();
    if (!floor || this.selection.size === 0) return;
    const { rows, cols } = stampSize(stampOf(this.selected(floor)));
    const right = this.selected(floor).map(p => ({ ...p, col: p.col + cols }));
    if (placementProblem(floor, right) === null) {
      this.copyBy(floor, 0, cols);
      return;
    }
    this.copyBy(floor, rows, 0);
  }

  private selectAll(): void {
    const floor = this.host.floor();
    if (!floor) return;
    this.tool = 'select';
    this.selection.clear();
    for (const o of floor.objects) this.selection.add(keyOf(o.row, o.col));
    this.render();
  }

  // ── the keyboard ───────────────────────────────────────────────────────────────────────────────────

  /** A key while Bauen is open. True when the editor used it. */
  key(event: KeyboardEvent): boolean {
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key;
    const floor = this.host.floor();

    if (key === 'Escape') {
      if (this.gesture) this.cancel();
      else if (this.tool !== 'select') this.pick('select');
      else if (this.selection.size > 0) this.selection.clear();
      else return false;
      this.render();
      return true;
    }
    if (meta) {
      const lower = key.toLowerCase();
      if (lower === 'a') this.selectAll();
      else if (lower === 'c' && floor && this.selection.size > 0) this.clipboard = stampOf(this.selected(floor));
      else if (lower === 'v' && this.clipboard) {
        this.stamp = this.clipboard;
        this.pick('furniture');
      } else if (lower === 'd') this.duplicate();
      else return false;
      return true;
    }
    if (event.shiftKey && event.code === 'Digit1') {
      this.host.fit();
      return true;
    }
    if ((key === 'Delete' || key === 'Backspace') && this.selection.size > 0) {
      this.deleteSelection();
      return true;
    }
    if (key.toLowerCase() === 'r') {
      if (this.tool === 'furniture') {
        this.stamp = turnStamp(this.stamp, !event.shiftKey);
        this.render();
      } else if (this.selection.size > 0) {
        this.turnSelection(!event.shiftKey);
      }
      return true;
    }
    const step = event.shiftKey ? 4 : 1;
    const nudge: Record<string, At> = { ArrowUp: [-step, 0], ArrowDown: [step, 0], ArrowLeft: [0, -step], ArrowRight: [0, step] };
    if (nudge[key] && this.selection.size > 0 && floor) {
      this.moveBy(floor, nudge[key][0], nudge[key][1]);
      return true;
    }
    const chosen = this.toolForKey(key);
    if (chosen) {
      this.pick(chosen);
      return true;
    }
    return false;
  }

  // ── the drawing over the floor ─────────────────────────────────────────────────────────────────────

  draw(scene: Scene): void {
    const floor = scene.floor;
    const g = this.gesture;
    const p = this.hover;
    const hotEdge = g?.kind === 'edge' ? g.edge : p && !g ? edgeAt(scene, p.sx, p.sy) : null;

    if (g?.kind === 'stroke') {
      if (g.tool === 'surface') tintCells(scene, paintCells(floor.cells, g.from, g.to), PAINT_INK);
      else drawStroke(scene, strokeFor(g.tool, floor.cells, g.from, g.to));
    } else if (p?.cell && p.on && !hotEdge && ['room', 'wall', 'door', 'window', 'floor', 'surface', 'erase'].includes(this.tool)) {
      outlineCell(scene, p.cell, '#e2e8f0');
    }

    const chosen = this.selected(floor);
    for (const piece of chosen) outlinePiece(scene, piece, true);
    if (this.tool === 'select' && p && !g) {
      const hit = pieceAt(floor.objects, sizeOf, scene.cellM, p.x, p.y);
      if (hit && !this.selection.has(keyOf(hit.row, hit.col))) outlinePiece(scene, hit, false);
    }
    if (g?.kind === 'carry' && !same(g.from, g.to)) {
      const [dr, dc] = [g.to[0] - g.from[0], g.to[1] - g.from[1]];
      const moved = chosen.map(piece => ({ ...piece, row: piece.row + dr, col: piece.col + dc }));
      const fits = g.copy ? placementProblem(floor, moved) === null : arrangementProblem(floor, movesBy(chosen, dr, dc)) === null;
      drawGhosts(scene, moved, fits);
    }
    if (g?.kind === 'marquee') drawMarquee(scene, g.from, g.to);

    const ghostKind = this.dropping;
    if (p?.cell && p.on && !hotEdge && (this.tool === 'furniture' || ghostKind)) {
      const stamp = ghostKind ? [{ kind: ghostKind, dr: 0, dc: 0, facing: this.stamp[0]?.facing ?? 'south' }] : this.stamp;
      const pieces = stampAt(stamp, p.cell[0], p.cell[1]);
      drawGhosts(scene, pieces, placementProblem(floor, pieces) === null);
    }
    if (this.tool === 'label' && p?.cell && p.on && !hotEdge) drawLabelGhost(scene, p.cell, this.labelText.trim());

    if (this.tool !== 'hand') drawEdges(scene, hotEdge);
    if (g?.kind === 'edge' && g.outward !== 0) {
      drawResize(scene, resizeFor(g.edge, g.outward, floor.cells.length, floor.cells[0]?.length ?? 0));
    }
  }

  // ── the panels ─────────────────────────────────────────────────────────────────────────────────────

  /** Show the tool that is on, and what the inspector says about it. */
  private render(): void {
    for (const button of Array.from(this.toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]'))) {
      const on = button.dataset.tool === this.tool;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    const single = this.stamp.length === 1 ? this.stamp[0].kind : null;
    for (const tile of Array.from(this.catalogue.querySelectorAll<HTMLElement>('[data-kind]'))) {
      tile.classList.toggle('on', this.tool === 'furniture' && tile.dataset.kind === single);
    }
    this.renderInspector();
    this.changed();
  }

  private renderInspector(): void {
    const box = this.inspector;
    box.textContent = '';
    const floor = this.host.floor();
    const chosen = floor ? this.selected(floor) : [];

    if (chosen.length > 0) {
      box.append(this.selectionCard(chosen));
    } else if (this.tool === 'furniture') {
      box.append(this.stampCard());
    } else if (this.tool === 'surface') {
      box.append(element('span', 'sect', 'Belag'));
      const row = element('div', 'chips');
      for (const name of SURFACE_NAMES) {
        const chip = element('button', 'chip', SURFACE_WORDS[name] ?? name);
        chip.type = 'button';
        chip.classList.toggle('on', name === this.surface);
        chip.addEventListener('click', () => {
          this.surface = name;
          this.render();
        });
        row.append(chip);
      }
      box.append(row, element('p', 'note', 'Drag a rectangle over the floor to lay this surface.'));
    } else if (this.tool === 'label') {
      box.append(element('span', 'sect', 'Room name'));
      const field = element('div', 'field');
      const input = element('input');
      input.id = 'label-input';
      input.placeholder = 'e.g. Kitchen — empty removes one';
      input.value = this.labelText;
      input.addEventListener('input', () => (this.labelText = input.value));
      field.append(input);
      box.append(field, element('p', 'note', 'A click on the floor puts the name there.'));
    } else {
      box.append(this.floorCard(floor));
    }

    const keys = element('details', 'shortcuts');
    keys.append(element('summary', undefined, 'Keyboard'));
    const list = element('dl');
    for (const [combo, what] of SHORTCUTS) list.append(element('dt', undefined, combo), element('dd', undefined, what));
    keys.append(list);
    box.append(keys);
  }

  private floorCard(floor: Floor | null): HTMLElement {
    const card = element('div', 'card');
    card.append(element('span', 'sect', 'Floor plan'));
    const rows = floor?.cells.length ?? 0;
    const cols = floor?.cells[0]?.length ?? 0;
    const cellM = this.host.cellM();
    card.append(element('div', 'big', floor ? `${metres(cols * cellM)} × ${metres(rows * cellM)} m` : '—'));
    card.append(element('p', 'note', 'Drag the handles at the edges: outward grows the floor plan, inward shrinks it. Whatever stood on a cut strip goes with it.'));
    const info = TOOLS.find(t => t.tool === this.tool);
    if (info && this.tool !== 'select') card.append(element('p', 'note', `${info.name}: ${info.hint}.`));
    else card.append(element('p', 'note', 'Drag furniture from the catalogue onto the floor, or click it and then click the floor.'));
    return card;
  }

  private stampCard(): HTMLElement {
    const card = element('div', 'card');
    card.append(element('span', 'sect', 'About to be placed'));
    const head = element('div', 'piece-head');
    if (this.stamp.length === 1) {
      const picture = thumbnail(this.stamp[0].kind, 48, SQUASH);
      if (picture) head.append(picture);
      head.append(element('strong', undefined, nameOf(this.stamp[0].kind)));
    } else {
      head.append(element('strong', undefined, `Copied group: ${this.stamp.length} pieces`));
    }
    card.append(head);
    if (this.stamp.length === 1) card.append(this.facingRow(this.stamp[0].facing, facing => {
      this.stamp = [{ ...this.stamp[0], facing }];
      this.render();
    }));
    card.append(element('p', 'note', 'Click to place — as often as you like. R turns it first, Esc ends.'));
    return card;
  }

  private selectionCard(chosen: Piece[]): HTMLElement {
    const card = element('div', 'card');
    card.append(element('span', 'sect', chosen.length === 1 ? 'Selected' : `${chosen.length} pieces selected`));
    if (chosen.length === 1) {
      const head = element('div', 'piece-head');
      const picture = thumbnail(chosen[0].kind, 48, SQUASH);
      if (picture) head.append(picture);
      head.append(element('strong', undefined, nameOf(chosen[0].kind)));
      card.append(head, this.facingRow(chosen[0].facing, facing => this.faceSelection(facing)));
    } else {
      const counts = new Map<string, number>();
      for (const piece of chosen) counts.set(nameOf(piece.kind), (counts.get(nameOf(piece.kind)) ?? 0) + 1);
      card.append(element('p', 'note', [...counts].map(([name, n]) => (n > 1 ? `${n} × ${name}` : name)).join(', ')));
    }
    const actions = element('div', 'actions');
    const act = (text: string, keys: string, run: () => void, danger = false) => {
      const button = element('button', danger ? 'act danger' : 'act');
      button.type = 'button';
      button.append(element('span', undefined, text), element('kbd', undefined, keys));
      button.addEventListener('click', run);
      actions.append(button);
    };
    act('Turn', 'R', () => this.turnSelection(true));
    act('Duplicate', 'Ctrl D', () => this.duplicate());
    act('Copy', 'Ctrl C', () => {
      const floor = this.host.floor();
      if (floor) this.clipboard = stampOf(this.selected(floor));
    });
    act('Delete', 'Del', () => this.deleteSelection(), true);
    card.append(actions, element('p', 'note', 'Drag moves, arrow keys nudge by a cell, Alt + drag draws a copy.'));
    return card;
  }

  /** Four buttons, one per way round, the one in force lit. */
  private facingRow(current: string, choose: (facing: string) => void): HTMLElement {
    const row = element('div', 'facings');
    const arrows: Record<string, string> = { north: '↑ North', east: '→ East', south: '↓ South', west: '← West' };
    for (const facing of FACINGS) {
      const button = element('button', 'chip', arrows[facing]);
      button.type = 'button';
      button.classList.toggle('on', facing === current);
      button.addEventListener('click', () => choose(facing));
      row.append(button);
    }
    return row;
  }

  /** The catalogue: every piece as a picture with its name, on its shelf, narrowed by the search. */
  private fillCatalogue(): void {
    this.catalogue.textContent = '';
    const shelves = searchCatalogue(this.search.value);
    if (shelves.length === 0) this.catalogue.append(element('p', 'note', 'Nothing found.'));
    for (const shelf of shelves) {
      this.catalogue.append(element('span', 'sect', shelf.name));
      const grid = element('div', 'tiles');
      for (const piece of shelf.pieces) {
        const tile = element('button', 'tile');
        tile.type = 'button';
        tile.draggable = true;
        tile.dataset.kind = piece.kind;
        tile.title = `${piece.name} — anklicken und auf den Boden klicken, oder auf den Boden ziehen`;
        const picture = thumbnail(piece.kind, 56, SQUASH);
        if (picture) tile.append(picture);
        tile.append(element('span', undefined, piece.name));
        tile.addEventListener('click', () => {
          this.stamp = [{ kind: piece.kind, dr: 0, dc: 0, facing: this.stamp.length === 1 ? this.stamp[0].facing : 'south' }];
          this.selection.clear();
          this.pick('furniture');
        });
        tile.addEventListener('dragstart', event => {
          this.dropping = piece.kind;
          event.dataTransfer?.setData('text/plain', piece.kind);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
          if (picture && event.dataTransfer) event.dataTransfer.setDragImage(picture, 28, 28);
        });
        tile.addEventListener('dragend', () => {
          this.dropping = null;
          this.changed();
        });
        grid.append(tile);
      }
      this.catalogue.append(grid);
    }
    this.render();
  }

  /** The editor's state, for a driver to read what a click would do. */
  readout(): { tool: Tool; surface: string; stamp: Stamp; selection: string[] } {
    return { tool: this.tool, surface: this.surface, stamp: this.stamp, selection: [...this.selection] };
  }
}
