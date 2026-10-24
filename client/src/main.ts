/**
 * The client: the four places, the map, the figures, and the one wire.
 *
 * An editor is not a feature among others: everything that changes the building lives in Build, a figure
 * changes in Du and only when handed over. `router.ts` owns that rule; this file asks it before it sends.
 *
 * One S.canvas is moved between the two places that show a floor, so there is one floor, one camera and one
 * draw loop. This file holds the state the server last told it and wires the places together:
 *
 * | Module           | Holds                                                                  |
 * |------------------|------------------------------------------------------------------------|
 * | `scene`          | what every drawing needs: the S.canvas, the floor, the camera, a name    |
 * | `floorArt`       | the floor drawn: surfaces, open doors, room names                      |
 * | `standing`       | what stands, back to front: walls, shut doors, furniture, people       |
 * | `depth`          | how tall what stands is, and how a height is drawn                     |
 * | `overlay`        | what explains the floor: the audible area, the hint under the pointer  |
 * | `people`         | the figures: eased, facing, talking, muted, and „no way there"         |
 * | `buildingEditor` | Build: the tools, the gestures, the panels, and the only way an edit is sent |
 * | `buildOverlay`   | what Build draws over the floor: previews, selection, marquee, edges   |
 * | `figureEditor`   | Du: the draft figure, handed over once                                 |
 * | `settings`       | Einstellungen: the microphone, the wire, the two switches              |
 */

import { BuildingEditor, lockSentence } from './buildingEditor';
import { commandsFor, type CommandInput } from './commands';
import { toggledDoor } from './edit';

import { FigureEditor } from './figureEditor';
import { drawGround } from './floorArt';
import { areaOf, audibleArea, within } from './hearing';
import { roomOf } from './room';
import { Watcher } from './presence';
import { sceneNow, fitToWindow, fitZoom, openOn, openOnMe, pxPerM, planSize, resizeCanvas, smoothPeople, stageSize, stepCamera } from './cameraControl';
import { cellUnder, centreOn, cursorFor, installInput, openPersonMenu, personAt, renderPresence, renderStatus, renderSwitches, seatLabel, setMuted, stairExit, stairUnder, withinReach } from './input';
import { S } from './state';
import { drawAudibleArea, drawHover } from './overlay';
import { stairClimb } from './steering';

import { Crowd, drawNoWay } from './people';
import { mayBuild, mayDressFigure, type View } from './router';
import { host } from './host';
import { drawStanding, furniture, wallsAndDoors } from './standing';
import { stairs } from './stair';
import { Settings, type GivesWay, type RoomSettings } from './settings';
import { createShell } from './shell';
import { SQUASH } from './depth';
import { squashOf, toScreen, zoomOf } from './view';
import { drawGrain, drawHour, drawTable, drawVignette, hourNow } from './light';
import { onTheFloor } from './scene';
import { Minimap } from './minimap';
import { Voices, type PanSide, type SoundProfile } from './voice';
import { demoGuest, replacePlan, edit, join, parse, setFigure, speak, toggleDoor, walk, type Figure, type PersonView, type PlanFile, type Seat, answeredSummon } from './wire';

/** The room the last state was worked out for, so the console can show what a shut door did. */
S.lastRoom = { area: 0, absorption: 0.1 };

// ── the places ───────────────────────────────────────────────────────────────────────────────────────
// One S.canvas, moved between the office and the editor: both show the same floor, so the same drawing.
const officeView = document.querySelector<HTMLElement>('#view-office')!;
const officeStage = document.createElement('div');
officeStage.className = 'stage';
officeStage.id = 'office-stage';
S.canvas = document.createElement('canvas');
S.canvas.id = 'plan';
officeStage.append(S.canvas);
officeView.append(officeStage);

// The map in the corner: the whole building, small, and a click on it travels there.
S.minimapCanvas = document.createElement('canvas');
S.minimapCanvas.id = 'minimap';
S.minimapCanvas.className = 'minimap';
S.minimapCanvas.setAttribute('aria-label', 'Lageplan — klicken, um dorthin zu schauen');
S.minimapCanvas.setAttribute('role', 'img');
officeStage.append(S.minimapCanvas);
S.minimap = new Minimap(S.minimapCanvas);

const buildStage = document.querySelector<HTMLElement>('#build-stage')!;
S.ctx = S.canvas.getContext('2d')!;

const params = new URLSearchParams(location.search);
const machine = host();
// The scheme follows the page. The browser decides which certificates it trusts; the shell is always TLS.
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
/** The socket to open: the page's own server in a tab, the house's in the shell once it has said which. */
S.serverUrl = machine.kind === 'shell'
  ? null
  : params.get('server') ?? `${scheme}://${location.hostname || '127.0.0.1'}:8787/ws`;
/** Where the shell keeps a name somebody chose, in the webview's own storage on this machine. */
const NAME_KEY = 'office-mumble.name';
/** The name the system knows the person by, which the shell arrives under until another one is chosen. */
S.systemName = '';
/** The name to arrive under: the address's in a tab, the chosen one or the system's in the shell. */
S.wanted = params.get('name') ?? (machine.kind === 'shell' ? localStorage.getItem(NAME_KEY) ?? '' : '');

// ── state ────────────────────────────────────────────────────────────────────────────────────────────

/** The plan as the model carries it: one row of cell codes per floor row, and the size of a cell. */
S.floor = null;
/** The whole building, so the floor I am on can be looked up again when I take the stairs. */
S.plan = null;
/** Which floor I am on. One at a time: what I see, hear and edit is this floor. */
S.myFloor = 0;
S.cellM = 0.5;
/** Cells whose surface is not the floor's own, keyed by row and column so a lookup is one step. */
S.painted = new Map();
S.me = 0;
S.myName = S.wanted;
/** Where each figure is drawn, trailing the server's position by about a tick. The server moves ten times a
 *  second; a figure that jumps ten times a second reads as a stutter, not as walking. */
S.drawn = new Map<number, { x: number; y: number }>();
/** The share of the half-window my figure may walk inside without the view moving, until the settings say
 *  otherwise. Large, so the camera is still most of the time; squeeze it toward zero and it clings. */
const DEFAULT_DEAD_ZONE = 0.55;
/** Where my figure stood on the last tick: only a figure that moves takes the camera with it. */
S.lastMine = null;
S.transform = { scale: 1, ox: 0, oy: 0, squash: SQUASH };
/** True once the floor was fitted to a stage that had a size; a plan arriving while the editor is open has
 *  none. */
S.fitted = false;
/** The stage size the floor was last fitted to: the office and the editor frame it differently, so entering
 *  a place of another size fits again. */
S.fittedTo = { w: 0, h: 0 };

S.standing = new Map<number, PersonView>();
S.refused = null;
S.connection = 'connecting …';
S.socket = null;
/** Nobody is at the machine — the screen locked or it went to sleep, by the shell's word — so the client
 *  has left the office and does not knock again until somebody is back. */
S.away = false;

/** Who holds the edit lock, by the server's word: `null` is nobody. */
S.lock = { holder: null, name: null };
/** The last refusal — an edit, or a click with no way there — told inline until the next one replaces it. */
S.lastNo = '';
/** The cell under the pointer, so a door says what a click would do. */
S.hover = null;
/** The pointer's last place on the screen, kept so the cell under it can be worked out again when the camera
 *  moves on its own — a zoom glides, and a hand that does not move is still over a different cell afterwards. */
S.lastPointer = null;
/** Everybody the rule says I can hear, so silence is visible without a figure to speak. */
S.heard = [];

/** My own figure: the truth the server keeps for me, and what I am drawn as until the server says otherwise. */
S.myFigure = null;
/** True while my own microphone is above the speaking threshold, said to the server when it changes. */
S.myTalking = false;
/** My microphone is stopped. A gesture, and one the figure shows — a muted person is not talking. */
S.muted = false;
/** A figure the server refused: take its word for mine again on the next state message. */
S.resyncFigure = false;
/** The audible-area switch, off by default: a diagnostic, never the picture. */
S.showAudible = false;

/** Whether the room follows the clock: at nine in the evening it is warm and the lamps are on. A choice, kept
 *  on this machine, because a room that is always twilight is a mood somebody did not ask for. */
S.showLight = localStorage.getItem('office-mumble:light') !== 'off';
/** One of the three ways the room gives way, read as this machine last left it: on unless it was turned off. */
const stored = (which: keyof GivesWay): boolean => localStorage.getItem(`office-mumble:${which}`) !== 'off';
S.givesWay = { walls: stored('walls'), furniture: stored('furniture'), ghosts: stored('ghosts') };
/** The camera's dead zone: how far from the middle I may walk before the view follows. A preference of this
 *  window, not of the office — kept here like the clock, and 55% of the half-window unless I say otherwise. */
/** The place I arrive at, kept on this machine. A cell, not a chair: the plan may be furnished around it,
 *  and a seat that has since become a wall is refused by the server, which puts me at the spawn instead. */
const storedSeat = localStorage.getItem('office-mumble:seat');
S.seat = null;
if (storedSeat) {
  try {
    const at = JSON.parse(storedSeat) as Seat;
    if (Number.isFinite(at.row) && Number.isFinite(at.col)) S.seat = at;
  } catch {
    S.seat = null;
  }
}
const storedZone = localStorage.getItem('office-mumble:deadzone');
const parsedZone = storedZone === null ? NaN : Number(storedZone);
S.deadZone = Number.isFinite(parsedZone) ? Math.min(1, Math.max(0, parsedZone)) : DEFAULT_DEAD_ZONE;
/** The cells I can be heard from, as `row * width + col`, recomputed when I move or the switch is on. */
S.audibleCells = new Set<number>();
/** Where the server last put me, so the area is recomputed without waiting for a tick. */
S.minePlace = null;
/** Where I first arrived: the nearest thing this project has to „mein Platz", since there is no desk
 *  registry to read one from. */
S.arrival = null;
/** A door clicked from across the room: the walk is on its way, and the handle turns when I arrive. */
S.pendingDoor = null;

/** The drag in progress: panning the floor, or a gesture of the editor's. */
S.drag = null;
/** Where the pointer last was, in the terms the editor reads it in. */
S.pointer = null;
/** The space bar is held: any drag pans, whatever tool is on — the convention every S.canvas editor keeps. */
S.spaceHeld = false;
/** A resize the editor sent, so the camera can keep the building still when the floor grows up or left. */
S.resizePending = null;

/** How this listener wants the room played back: a taste, kept on this machine, never sent anywhere. */
S.soundProfile = (localStorage.getItem('office-mumble:sound') as SoundProfile | null) ?? 'room';
S.soundSide = (localStorage.getItem('office-mumble:side') as PanSide | null) ?? 'avatar';

/** The room's own sound, kept on this machine: taste, like the profile — the office is not told. */
const ROOM_DEFAULTS: RoomSettings = { studio: 4500, open: 12000, hallMax: 0.6, hallLevel: 0.15 };
function readRoom(): RoomSettings {
  try {
    const stored = JSON.parse(localStorage.getItem('office-mumble:room') ?? 'null') as Partial<RoomSettings> | null;
    return { ...ROOM_DEFAULTS, ...(stored ?? {}) };
  } catch {
    return ROOM_DEFAULTS;
  }
}
S.room = readRoom();

S.voices = new Voices(
  text => S.socket?.send(text),
  what => console.log('voice:', what),
);
S.voices.setSound(S.soundProfile, S.soundSide);
S.crowd = new Crowd();
S.building = new BuildingEditor(
  {
    view: () => S.shell.view(),
    floor: () => S.floor,
    cellM: () => S.cellM,
    painted: () => S.painted,
    send: change => S.socket?.send(edit(S.myFloor, change)),
    refuse: reason => showRefusal(reason),
    resizing: edges => {
      if (!S.floor) return;
      S.resizePending = {
        top: edges.top,
        left: edges.left,
        rows: S.floor.cells.length + edges.top + edges.bottom,
        cols: (S.floor.cells[0]?.length ?? 0) + edges.left + edges.right,
      };
    },
    fit: () => fitToWindow(),
  },
  () => {
    S.canvas.style.cursor = cursorFor();
  },
);
const figures = new FigureEditor({
  cancel: () => S.shell.place('office'),
  apply: applyFigure,
  refuse: showRefusal,
});
S.settings = new Settings(S.voices, {
  toggleMute: () => setMuted(!S.muted),
  toggleAudible: () => setAudible(!S.showAudible),
  toggleLight: () => setLight(!S.showLight),
  toggleGivesWay: (which) => setGivesWay(which, !S.givesWay[which]),
  setDeadZone: (share) => setDeadZone(share),
  takeSeat: () => takeSeat(),
  forgetSeat: () => forgetSeat(),
  chooseSound: (profile, side) => setSound(profile, side),
  setRoom: (next) => setRoom(next),
  isOpen: () => S.shell.view() === 'settings',
  name: machine.kind === 'shell' ? { current: () => S.wanted, give: nameGiven } : undefined,
  socket: () => S.serverUrl,
});
S.settings.showRoom(S.room);
S.voices.setRoom(S.room.studio, S.room.open);
S.voices.setHall(S.room.hallMax, S.room.hallLevel);

// ── the shell ────────────────────────────────────────────────────────────────────────────────────────

// The microphone in the status bar is also the switch: the place that names the state takes the click.
document.querySelector<HTMLButtonElement>('#status-mic-btn')?.addEventListener('click', () => setMuted(!S.muted));

S.shell = createShell({
  onView: (next) => entered(next),
  onCommand: (id) => runCommand(id),
  commands: () => commandsFor(commandInput()),
  // A test figure is asked for over the socket, like everything else this client says: the app pins the
  // certificate in its own code, so a plain request from the webview would be refused by a certificate it
  // has no reason to trust. See `docs/tls.md`.
  onDemoGuest: (on) => S.socket?.send(demoGuest(on)),
  onPersonMenu: (person, x, y) => openPersonMenu(person, x, y),
});
// The first place is announced by hand, after the shell exists: the rail and the title row were already
// put in order by `createShell`, but the map has to be moved into the office stage and sized, which needs
// this side of the pair.
entered(S.shell.view());

// ── the plan, out and in ────────────────────────────────────────────────────────────────────────────

/** The plan as a file, so an evening's building can be kept, sent, or put back. The download is the client's
 *  own: the server already has the plan, and asking it for a copy would be a message that changes nothing. */
document.querySelector<HTMLButtonElement>('#plan-export')?.addEventListener('click', () => {
  if (!S.plan) return;
  const blob = new Blob([JSON.stringify(S.plan, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'office-plan.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

const planFile = document.querySelector<HTMLInputElement>('#plan-file');
document.querySelector<HTMLButtonElement>('#plan-import')?.addEventListener('click', () => planFile?.click());
planFile?.addEventListener('change', async () => {
  const file = planFile.files?.[0];
  planFile.value = '';
  if (!file) return;
  try {
    const next = JSON.parse(await file.text()) as PlanFile;
    S.socket?.send(replacePlan(next));
  } catch (reason) {
    showRefusal(`that file is not a plan: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
});

/** The numbers of the voice connections, so anybody can read them out in the console — and so the harness
 *  can ask this page what it is hearing instead of guessing: `await officeMumble.stats()`. */
(window as unknown as { officeMumble?: unknown }).officeMumble = {
  stats: () => S.voices.readout(),
  // What the room does to the voices: open and shut the door and watch the numbers move.
  room: () => ({ ...S.lastRoom, ...S.voices.roomShape() }),
  // Who a right-click would land on, so a driver can tell a miss from a menu that did not open.
  personAt: (x: number, y: number) => personAt(x, y)?.name ?? null,
  // Which place is open, and the editor's own state inside it, so a driver can read what a click would do.
  place: () => S.shell.view(),
  floor: () => S.myFloor,
  floors: () => S.plan?.floors.map(entry => entry.name) ?? [],
  editor: () => ({
    ...S.building.readout(),
    lockHolder: S.lock.holder,
    zoom: zoomOf(S.transform, pxPerM()),
  }),
  // What stands on the floor, so a driver can read back what a gesture placed, moved or took away.
  objects: () => S.floor?.objects ?? [],
  size: () => ({ rows: S.floor?.cells.length ?? 0, cols: S.floor?.cells[0]?.length ?? 0 }),
  // Where the floor is on the screen, how far the S.canvas is from the window's corner, and what a cell
  // holds — so a driver can aim a click at a cell and then read back what the click did rather than guess.
  view: () => {
    const rect = S.canvas.getBoundingClientRect();
    return { ...S.transform, cellM: S.cellM, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  },
  cell: (row: number, col: number) => S.floor?.cells[row]?.[col] ?? null,
  // Where a cell is on the screen, so a driver can click one without redoing the projection.
  cellPoint: (row: number, col: number) => {
    const [x, y] = toScreen(S.transform, (col + 0.5) * S.cellM, (row + 0.5) * S.cellM);
    const rect = S.canvas.getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y };
  },
  stairs: () => S.floor?.stairs ?? [],
  me: () => S.me,
  // Where each figure is actually drawn, so a driver can tell a smooth walk from a ten-a-second jump.
  drawn: () => [...S.drawn].map(([id, at]) => ({ id, x: at.x, y: at.y })),
  // The figure editor and the speaking indicator, so a driver can read what was chosen and which cells the
  // audible-area switch is drawing. `figure` is the server's truth for me; `draft` is the open editor's.
  figure: () => ({
    figure: S.myFigure,
    draft: figures.draft,
    talking: S.myTalking,
    muted: S.muted,
    audible: S.showAudible,
    audibleCells: [...S.audibleCells],
  }),
  // Everybody the server says is on the floor, with the two facts a figure shows — so a driver can wait for
  // a colleague to be talking rather than guess from a picture.
  people: () =>
    [...S.standing.values()].map(person => ({
      id: person.id,
      name: person.name,
      x: person.x,
      y: person.y,
      floor: person.floor ?? 0,
      speaking: Boolean(person.speaking),
      muted: Boolean(person.muted),
      figure: person.figure ?? null,
    })),
};

// ── the camera ───────────────────────────────────────────────────────────────────────────────────────

/** One cell is 64 px at zoom 1 — the zoom's own yardstick, not an art decision. */

/** How big the S.canvas is on screen. Zero while a place without a map is open. */

/**
 * The S.canvas at its stage's size in device pixels. The view is left alone: a resize must not throw away the
 * zoom somebody chose.
 */

/** Fit the whole floor into the place that is showing it with a margin: the view a fresh page opens on. */

/** A point in the window turned into a point on the S.canvas: the map no longer starts at the corner. */

// ── the camera ────────────────────────────────────────────────��──────────────────────────────────────
// The view is aimed, not set: jumps, keys and zoom steps travel, so nothing cuts. Dragging is 1:1 with the
// pointer; letting go keeps the flick.

/** Where the camera is going when it is going somewhere; null once it has arrived, or was never told. */
S.goal = null;
/** A drag's velocity when it was let go, in screen pixels per second. */
S.flung = null;
/** Where the pointer was, and when, so two moves become a velocity. */
S.lastMove = null;
/** Whether the camera has already been placed on me: the first view of the office lands on you. */
S.openedOnMe = false;
/** Whether the first view still owes me a landing: a state can arrive before the plan it stands on. */
S.openAtMe = false;

/** Send the camera somewhere: it travels, it does not cut. */

/** Look at a point of the plan, without zooming out to get there. */

/** Land the first view on myself, once there is a plan to land on and a position to land at. */

/**
 * The people on my floor, with the position each figure is drawn at. A figure eases toward where the server
 * says it is, so the updates read as a walk — the easing time is shorter than a tick, so the drawing never
 * lags more than one update behind the truth.
 */

/** One frame: toward the goal, or a flick running out, then held inside the window. */

/**
 * Keep my figure in the window. Inside the dead zone the camera does not move at all; when the figure walks
 * out of it, one re-centring move puts it back in the middle and the camera is still again until the figure
 * leaves the new middle. Following every frame instead — squeezing the dead zone to nothing — makes the view
 * chase a figure that itself arrives in thirty steps a second, which is what reads as a stutter.
 */

// ── the drawing ──────────────────────────────────────────────────────────────────────────────────────

/** The floor as it is on the screen right now, or null while there is no floor. */

function draw(now: number, here: Map<number, PersonView>): void {
  const { w, h } = stageSize();
  if (w === 0 || h === 0) return; // a place without a map is open; there is nothing to draw on
  // The table the office stands on: light in the middle, dark corners.
  const size = planSize();
  drawTable(S.ctx, w, h, S.floor ? { width: size.w, height: size.h, transform: S.transform } : null);

  const scene = sceneNow();
  if (scene) {
    onTheFloor(scene, flat => {
      drawGround(flat, S.painted);
      if (S.showAudible) drawAudibleArea(flat, S.audibleCells);
    });
    // Back to front: walls, shut doors, stairs, furniture, people; over them the cell under the pointer, then the
    // words — room names, people's names, and the answer to a click with no way.
    const people = S.crowd.layout(scene, here, { id: S.me, figure: S.myFigure, talking: S.myTalking, muted: S.muted }, S.lock.holder, now);
    drawStanding(scene, [...wallsAndDoors(scene), ...stairs(scene), ...furniture(scene), ...people.figures]);
    if (S.givesWay.ghosts) people.ghosts();
    if (mayBuild(S.shell.view())) S.building.draw(scene);
    else drawHover(scene, S.hover, index => S.plan?.floors[index]?.name ?? '');
    // The hour goes on the room, never on its words: a label has to be readable at nine in the evening.
    if (S.showLight) drawHour(scene, w, h, hourNow());
    people.names();
    if (S.refused && now < S.refused.until) drawNoWay(scene, S.refused);
  }
  drawVignette(S.ctx, w, h);
  drawGrain(S.ctx, w, h);
  // Last, and outside the office's own light: the map is chrome, not part of the room it shows.
  if (S.floor) {
    S.minimap.draw(S.floor, S.cellM, [...here.values()], S.me, S.transform, w, h);
    // A map of an office you are looking at all of is not needed: it appears when the room does not fit.
    S.minimapCanvas.hidden = zoomOf(S.transform, pxPerM()) <= fitZoom() * 1.08;
  }
}

/** The zoom at which the whole floor fits the stage: below it the map has nothing to say. */

// ── the status bar and the presence rail ─────────────────────────────────────────────────────────────

/** The colour an avatar wears: the shirt its figure is drawn in, so the rail and the map agree. */

/** Where somebody is to me right now: heard, on my floor but out of reach, or a floor up or down. */

/** The one demo figure this server offers: its name and recording, `null` when there is none to give. */
S.demo = { name: 'Mark-Uwe', voice: null as string | null };
/** Whether the test figure was on the floor at the last state, so putting it back is a change the camera
 *  can answer rather than something it does on every reload. */
S.demoWasHere = false;

/** Everybody on the floor I am on — the only people I can see, hear or walk into. */

// ── acting on a person ──────────────────────────────────────────────────────────────────────────────

/** People I have turned down for myself: never told to the server, never a rule, just my ears. */
S.mutedPeople = new Set<number>();
/** Whom I am walking after, if anybody: the id, and the timer that keeps asking the server for the next step. */
S.following = null;
S.followTimer = null;

/** A metre short of somebody, on my side of them: standing on a person means standing nowhere. */

/** Walk after somebody until I go somewhere myself, or they leave this floor. Near enough is near enough:
 *  a follower that keeps pressing into your back is not following, it is pushing. */

/** The actions on one person, opened where they were asked for. Everything that cannot be done is said in
 *  the row itself: a greyed button with no reason is a puzzle. */

/** Who holds the building, said in the editor, in its title row and on the rail. */
function renderBuildBanner(): void {
  S.building.showLock(S.lock, S.me, S.standing);
  // The line belongs to the editor's title row. A state message arrives ten times a second whatever place
  // is open, so the tail is only written when the editor is the place that is open.
  if (S.shell.view() === 'build') S.shell.setWhereTail(`· ${S.floor?.name ?? '—'} · ${lockSentence(S.lock, S.me)}`);
  S.shell.setBuildBadge(S.lock.holder !== null && S.lock.holder !== S.me ? `${S.lock.name ?? 'Someone'} is building` : null);
}

// ── the figure, handed over ──────────────────────────────────────────────────────────────────────────

/** Hand the draft over: one write, and the only one this place ever makes. */
function applyFigure(figure: Figure): void {
  if (!mayDressFigure(S.shell.view())) return; // the rule, not a habit: nothing else may dress a figure
  S.myFigure = figure;
  S.socket?.send(setFigure(S.myFigure));
  S.shell.place('office');
}

/** The server's no, and the client's own: told in the status bar, in words, and kept until the next one. */
function showRefusal(reason: string): void {
  S.lastNo = reason;
}

/** Work out the cells I can be heard from, from where the server last put me. Only while the switch is on. */
function refreshAudible(reach?: Map<number, number>): void {
  if (!S.showAudible || !S.floor || !S.minePlace) {
    S.audibleCells = new Set();
    return;
  }
  S.audibleCells = audibleArea(S.floor.cells, S.cellM, { id: S.me, x: S.minePlace.x, y: S.minePlace.y }, reach);
}

// ── the switches, wherever they are reached from ─────────────────────────────────────────────────────

/** Stop or start the microphone. A mute is a gesture and not a status: it is told to the server, and it is
 *  carried on the figure so nobody reads a stopped microphone as words they heard. */

function setAudible(next: boolean): void {
  S.showAudible = next;
  refreshAudible();
  renderSwitches();
}

/** Whether the room follows the clock. Kept on this machine: a room fixed at dusk is a mood, not a default. */
/** Where I arrive, in words: the floor's name and the cell, or nothing when I have not chosen one. */

/** Take the cell under my feet. The desk is wherever I stand, which is the only definition that survives an
 *  edited plan: a chair may move, the cell I chose is still the answer I gave. */
function takeSeat(): void {
  const mine = S.standing.get(S.me);
  if (!mine) return;
  S.seat = { floor: mine.floor ?? S.myFloor, row: Math.floor(mine.y / S.cellM), col: Math.floor(mine.x / S.cellM) };
  localStorage.setItem('office-mumble:seat', JSON.stringify(S.seat));
  S.settings.showSeat(seatLabel());
}

function forgetSeat(): void {
  S.seat = null;
  localStorage.removeItem('office-mumble:seat');
  S.settings.showSeat(null);
}

/** A camera preference, kept on this machine: the office is shared, the way I look at it is mine. */
function setDeadZone(share: number): void {
  S.deadZone = share;
  localStorage.setItem('office-mumble:deadzone', String(share));
}

function setLight(next: boolean): void {
  S.showLight = next;
  localStorage.setItem('office-mumble:light', next ? 'on' : 'off');
  renderSwitches();
}

/** A way the room gives way, turned: a look kept on this machine, not a preference of the office. */
function setGivesWay(which: keyof GivesWay, next: boolean): void {
  S.givesWay[which] = next;
  localStorage.setItem(`office-mumble:${which}`, next ? 'on' : 'off');
  renderSwitches();
}

/** The sound profile and side, chosen here and kept on this machine: taste, not a preference of the office. */
function setSound(profile: SoundProfile, side: PanSide): void {
  S.soundProfile = profile;
  S.soundSide = side;
  localStorage.setItem('office-mumble:sound', profile);
  localStorage.setItem('office-mumble:side', side);
  S.voices.setSound(profile, side);
  renderSwitches();
}

/** The four room settings, kept here and given to the voices at once: a change is heard while it is made. */
function setRoom(next: RoomSettings): void {
  S.room = next;
  localStorage.setItem('office-mumble:room', JSON.stringify(S.room));
  S.voices.setRoom(S.room.studio, S.room.open);
  S.voices.setHall(S.room.hallMax, S.room.hallLevel);
  S.settings.showRoom(S.room);
}

/** The events at the foot of the rail: who came, who went, who changed floor. */
const watch = new Watcher();

/** Ask somebody to come over. A question, not a command: their client shows who is calling and decides. */

/** What has moved since the last state: who arrived, who left, who changed floor. The list is compared
 *  with the one before it, so the server needs to say nothing new — a person's floor is already in the state. */
/** The switches, drawn from the state wherever they are on screen, and the status bar told. */

// ── interaction ──────────────────────────────────────────────────────────────────────────────────────

/** The floor cell under a screen point, or null when the point is off the floor. */

/** Where a pointer event is, in the terms the editor reads it in: the cell (clamped to the floor), the
 *  point on the plan, the point on the S.canvas, and whether it is on the floor at all. */

/// The stair whose flight covers a cell, if any: a click on any tread is a click on the stair.

/// The tread you leave the floor by: the middle of the flight's exit edge. Clicking the stair walks there,
/// so a click on the bottom step is a click that takes you up rather than one that stops halfway.

/// Whether my hand could reach a door: the server's own reach, a little tighter, so a click at the edge of it
/// is not refused by the time the walk has ended.

/**
 * A click in the office: walk there, or work the door under the pointer. A door is not an edit — no lock,
 * anybody may work it — and it is the one act the office keeps, because the hearing rule turns on it.
 */

// ── walking with the keys ────────────────────────────────────────────────────────────────────────────

/** Which arrow keys are down. Held, they are a direction; let go and the figure finishes the step it was on. */
S.steering = null;

/** One step of a metre in the direction held — two cells, so a tap is a step and a hold is a walk. The server
 *  does the rest: the path goes round the furniture and the camera follows as it always does. */

/** A new target every so often while a key is held: at walking speed the figure is always a step short of it,
 *  which is what makes it keep going rather than stop at each one. */

/** The person under the pointer, if any. A figure is drawn upward from where it stands, so the reach is
 *  measured from the feet and is a little wider than the cell — a click on the head is a click on the person. */

installInput();

// ── the places' wiring ───────────────────────────────────────────────────────────────────────────────

/**
 * A place was entered: the map moves in, the place is prepared, and the S.canvas is sized now — a hidden
 * S.canvas has no size, and a fit against zero would put the floor nowhere.
 */
function entered(next: View): void {
  const stage = next === 'office' ? officeStage : next === 'build' ? buildStage : null;
  if (stage && S.canvas.parentElement !== stage) stage.append(S.canvas);
  S.hover = null;
  if (next === 'build') renderBuildBanner();
  if (next === 'figure') figures.enter(S.myFigure, S.myName);
  if (next === 'settings') {
    renderSwitches();
    S.settings.refresh();
  }
  if (next === 'office') S.shell.setWhereTail(`· ${S.floor?.name ?? '—'}`);
  if (next === 'figure') S.shell.setWhereTail('· your figure');
  if (next === 'settings') S.shell.setWhereTail('· sound, connection, keyboard');
  S.shell.showLeaveControl(next === 'build');
  resizeCanvas();
  const { w, h } = stageSize();
  if (stage && (!S.fitted || w !== S.fittedTo.w || h !== S.fittedTo.h)) fitToWindow();
  S.canvas.style.cursor = cursorFor();
}

/** What the palette may offer: only what the client already knows, and never a way to change the plan. */
function commandInput(): CommandInput {
  return {
    view: S.shell.view(),
    muted: S.muted,
    showAudible: S.showAudible,
    showLight: S.showLight,
    people: [...S.standing.values()].map(person => ({ id: person.id, name: person.name, me: person.id === S.me })),
    rooms: (S.floor?.labels ?? []).map(room => ({ text: room.text, row: room.row, col: room.col })),
  };
}

/** Centre the view on a place: it moves the camera, not the person, and never zooms out. */

/** Run a palette row. Jumping moves the camera; acting is one of the handful of acts with no place of its own. */
function runCommand(id: string): void {
  if (id === 'mute') {
    setMuted(!S.muted);
    return;
  }
  if (id === 'audible') {
    setAudible(!S.showAudible);
    return;
  }
  if (id === 'light') {
    setLight(!S.showLight);
    return;
  }
  if (id === 'fit') {
    fitToWindow();
    return;
  }
  if (id === 'here') {
    const mine = S.standing.get(S.me);
    if (mine) openOn(mine.x, mine.y);
    return;
  }
  if (id === 'open-office') {
    S.shell.place('office');
    return;
  }
  if (id === 'open-build') {
    S.shell.place('build');
    return;
  }
  if (id === 'open-figure') {
    S.shell.place('figure');
    return;
  }
  if (id === 'open-settings') {
    S.shell.place('settings');
    return;
  }
  if (id === 'my-place') {
    // There is no desk registry in this project: „mein Platz" is where the server first put me, and walking
    // there is the only honest reading of the row. With no arrival yet there is nothing to do.
    if (S.arrival) S.socket?.send(walk(S.arrival.x, S.arrival.y));
    return;
  }
  if (id.startsWith('to:')) {
    const person = S.standing.get(Number(id.slice(3)));
    if (person) centreOn(person.x, person.y);
    return;
  }
  if (id.startsWith('room:')) {
    const [, row, col] = id.split(':');
    centreOn((Number(col) + 0.5) * S.cellM, (Number(row) + 0.5) * S.cellM);
    return;
  }
  if (id.startsWith('floor:')) {
    // One floor is what the wire carries today, so a floor jump shows the whole of the one there is.
    fitToWindow();
  }
}

// ── the wire ────────────────────────────────────────────────────────────────────────────────────────

function connect(): void {
  if (S.away || S.socket || !S.serverUrl) return;
  // Every handler asks whether its socket is still the one in use: a socket let go on a lock still closes
  // a moment later, and its close must not take the socket opened on the unlock with it.
  const ws = machine.open(S.serverUrl);
  S.socket = ws;
  // A socket that never opened keeps the reason it failed in the status: the close that follows every error
  // would otherwise overwrite the one sentence that says what to check.
  let opened = false;
  ws.onopen = () => {
    if (S.socket !== ws) return;
    opened = true;
    S.connection = 'connected';
    ws.send(join(S.wanted, S.seat ?? undefined));
  };
  ws.onclose = () => {
    if (S.socket !== ws) return;
    if (opened) S.connection = 'disconnected — retrying';
    S.socket = null;
    setTimeout(connect, 1500);
  };
  ws.onerror = (reason) => {
    if (S.socket !== ws) return;
    S.connection = reason ? `server unreachable — ${reason}` : 'server unreachable';
  };
  ws.onmessage = (text) => {
    if (S.socket !== ws) return;
    const message = parse(text);
    if (!message) return;
    if (message.type === 'plan') {
      // The whole plan, from the server, every time anyone edits anything: the client holds no truth of
      // its own, and a preview drawn ahead of the server is printed over here.
      S.plan = message.plan;
      // The building is sent whole; which floor I am on is the state's fact, not the plan's.
      S.myFloor = S.standing.get(S.me)?.floor ?? S.myFloor;
      S.floor = S.plan.floors[S.myFloor] ?? S.plan.floors[0] ?? null;
      S.cellM = S.plan.cell_m;
      S.painted = new Map((S.floor?.painted ?? []).map(cell => [cell.row * 1000 + cell.col, cell.surface]));
      S.shell.setFloorName(S.floor?.name ?? '—');
      if (S.shell.view() === 'office') S.shell.setWhereTail(`· ${S.floor?.name ?? '—'}`);
      // A floor grown at its top or left moved everything on it down or right in the grid. The camera moves
      // the other way by as much, so the building stays where it was on the screen and only the edge moves.
      const grown = S.resizePending;
      S.resizePending = null;
      if (grown && S.floor && S.floor.cells.length === grown.rows && (S.floor.cells[0]?.length ?? 0) === grown.cols) {
        S.transform = {
          ...S.transform,
          ox: S.transform.ox - grown.left * S.cellM * S.transform.scale,
          oy: S.transform.oy - grown.top * S.cellM * S.transform.scale * squashOf(S.transform),
        };
      }
      if (!S.fitted) fitToWindow();
      if (S.openAtMe) openOnMe();
      S.building.planArrived();
      renderBuildBanner();
    } else if (message.type === 'hello') {
      S.me = message.id;
      S.myName = message.name;
      // Arriving again — after a lock, a sleep or a dropped connection — is arriving as the same person: the
      // server keeps a name and a figure only for as long as a connection lasts, so both are carried back.
      S.wanted = S.myName;
      if (S.myFigure) ws.send(setFigure(S.myFigure));
      S.voices.joined(message.id);
      figures.showName(S.myName);
    } else if (message.type === 'state') {
      S.shell.setEvents(watch.track(message.people, S.me, Date.now()).map(event => event.text));
      S.standing = new Map(message.people.map(person => [person.id, person]));
      // Putting the test figure on the floor is a demonstration, so the camera goes where it landed — but
      // only on a change: a reload must not steal the opening shot.
      const guest = message.people.find(person => person.avatar === true);
      if (guest && !S.demoWasHere && S.openedOnMe) centreOn(guest.x, guest.y);
      S.demoWasHere = guest !== undefined;
      // The rule decides who I am to be connected to; the server's positions are what it works on, not the
      // eased ones being drawn. The list is on screen so a shut door going quiet is something to see.
      const mine = S.standing.get(S.me);
      if (mine) {
        // Taking the stairs is a change of floor, and the floor I am on is the only one there is: the map,
        // the names, the painted cells and the camera all move to it.
        if ((mine.floor ?? 0) !== S.myFloor) {
          S.myFloor = mine.floor ?? 0;
          S.floor = S.plan?.floors[S.myFloor] ?? S.floor;
          S.painted = new Map((S.floor?.painted ?? []).map(cell => [cell.row * 1000 + cell.col, cell.surface]));
          S.shell.setFloorName(S.floor?.name ?? '—');
          if (S.shell.view() === 'office') S.shell.setWhereTail(`· ${S.floor?.name ?? '—'}`);
          S.building.planArrived();
          openOnMe();
        }
        // A door I clicked from across the room: the walk has brought me within a hand of it, so the handle
        // turns now — once, and only if it is still a door.
        if (S.pendingDoor && mine) {
          if ((mine.floor ?? 0) !== S.pendingDoor.floor) {
            S.pendingDoor = null;
          } else if (withinReach(S.pendingDoor.row, S.pendingDoor.col)) {
            const { row, col } = S.pendingDoor;
            S.pendingDoor = null;
            const cell = S.plan?.floors[mine.floor ?? 0]?.cells[row]?.[col];
            const toggled = cell ? toggledDoor(cell) : null;
            if (toggled !== null && S.floor) {
              S.floor.cells[row][col] = toggled;
              S.socket?.send(toggleDoor(mine.floor ?? 0, row, col));
            }
          }
        }
        S.minePlace = { x: mine.x, y: mine.y };
        if (S.arrival === null) S.arrival = { x: mine.x, y: mine.y };
        // The first sight of myself is where the camera lands: at the fitted zoom a person is eight pixels
        // tall. If the plan has not arrived, the landing waits for it.
        if (!S.openedOnMe) {
          S.openedOnMe = true;
          S.openAtMe = true;
          openOnMe();
        }
        // The server's own figure for me the first time, and again after it refused one; my own choice
        // otherwise, so a figure is drawn the moment it is handed over rather than a tick later.
        if (S.myFigure === null || S.resyncFigure) {
          S.resyncFigure = false;
          S.myFigure = mine.figure ?? {};
          if (S.shell.view() === 'figure') figures.enter(S.myFigure, S.myName);
        }
        // The ceiling is a wall: somebody upstairs is not in my area, so neither the rule nor the voice
        // connections are asked about them.
        const sameFloor = message.people.filter(person => (person.floor ?? 0) === (mine.floor ?? 0));
        const everyone = sameFloor.map(person => ({ id: person.id, x: person.x, y: person.y }));
        // One flood fill per state message, shared by the rule, the sidebar and the voice connections: the
        // area is the same question asked three times, and it was being answered three times.
        const here = { id: S.me, x: mine.x, y: mine.y };
        const reach = areaOf(S.floor?.cells ?? [], S.cellM, here);
        // The room I am in is the reach I was just given: a small office behind a shut door has its own size
        // and its own carpets, not the whole floor's.
        const room = S.floor ? roomOf(S.floor, reach) : { area: 0, absorption: 0.1 };
        S.lastRoom = room;
        let nearby = within(S.floor?.cells ?? [], S.cellM, here, everyone, reach);
        let heardPeople = sameFloor;
        // On the flight the ceiling stops being a wall: the higher I climb, the more of the floor above comes
        // through and the less of my own. At the last tread the voice has already crossed.
        const under = S.floor ? stairUnder(S.floor, Math.floor(mine.y / S.cellM), Math.floor(mine.x / S.cellM)) : undefined;
        const climb = under ? stairClimb(under, mine.x, mine.y, S.cellM) : 0;
        if (under && climb > 0 && S.plan) {
          const above = S.plan.floors[under.to];
          const others = message.people.filter(person => (person.floor ?? 0) === under.to);
          if (above && others.length > 0) {
            const exit = stairExit(under);
            const top = { id: S.me, x: (exit.col + 0.5) * S.cellM, y: (exit.row + 0.5) * S.cellM };
            const aboveNear = within(above.cells, S.cellM, top, others.map(person => ({ id: person.id, x: person.x, y: person.y })));
            nearby = [
              ...nearby.map(entry => ({ ...entry, level: entry.level * (1 - climb) })),
              ...aboveNear.map(entry => ({ ...entry, level: entry.level * climb })),
            ];
            heardPeople = [...sameFloor, ...others];
          }
        }
        S.heard = nearby
          .filter(entry => entry.level > 0)
          .map(entry => S.standing.get(entry.id))
          .filter((person): person is PersonView => person !== undefined);
        S.voices.update(nearby, heardPeople, { ...here, facing: S.crowd.facingOf(S.me) ?? undefined, yaw: S.transform.yaw }, room, performance.now());
        refreshAudible(reach);
      }
      renderPresence();
      renderBuildBanner();
    } else if (message.type === 'summoned') {
      // Sixty seconds, then the question lapses: a call is not a queue, and nobody owes an answer.
      let answered = false;
      const answer = (accept: boolean) => {
        if (answered) return;
        answered = true;
        S.socket?.send(answeredSummon(message.from, accept));
      };
      S.shell.setSummon({ from: message.name }, () => answer(true), () => answer(false));
      window.setTimeout(() => {
        if (!answered) {
          answered = true;
          S.shell.setSummon(null, () => {}, () => {});
        }
      }, 60_000);
    } else if (message.type === 'summon_answer') {
      if (message.accepted) {
        showRefusal(`${message.name} is on the way`);
      }
    } else if (message.type === 'introduction') {
      void S.voices.received(message.from, 'introduction');
    } else if (message.type === 'signal') {
      void S.voices.received(message.from, 'signal', message.payload);
    } else if (message.type === 'no_way') {
      S.refused = { x: message.x, y: message.y, until: performance.now() + 1500 };
      // The cross on the map is gone in a moment and it says nothing to somebody who looked away, so the
      // same answer is mirrored inline where the microphone is — the one place a message must never take.
      showRefusal('no way there — a shut door or a wall makes it impossible');
    } else if (message.type === 'lock') {
      S.lock = { holder: message.holder, name: message.name };
      renderBuildBanner();
    } else if (message.type === 'refused') {
      // Told inline and kept: the status bar is where a refusal lives, and it never takes the microphone's
      // place, so nobody has to notice a message before it goes away.
      showRefusal(message.reason);
      // Whatever was refused, the server's word for me is the one in force: take it again on the next
      // state message rather than keep drawing something the server would not draw.
      S.resyncFigure = true;
      console.log('the server refused an edit:', message.reason);
    } else if (message.type === 'demo') {
      // What this server's one demo figure is — its name and the recording it speaks. Said on arrival, so the
      // button knows what it would make.
      S.demo = { name: message.name, voice: message.voice };
      renderPresence();
    } else if (message.type === 'avatar_problem') {
      // A figure could not be made or sent home. Said where every other refusal is said: it stays until the
      // next one replaces it, so nobody has to catch it.
      showRefusal(message.why);
      console.log('a test figure could not be made:', message.why);
    }
  };
}

/**
 * Whether somebody is at the machine, by the host's word. Gone ends the connection, as closing the window
 *  does; back is arriving again. The browser says present once; the shell says gone on a screen lock.
 */
function presenceChanged(present: boolean): void {
  if (!present) {
    if (!S.away) leaveOffice();
    return;
  }
  const returning = S.away;
  S.away = false;
  if (returning) S.connection = 'connecting …';
  connect();
  // The sound was opened by a gesture before the lock and is still open, so the microphone is taken again
  // without one. A page that never had its gesture waits for it, as it always has.
  if (returning && S.voices.started) void S.voices.start();
}

function leaveOffice(): void {
  S.away = true;
  const ws = S.socket;
  S.socket = null;
  ws?.close();
  S.voices.leave();
  S.muted = false;
  S.myTalking = false;
  S.me = 0;
  S.standing = new Map();
  S.heard = [];
  S.minePlace = null;
  S.arrival = null;
  S.connection = 'away — the machine is locked or asleep';
  renderSwitches();
}

/** A name chosen in the shell, kept on this machine; empty goes back to the system's. The office is
 *  entered anew under it, because a name is taken on arrival and nowhere else. */
function nameGiven(name: string): void {
  const chosen = name.trim();
  if (chosen) localStorage.setItem(NAME_KEY, chosen);
  else localStorage.removeItem(NAME_KEY);
  S.wanted = chosen || S.systemName;
  const ws = S.socket;
  S.socket = null;
  ws?.close();
  S.connection = 'connecting …';
  connect();
}

// The first gesture is what opens the microphone and the sound: no browser does it without one, so until
// somebody has clicked, the office is a map and nothing more.
window.addEventListener('pointerdown', () => {
  void S.voices.start().then(() => {
    if (S.shell.view() === 'settings') void S.settings.refreshDevices();
  });
});

window.addEventListener('resize', () => {
  resizeCanvas();
  if (!S.fitted) fitToWindow();
});

S.building.fill();
figures.fill();
renderSwitches();
resizeCanvas();
machine.onPresence(presenceChanged);
// The shell was built for one house and knows whom it runs for: it connects as soon as it has said both.
void machine.house().then((house) => {
  if (!house) return;
  S.serverUrl = house.socket;
  S.systemName = house.user;
  if (!S.wanted) S.wanted = S.systemName;
  connect();
});
// A dev hook: the camera as it actually is, for measuring a look instead of guessing at one.
(globalThis as unknown as { __cam?: () => unknown }).__cam = () => ({
  scale: S.transform.scale, ox: S.transform.ox, oy: S.transform.oy,
  goal: S.goal && S.goal.scale, zoom: zoomOf(S.transform, pxPerM()), cellM: S.cellM, stage: stageSize(),
  stageW: S.canvas.clientWidth, stageH: S.canvas.clientHeight,
});

S.lastFrame = 0;
requestAnimationFrame(function frame(now: number) {
  // The camera moves before anything is drawn, and by the time that has passed since the last frame — a
  // fixed step would make the glide faster on a fast screen and slower on a slow one.
  const dt = S.lastFrame === 0 ? 16 : Math.min(50, now - S.lastFrame);
  S.lastFrame = now;
  const here = smoothPeople(dt);
  stepCamera(dt, here);
  // The camera may have moved under a still hand: the cell under the pointer is worked out again, or the hover
  // would stay on the cell it was over before a zoom moved the floor away.
  if (S.lastPointer) S.hover = cellUnder(S.lastPointer.x, S.lastPointer.y);
  tellTalking();
  draw(now, here);
  renderPresence();
  renderStatus();
  requestAnimationFrame(frame);
});

/** Say to the server when my own microphone crosses the speaking threshold, and only then. */
function tellTalking(): void {
  const nowTalking = S.voices.talking();
  if (nowTalking === S.myTalking) return;
  S.myTalking = nowTalking;
  S.socket?.send(speak(nowTalking));
}
