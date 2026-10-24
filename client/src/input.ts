/**
 * Everything the hand and the keys do to the floor: the cell under the pointer, what a click would act on, the
 * walk that a click starts, and the arrow keys that walk without one.
 *
 * It sends and it asks; it draws nothing.
 */

import type { PointerAt } from './buildingEditor';
import { aim, dropBehind, fitToWindow, localPoint, openOn, planSize, pxPerM, sceneNow, stageSize, toggleBehind } from './cameraControl';
import { mayBuild } from './router';
import { onMyFloor } from './cameraControl';
import { showMenu } from './contextMenu';
import type { PersonRow } from './shell';
import type { PersonView } from './wire';
import { toggledDoor } from './edit';
import { paletteOf } from './figure';
import { S } from './state';
import { aMetreShort, arrowStep, doorSide } from './steering';
import { mute, speak, summon, toggleDoor, walk } from './wire';
import { fromView, nearness, pan, squashOf, toPlan, toScreen, zoomAt, zoomCentred, zoomOf } from './view';
import { frontCell, frontCellTurned, RISES } from './depth';
import { flightCellAt } from './stair';
import type { Floor, Stair } from './wire';

/** The arrow keys that are down right now. */
const heldKeys = new Set<string>();

/** The cell a point of the stage shows: a wall's face or a door's leaf covers the floor behind it, on the
 *  plan's own view (`frontCell`) and on a turned one (`frontCellTurned`) alike. */
function shownCell(floor: Floor, lx: number, ly: number): [number, number] {
  const [x, y] = toPlan(S.transform, lx, ly);
  const fromBehind = sceneNow();
  const cut = fromBehind?.wallsGiveWay ? fromBehind.cut : undefined;
  const shown =
    S.transform.yaw !== undefined
      ? frontCellTurned(floor.cells, S.cellM, S.transform, lx, ly, cut)
      : frontCell(floor.cells, S.cellM, x, y, squashOf(S.transform));
  // A flight stands up off the floor like a wall does, and whichever of the two is nearer the viewer is in front.
  const flight = flightCellAt(floor, S.myFloor, S.cellM, S.transform, lx, ly);
  if (!flight) return shown;
  const wall = RISES.has(floor.cells[shown[0]]?.[shown[1]] ?? '');
  const wallNear = nearness(S.transform, (shown[1] + 0.5) * S.cellM, (shown[0] + 0.5) * S.cellM);
  return wall && wallNear > flight.near ? shown : flight.cell;
}

/** Where a click on a wall's face walks to: the wall's foot on the side the face is seen from — south on the
 *  plan's own view, and on a turned one the open cell beside the wall nearest the viewer. */
function footOf(floor: Floor, row: number, col: number, x: number, y: number): [number, number] {
  if (S.transform.yaw === undefined) return [x, (row + 1.5) * S.cellM];
  let best: [number, number] | null = null;
  let bestNear = -Infinity;
  for (const [r, c] of [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]]) {
    const code = floor.cells[r]?.[c];
    if (code !== 'floor' && code !== 'doorOpen') continue;
    const at: [number, number] = [(c + 0.5) * S.cellM, (r + 0.5) * S.cellM];
    const near = nearness(S.transform, ...at);
    if (near > bestNear) [best, bestNear] = [at, near];
  }
  return best ?? [x, y];
}

export function cellUnder(clientX: number, clientY: number): [number, number] | null {
  if (!S.floor) return null;
  const [lx, ly] = localPoint(clientX, clientY);
  // What is in front there: a wall or a door rises over the floor behind it.
  const [row, col] = shownCell(S.floor, lx, ly);
  if (row < 0 || col < 0 || row >= S.floor.cells.length || col >= (S.floor.cells[row]?.length ?? 0)) return null;
  return [row, col];
}

export function pointerAt(event: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }): PointerAt {
  const [sx, sy] = localPoint(event.clientX, event.clientY);
  const [x, y] = toPlan(S.transform, sx, sy);
  const rows = S.floor?.cells.length ?? 0;
  const cols = S.floor?.cells[0]?.length ?? 0;
  const row = Math.floor(y / S.cellM);
  const col = Math.floor(x / S.cellM);
  const on = S.floor !== null && row >= 0 && col >= 0 && row < rows && col < cols;
  const cell: [number, number] | null = S.floor
    ? [Math.min(rows - 1, Math.max(0, row)), Math.min(cols - 1, Math.max(0, col))]
    : null;
  return { cell, on, x, y, sx, sy, shift: event.shiftKey, alt: event.altKey };
}

export function cursorFor(): string {
  if (S.drag?.kind === 'pan' && S.drag.moved) return 'grabbing';
  if (S.spaceHeld && mayBuild(S.shell.view())) return 'grab';
  if (mayBuild(S.shell.view())) return S.building.cursor(S.pointer, sceneNow());
  if (S.hover && S.floor) {
    const code = S.floor.cells[S.hover[0]]?.[S.hover[1]];
    if (code === 'doorOpen' || code === 'doorShut') return 'pointer';
  }
  if (S.shell.view() !== 'office') return 'default';
  return 'grab';
}

export function stairUnder(floor: Floor, row: number, col: number): Stair | undefined {
  return floor.stairs?.find(
    stair =>
      row >= stair.row &&
      row < stair.row + Math.max(1, stair.rows) &&
      col >= stair.col &&
      col < stair.col + Math.max(1, stair.cols),
  );
}

export function stairExit(stair: Stair): { row: number; col: number } {
  const rows = Math.max(1, stair.rows);
  const cols = Math.max(1, stair.cols);
  switch (stair.exits) {
    case 'north':
      return { row: stair.row, col: stair.col + Math.floor((cols - 1) / 2) };
    case 'south':
      return { row: stair.row + rows - 1, col: stair.col + Math.floor((cols - 1) / 2) };
    case 'west':
      return { row: stair.row + Math.floor((rows - 1) / 2), col: stair.col };
    case 'east':
      return { row: stair.row + Math.floor((rows - 1) / 2), col: stair.col + cols - 1 };
  }
}

export function withinReach(row: number, col: number): boolean {
  const mine = S.standing.get(S.me);
  if (!mine) return false;
  const x = (col + 0.5) * S.cellM;
  const y = (row + 0.5) * S.cellM;
  return Math.hypot(mine.x - x, mine.y - y) <= 1.4;
}

export function walkOrWork(clientX: number, clientY: number): void {
  if (!S.floor || S.shell.view() !== 'office') return;
  const [lx, ly] = localPoint(clientX, clientY);
  const [floorX, floorY] = toPlan(S.transform, lx, ly);
  const [row, col] = shownCell(S.floor, lx, ly);
  // A click on a wall's face is not a click on the floor hidden behind it: it walks to the foot of the wall.
  const code = S.floor.cells[row]?.[col];
  const [x, y] = code === 'wall' || code === 'window' ? footOf(S.floor, row, col, floorX, floorY) : [floorX, floorY];
  // A stair is not a teleport: the click walks to the tread you leave the floor by, and the server changes
  // the floor when the feet arrive (`World::stairs_underfoot`). Clicking the foot of the flight is therefore
  // a click that takes you up, not one that stops halfway.
  // Any click of my own is me taking over: the walk is mine from here, not somebody else's.
  stopFollowing();
  const stair = stairUnder(S.floor, row, col);
  if (stair) {
    const exit = stairExit(stair);
    S.pendingDoor = null;
    // The flight takes a moment; the voices above should not arrive after I do.
    S.voices.prewarm([...S.standing.values()].filter(p => (p.floor ?? 0) === stair.to).map(p => p.id));
    S.socket?.send(walk((exit.col + 0.5) * S.cellM, (exit.row + 0.5) * S.cellM));
    return;
  }
  const toggled = toggledDoor(S.floor.cells[row]?.[col]);
  if (toggled !== null) {
    if (!withinReach(row, col)) {
      // A door is worked with a hand: from across the room the click walks me to it, and the handle turns
      // when I arrive — the same rule as the stair, told the same way.
      S.pendingDoor = { floor: S.myFloor, row, col };
      // The door is a wall while it is shut: walking at the cell itself can mean walking at its far side.
      const at = S.standing.get(S.me);
      const side = at ? doorSide(S.floor.cells, S.cellM, at, row, col) : { row, col };
      S.socket?.send(walk((side.col + 0.5) * S.cellM, (side.row + 0.5) * S.cellM));
      return;
    }
    // In reach: the click works the handle. It is not an edit and needs no lock, and the hearing rule
    // follows the moment the server sends the plan back.
    S.floor.cells[row][col] = toggled;
    S.socket?.send(toggleDoor(S.myFloor, row, col));
    return;
  }
  const { w, h } = planSize();
  if (x < 0 || y < 0 || x > w || y > h) return; // a click outside the floor means nothing
  S.socket?.send(walk(x, y));
}

export function steerOnce(): void {
  const mine = S.standing.get(S.me);
  const dir = arrowStep(heldKeys);
  if (!mine || !dir) return;
  // From behind, up is ahead: the keys turn with the camera as it stood when they were pressed.
  const [dx, dy] = S.steerYaw === null ? [dir.dx, dir.dy] : fromView({ scale: 1, ox: 0, oy: 0, yaw: S.steerYaw }, dir.dx, dir.dy);
  const { w, h } = planSize();
  const x = Math.min(w - 0.05, Math.max(0.05, mine.x + dx));
  const y = Math.min(h - 0.05, Math.max(0.05, mine.y + dy));
  S.socket?.send(walk(x, y));
}

export function startSteering(): void {
  stopFollowing();
  if (S.steering !== null) return;
  S.steerYaw = S.transform.yaw ?? null;
  steerOnce();
  S.steering = setInterval(steerOnce, 180);
}

export function stopSteering(): void {
  if (S.steering === null) return;
  clearInterval(S.steering);
  S.steering = null;
}

export function personAt(clientX: number, clientY: number): PersonView | null {
  const [lx, ly] = localPoint(clientX, clientY);
  const reach = Math.max(20, S.cellM * S.transform.scale * 0.8);
  let best: { person: PersonView; d: number } | null = null;
  for (const person of onMyFloor().values()) {
    if (person.id === S.me) continue;
    const [sx, sy] = toScreen(S.transform, person.x, person.y);
    const d = Math.hypot(sx - lx, sy - ly);
    if (d <= reach && (!best || d < best.d)) best = { person, d };
  }
  return best?.person ?? null;
}

export function openPersonMenu(person: PersonRow, x: number, y: number): void {
  if (person.id === S.me) return;
  const target = S.standing.get(person.id);
  const elsewhere = !target || (target.floor ?? 0) !== S.myFloor;
  const walking = S.following === person.id;
  showMenu(x, y, person.name, [
    {
      label: 'Go to',
      hint: elsewhere ? 'on another floor' : undefined,
      disabled: elsewhere,
      onPick: () => goTo(person.id),
    },
    {
      label: walking ? 'Stop following' : 'Follow',
      hint: elsewhere && !walking ? 'on another floor' : undefined,
      disabled: elsewhere && !walking,
      onPick: () => (walking ? stopFollowing() : follow(person.id)),
    },
    {
      label: 'Come over',
      hint: 'asks first',
      onPick: () => askOver(person.id),
    },
    {
      label: S.mutedPeople.has(person.id) ? 'Unmute' : 'Mute',
      hint: 'for me only',
      onPick: () => togglePersonMute(person.id),
    },
  ]);
}

/** Wires the canvas and the window to the gestures above. Called once, after the places exist. */
export function installInput(): void {
S.canvas.addEventListener('contextmenu', (event) => {
  if (S.shell.view() !== 'office') return;
  event.preventDefault();
  const person = personAt(event.clientX, event.clientY);
  if (person) openPersonMenu(personRow(person, whereOf(person), S.plan?.floors[person.floor ?? 0]?.name), event.clientX, event.clientY);
});

S.canvas.addEventListener('pointerdown', (event) => {
  try {
    // The capture keeps a drag alive when the pointer leaves the S.canvas. A synthetic event (the harness
    // driving the page, or a driver aiming at a cell) has no live pointer to capture, so a refusal here is
    // not a reason to lose the gesture.
    S.canvas.setPointerCapture(event.pointerId);
  } catch {
    /* no live pointer: the drag still works while the pointer stays on the S.canvas */
  }
  S.pointer = pointerAt(event);
  // Only the editor has gestures. Everywhere else — and with the space bar held, and with any button but
  // the first — the floor is dragged to pan, so nothing here can leave a mark.
  const editorTakes = mayBuild(S.shell.view()) && event.button === 0 && !S.spaceHeld && S.building.down(S.pointer, sceneNow());
  S.drag = editorTakes ? { kind: 'build' } : { kind: 'pan', x: event.clientX, y: event.clientY, moved: false };
  S.canvas.style.cursor = cursorFor();
});

S.canvas.addEventListener('pointermove', (event) => {
  S.lastPointer = { x: event.clientX, y: event.clientY };
  S.hover = cellUnder(event.clientX, event.clientY);
  S.pointer = pointerAt(event);
  if (mayBuild(S.shell.view()) && S.drag?.kind !== 'pan') S.building.move(S.pointer);
  if (S.drag?.kind === 'pan') {
    const dx = event.clientX - S.drag.x;
    const dy = event.clientY - S.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) S.drag.moved = true;
    if (S.drag.moved) {
      // The hand is the camera while it is down: any travel that was in the air ends here.
      const carried = S.flung;
      S.goal = null;
      S.flung = null;
      S.transform = pan(S.transform, dx, dy);
      const at = performance.now();
      if (S.lastMove && at - S.lastMove.at > 0 && at - S.lastMove.at < 120) {
        const seconds = (at - S.lastMove.at) / 1000;
        const vx = dx / seconds;
        const vy = dy / seconds;
        // Smoothed, so one jittery frame does not throw the floor across the screen.
        S.flung = carried ? { vx: carried.vx * 0.6 + vx * 0.4, vy: carried.vy * 0.6 + vy * 0.4 } : { vx, vy };
      }
      S.lastMove = { x: event.clientX, y: event.clientY, at };
      S.drag.x = event.clientX;
      S.drag.y = event.clientY;
    }
  }
  S.canvas.style.cursor = cursorFor();
});

S.canvas.addEventListener('pointerup', (event) => {
  const wasClick = S.drag?.kind === 'pan' && !S.drag.moved;
  // A flick keeps going: the velocity of the last moves, decaying, so the floor settles instead of stopping
  // dead under the hand.
  if (S.drag?.kind === 'pan' && S.drag.moved && S.flung && Math.hypot(S.flung.vx, S.flung.vy) > 180) {
    S.flung = { vx: S.flung.vx * 0.9, vy: S.flung.vy * 0.9 };
  } else {
    S.flung = null;
  }
  S.lastMove = null;
  if (S.drag?.kind === 'build') S.building.up();
  S.drag = null;
  S.canvas.style.cursor = cursorFor();
  if (wasClick) walkOrWork(event.clientX, event.clientY);
});

S.canvas.addEventListener('pointercancel', () => {
  if (S.drag?.kind === 'build') S.building.cancel();
  S.drag = null;
  S.canvas.style.cursor = cursorFor();
});

S.canvas.addEventListener('pointerleave', () => {
  S.hover = null;
  S.lastPointer = null;
  if (!S.drag) {
    S.pointer = null;
    S.building.leave();
  }
});

S.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (!S.floor) return;
  // Zoom about my own figure, so the room grows around the place I am standing and I never scroll myself
  // off the edge. Without a figure yet (still connecting) the pointer is the only thing to hold on to.
  // The zoom is aimed rather than set, so a scroll wheel glides instead of stepping.
  const [lx, ly] = localPoint(event.clientX, event.clientY);
  const factor = Math.exp(-event.deltaY * 0.0015);
  const mine = S.standing.get(S.me);
  aim(mine
    ? zoomCentred(S.goal ?? S.transform, mine.x, mine.y, factor, stageSize(), pxPerM())
    : zoomAt(S.goal ?? S.transform, lx, ly, factor, pxPerM()));
}, { passive: false });

// A map that takes a click: the point on the plan under the pointer becomes the middle of the view, so the
// corner answers "where is that?" and "take me there" with the same gesture.
S.minimapCanvas.addEventListener('pointerdown', (event) => {
  const place = S.minimap.placeAt(event.clientX, event.clientY);
  if (place) centreOn(place[0], place[1]);
});

// A piece dragged in from the catalogue: previewed where it would land, and put down where it is let go.
S.canvas.addEventListener('dragover', (event) => {
  if (!mayBuild(S.shell.view())) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  S.pointer = pointerAt(event);
  S.building.dragOver(S.pointer);
});

S.canvas.addEventListener('drop', (event) => {
  if (!mayBuild(S.shell.view())) return;
  event.preventDefault();
  S.building.drop(pointerAt(event));
});

// ── the keyboard ─────────────────────────────────────────────────────────────────────────────────────

/** Whether a key is going into a field, where the field and not the client owns it. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

// One listener, so the order between the shell and the places is written down once: the palette claims
// the keys it opened with, then the editor, then the places get what is left.
window.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;

  if (meta && key.toLowerCase() === 'k') {
    event.preventDefault();
    if (S.shell.paletteOpen()) S.shell.closePalette();
    else S.shell.openPalette();
    return;
  }
  if (meta && key === '[') {
    event.preventDefault();
    S.shell.place('office');
    return;
  }
  if (key === 'Escape' && S.shell.paletteOpen()) {
    S.shell.closePalette();
    return;
  }
  // The editor's keys are heard nowhere else: a key that armed a tool in the office would be a way to
  // change the building from the one place that must not. Esc is the editor's first — it ends a gesture,
  // then a tool, then a selection — and only an Esc it has no use for leaves the place.
  const editing = mayBuild(S.shell.view()) && !typing(event.target) && !S.shell.paletteOpen();
  if (editing && key === ' ') {
    event.preventDefault();
    S.spaceHeld = true;
    S.canvas.style.cursor = cursorFor();
    return;
  }
  if (editing && key.toLowerCase() !== 'm' && S.building.key(event)) {
    event.preventDefault();
    return;
  }
  if (key === 'Escape') {
    S.shell.leave();
    return;
  }
  if (meta || typing(event.target)) return;

  // The arrow keys walk. Only in the office: in the editor they are the browser's scroll, and the editor has
  // its own keys.
  if (key.startsWith('Arrow') && S.shell.view() === 'office' && !S.shell.paletteOpen()) {
    event.preventDefault();
    heldKeys.add(key);
    startSteering();
    return;
  }
  if (key.toLowerCase() === 'm') {
    event.preventDefault();
    setMuted(!S.muted);
  }
  // `V`: down into the room, behind my own figure — and back up. Only in the office, where my figure is.
  if (key.toLowerCase() === 'v' && S.shell.view() === 'office') {
    event.preventDefault();
    toggleBehind();
    return;
  }
  // `0` and `1`: the whole floor, and wherever I am — the two views a camera has everywhere.
  if (key === '0') {
    event.preventDefault();
    dropBehind();
    fitToWindow();
    return;
  }
  if (key === '1') {
    const mine = S.standing.get(S.me);
    if (mine) {
      event.preventDefault();
      openOn(mine.x, mine.y);
    }
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === ' ') {
    S.spaceHeld = false;
    S.canvas.style.cursor = cursorFor();
  }
  if (heldKeys.delete(event.key) && heldKeys.size === 0) stopSteering();
});

// Leaving the page with a key down would leave the figure walking for ever: a browser does not promise the
// keyup once the window has gone.
window.addEventListener('blur', () => {
  heldKeys.clear();
  stopSteering();
});

}

export function stopFollowing(): void {
  S.following = null;
  if (S.followTimer !== null) {
    clearInterval(S.followTimer);
    S.followTimer = null;
  }
}

export function goTo(id: number): void {
  const target = S.standing.get(id);
  const mine = S.standing.get(S.me);
  if (!target || (target.floor ?? 0) !== S.myFloor) return;
  stopFollowing();
  const to = aMetreShort(mine ?? target, target);
  S.socket?.send(walk(to.x, to.y));
}

export function follow(id: number): void {
  stopFollowing();
  const target = S.standing.get(id);
  if (!target || (target.floor ?? 0) !== S.myFloor) return;
  S.following = id;
  S.followTimer = setInterval(() => {
    const them = S.standing.get(id);
    const mine = S.standing.get(S.me);
    if (!them || !mine || (them.floor ?? 0) !== S.myFloor) {
      stopFollowing();
      return;
    }
    if (Math.hypot(mine.x - them.x, mine.y - them.y) < 1.2) return;
    const to = aMetreShort(mine, them);
    S.socket?.send(walk(to.x, to.y));
  }, 350);
}

export function askOver(id: number): void {
  if (id === S.me) return;
  S.socket?.send(summon(id));
}

export function whereOf(person: PersonView): PersonRow['where'] {
  const floor = person.floor ?? 0;
  if (S.heard.some(entry => entry.id === person.id)) return 'earshot';
  if (floor === S.myFloor) return 'floor';
  return floor > S.myFloor ? 'above' : 'below';
}

export function personRow(person: PersonView, where: PersonRow['where'], floorName?: string): PersonRow {
  return {
    id: person.id,
    name: person.name,
    where,
    floorName,
    colour: colourOf(person),
    talking: Boolean(person.speaking) || (person.id === S.me && S.myTalking),
    muted: Boolean(person.muted) || (person.id === S.me && S.muted),
    silenced: S.mutedPeople.has(person.id),
    me: person.id === S.me,
  };
}

export function togglePersonMute(id: number): void {
  if (S.mutedPeople.has(id)) S.mutedPeople.delete(id);
  else S.mutedPeople.add(id);
  S.voices.setSilenced(S.mutedPeople);
  renderPresence();
}

export function colourOf(person: PersonView): string {
  return paletteOf(person.id === S.me && S.myFigure ? S.myFigure : person.figure).shirt;
}

export function renderPresence(): void {
  const rows = [...S.standing.values()].map(person =>
    personRow(person, whereOf(person), S.plan?.floors[person.floor ?? 0]?.name),
  );
  // Sorted by name, not by loudness: a voice coming into earshot is a mark on a row, not a row jumping to the
  // top of the rail. The list only changes when somebody arrives or leaves.
  rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  S.shell.setPresence({ people: rows });
  // The one demo figure, and whether it is already standing here: the state says so, because it joins as a
  // person like anybody — an avatar is a client of its own, not a drawing.
  // Every press adds a figure, so what the rail counts is the whole family: the base name and its numbered
  // cousins, which is exactly what the server makes.
  const figuresHere = [...S.standing.values()].filter(
    person => person.avatar === true && (person.name === S.demo.name || person.name.startsWith(`${S.demo.name} `)),
  );
  S.shell.setAvatars({
    name: S.demo.name,
    voice: S.demo.voice,
    here: figuresHere.length > 0,
    count: figuresHere.length,
  });
}

export function setMuted(next: boolean): void {
  S.muted = next;
  S.voices.setMuted(S.muted);
  // A stopped microphone is not talking, so the server is told both at once: nobody should see a figure
  // that says it is talking while it is not.
  if (S.muted) S.socket?.send(speak(false));
  S.socket?.send(mute(S.muted));
  renderSwitches();
}

export function centreOn(x: number, y: number): void {
  openOn(x, y);
}

export function renderSwitches(): void {
  S.settings.showSwitches(S.muted, S.showAudible, S.showLight);
  S.settings.showGivesWay(S.givesWay);
  S.settings.showDeadZone(S.deadZone);
  S.settings.showSeat(seatLabel());
  S.settings.showSound(S.soundProfile, S.soundSide);
  renderStatus();
}

export function renderStatus(): void {
  const mine = S.standing.get(S.me);
  const zoom = zoomOf(S.transform, pxPerM());
  const names = S.heard.map(person => person.name);
  const hears = S.heard.length === 0
    ? 'hearing nobody'
    : `hearing ${S.heard.length}: ${names.join(', ')}`;
  const where = mine ? `${mine.x.toFixed(1)} m, ${mine.y.toFixed(1)} m` : 'not arrived yet';

  const micOn = S.muted ? false : S.voices.available && S.voices.hasMic ? true : null;
  const micWord = !S.voices.available
    ? 'no sound in this browser'
    : S.muted
      // Stopped is the person's own state and it is said first: a stopped microphone with no device open
      // is still a stopped microphone, and the one thing this bar must never do is hide it.
      ? 'muted'
      : S.voices.hasMic
        ? 'microphone on'
        : 'listening only — no microphone yet';
  // The rail is 256 px wide and a sentence does not fit in it; the status bar is where the words are.
  const micShort = !S.voices.available ? 'no sound' : S.muted ? 'muted' : S.voices.hasMic ? 'microphone on' : 'listening';

  S.shell.setStatus({
    link: S.connection,
    linkOk: S.connection === 'connected',
    mic: micWord,
    micShort,
    micOn,
    hud: `${S.myName || 'no name'} · ${where} · ${hears} · ${Math.round(zoom * 100)} %${S.floor ? '' : ' · waiting for the plan'}`,
    hint: mayBuild(S.shell.view())
      ? S.building.hint()
      : S.shell.view() === 'office'
        ? 'shut or open the door: click'
        : '',
    refuse: S.lastNo,
  });
  // The settings place reads the same facts, so it is told them from the same place rather than growing a
  // second copy of what the wire is doing.
  S.settings.showLink(`Connection: ${S.connection} · ${S.serverUrl ?? '—'}`);
}

export function seatLabel(): string | null {
  if (!S.seat) return null;
  return `${S.plan?.floors[S.seat.floor]?.name ?? 'somewhere'} · ${S.seat.col}, ${S.seat.row}`;
}
