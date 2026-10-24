/**
 * What the client keeps between frames: the plan the server last sent, where the camera is, what the hand is
 * in the middle of, and the switches this machine remembers. One object, because every part of the client
 * acts on the same truth — and because anything that can be handed this has an edge.
 *
 * Nothing here decides anything. It is the shape of the client's memory, not its behaviour.
 */

import type { BuildingEditor, Lock, PointerAt } from './buildingEditor';
import type { PaintedCells } from './floorArt';
import type { Wire } from './host';
import type { Minimap } from './minimap';
import type { Crowd } from './people';
import type { GivesWay, RoomSettings, Settings } from './settings';
import type { Transform } from './view';
import type { Shell } from './shell';
import type { PanSide, SoundProfile, Voices } from './voice';
import type { Figure, Floor, PersonView, PlanFile, Seat } from './wire';

/** A gesture on the canvas that has not ended yet. */
export type Drag = { kind: 'pan'; x: number; y: number; moved: boolean } | { kind: 'build' } | null;

export class State {
  mutedPeople!: Set<number>;
  minimapCanvas!: HTMLCanvasElement;
  minimap!: Minimap;
  voices!: Voices;
  crowd!: Crowd;
  building!: BuildingEditor;
  settings!: Settings;
  shell!: Shell;
  canvas!: HTMLCanvasElement;
  ctx!: CanvasRenderingContext2D;
  lastRoom!: { area: number; absorption: number; };
  serverUrl!: string | null;
  systemName!: string;
  wanted!: string;
  floor!: Floor | null;
  plan!: PlanFile | null;
  myFloor!: number;
  cellM!: number;
  painted!: PaintedCells;
  me!: number;
  myName!: string;
  drawn!: Map<number, { x: number; y: number; }>;
  lastMine!: { x: number; y: number } | null;
  transform!: Transform;
  fitted!: boolean;
  fittedTo!: { w: number; h: number; };
  standing!: Map<number, PersonView>;
  refused!: { x: number; y: number; until: number } | null;
  connection!: string;
  socket!: Wire | null;
  away!: boolean;
  lock!: Lock;
  lastNo!: string;
  hover!: [number, number] | null;
  lastPointer!: { x: number; y: number } | null;
  heard!: PersonView[];
  myFigure!: Figure | null;
  myTalking!: boolean;
  muted!: boolean;
  resyncFigure!: boolean;
  showAudible!: boolean;
  showLight!: boolean;
  /** The three ways the room gives way to the camera from behind (`V`), each a switch in the settings and kept
   *  on this machine: the office is shared, the way I look at it is mine. */
  givesWay!: GivesWay;
  seat!: Seat | null;
  deadZone!: number;
  audibleCells!: Set<number>;
  minePlace!: { x: number; y: number } | null;
  arrival!: { x: number; y: number } | null;
  pendingDoor!: { floor: number; row: number; col: number } | null;
  drag!: Drag;
  pointer!: PointerAt | null;
  spaceHeld!: boolean;
  resizePending!: { top: number; left: number; rows: number; cols: number } | null;
  soundProfile!: SoundProfile;
  soundSide!: PanSide;
  room!: RoomSettings;
  goal!: Transform | null;
  flung!: { vx: number; vy: number } | null;
  lastMove!: { x: number; y: number; at: number } | null;
  openedOnMe!: boolean;
  openAtMe!: boolean;
  demo!: { name: string; voice: string | null; };
  demoWasHere!: boolean;
  following!: number | null;
  followTimer!: ReturnType<typeof setInterval> | null;
  steering!: ReturnType<typeof setInterval> | null;
  lastFrame!: number;
  /** The view from behind my figure (`V`), and how far the camera has come down into it, 0 to 1. */
  behindOn = false;
  descent = 0;
  /** The way I have been walking, smoothed, and the yaw the camera turns towards. */
  heading: { x: number; y: number } | null = null;
  yawGoal = 0;
  /** The scale the view from behind is drawn at: the wheel sets it. */
  behindScale = 0;
  /** The yaw the arrow keys were pressed under: held until they are all let go, so a turning camera does not
   *  turn the walk with it. */
  steerYaw: number | null = null;
}

/** The one state of this client. A module that takes it as a parameter has a seam. */
export const S = new State();
