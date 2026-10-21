/** The messages, mirrored from the Rust crate `wire`. Kept dumb on purpose: it parses, it does not think. */

/** The parts of a figure, each named by a style the drawing knows (see `figure.ts` for the vocabulary),
 *  or absent for the style that part is drawn in by default. A name here is the seam a sprite set arrives
 *  through: the field already carries a name, so a sprite name can stand where a drawn style stands. */
export type Parts = { head?: string | null; body?: string | null; arms?: string | null; top?: string | null; extra?: string | null };

/** What a figure's parts are painted: hex `#rrggbb`. */
export type Palette = { skin: string; hair: string; shirt: string; trousers: string };

/** The figure a person owns: the parts and the colours they wear. Optional on the wire, so a state
 *  message written before figures existed is still a person. */
export type Figure = { parts?: Parts; palette?: Palette };

export type PersonView = {
  id: number;
  name: string;
  x: number;
  y: number;
  figure?: Figure;
  /** Their own microphone is above the speaking threshold. Absent means silent. */
  speaking?: boolean;
  /** Their microphone is stopped: they still hear, and transmit nothing. Absent means transmitting. */
  muted?: boolean;
  /** A test avatar: a figure nobody is behind. The sidebar offers to send one home, and only one of those
   *  may be sent home. */
  avatar?: boolean;
  /** Which floor they are on. Absent means the ground floor, so an older state message is one floor with
   *  everybody on it. */
  floor?: number;
};

/** One cell of a floor, exactly as the model names it. */
export type Cell = 'void' | 'floor' | 'wall' | 'window' | 'doorOpen' | 'doorShut';

/** A cell whose surface differs from the floor's own. */
export type Painted = { row: number; col: number; surface: string };

/** Something standing on a cell, named by the sprite set the client draws from. */
export type Object = { kind: string; row: number; col: number; facing: string };

/** A room's name, or the coffee corner, anchored to a cell. */
export type Label = { text: string; row: number; col: number };

/** One cell set to a code, as a drag over the floor produces. */
export type CellChange = { row: number; col: number; cell: Cell };

/** A place to arrive at, carried from the last visit: one cell on one floor. */
export type Seat = { floor: number; row: number; col: number };

/** A cell whose surface an edit sets. */
export type PatchChange = { row: number; col: number; surface: string };

/** One piece carried from its cell to another and turned on the way. */
export type Shift = { row: number; col: number; to_row: number; to_col: number; facing: string };

/**
 * A change to the building, mirroring the Rust `Edit`: what the client says, not what it does.
 */
export type Edit =
  | { action: 'cells'; cells: CellChange[] }
  | { action: 'paint'; cells: PatchChange[] }
  | { action: 'place'; objects: Object[] }
  | { action: 'clear'; cells: Array<{ row: number; col: number }> }
  | { action: 'arrange'; moves: Shift[] }
  | { action: 'resize'; top: number; right: number; bottom: number; left: number }
  | { action: 'label'; row: number; col: number; text: string }
  | { action: 'unlabel'; row: number; col: number };

/** A way from this floor to another one: the cell it stands on, and the floor it leads to. */
export type Stair = {
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** The side you step off at: the last tread of the climb. */
  exits: 'north' | 'south' | 'east' | 'west';
  to: number;
};

/** One floor of the building: its cells, and what else sits on them. */
export type Floor = {
  name: string;
  surface: string;
  cells: Cell[][];
  painted: Painted[];
  objects: Object[];
  labels: Label[];
  /** Absent on a building with one floor. */
  stairs?: Stair[];
};

/** The whole plan as the server holds it and serves it. `arrival` is where somebody without a seat arrives. */
export type PlanFile = { version: number; cell_m: number; floors: Floor[]; arrival?: Seat };

export type ToClient =
  | { type: 'plan'; id: string; plan: PlanFile }
  | { type: 'hello'; id: number; name: string }
  | { type: 'state'; people: PersonView[] }
  | { type: 'no_way'; x: number; y: number }
  | { type: 'introduction'; from: number }
  | { type: 'signal'; from: number; payload: string }
  | { type: 'lock'; holder: number | null; name: string | null }
  | { type: 'refused'; reason: string }
  /** The recordings a test avatar may be given, sent to everybody as they arrive. */
  | { type: 'voices'; names: string[] }
  /** What this server's one demo figure is: the name the sidebar shows and the recording it speaks, or
   *  `null` for the recording when the server has none to give. Sent as the client arrives. */
  | { type: 'demo'; name: string; voice: string | null }
  /** A test avatar could not be made or sent home, and this says why. */
  | { type: 'avatar_problem'; why: string }
  /** Somebody asks me to come over, and who they are. */
  | { type: 'summoned'; from: number; name: string }
  /** The answer to a call I made. */
  | { type: 'summon_answer'; by: number; name: string; accepted: boolean };

export function parse(text: string): ToClient | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case 'plan': {
      const plan = msg.plan as Partial<PlanFile> | null | undefined;
      if (!plan || typeof plan !== 'object') return null;
      if (typeof plan.cell_m !== 'number' || !Array.isArray(plan.floors)) return null;
      return { type: 'plan', id: String(msg.id ?? ''), plan: plan as PlanFile };
    }
    case 'hello':
      if (typeof msg.id !== 'number') return null;
      return { type: 'hello', id: msg.id, name: String(msg.name ?? '') };
    case 'state':
      if (!Array.isArray(msg.people)) return null;
      return { type: 'state', people: msg.people as PersonView[] };
    case 'no_way':
      if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return null;
      return { type: 'no_way', x: msg.x, y: msg.y };
    case 'introduction':
      if (typeof msg.from !== 'number') return null;
      return { type: 'introduction', from: msg.from };
    case 'signal':
      if (typeof msg.from !== 'number' || typeof msg.payload !== 'string') return null;
      return { type: 'signal', from: msg.from, payload: msg.payload };
    case 'lock':
      // A lock with no holder is nobody editing: null is a fact, not a missing field, so only `undefined`
      // is turned away.
      if (msg.holder !== null && typeof msg.holder !== 'number') return null;
      return { type: 'lock', holder: msg.holder ?? null, name: typeof msg.name === 'string' ? msg.name : null };
    case 'refused':
      if (typeof msg.reason !== 'string') return null;
      return { type: 'refused', reason: msg.reason };
    case 'voices':
      if (!Array.isArray(msg.names)) return null;
      return { type: 'voices', names: msg.names.map((name) => String(name)) };
    case 'demo':
      if (typeof msg.name !== 'string') return null;
      return { type: 'demo', name: msg.name, voice: typeof msg.voice === 'string' ? msg.voice : null };
    case 'avatar_problem':
      if (typeof msg.why !== 'string') return null;
      return { type: 'avatar_problem', why: msg.why };
    case 'summoned':
      if (typeof msg.from !== 'number' || typeof msg.name !== 'string') return null;
      return { type: 'summoned', from: msg.from, name: msg.name };
    case 'summon_answer':
      if (typeof msg.by !== 'number' || typeof msg.name !== 'string' || typeof msg.accepted !== 'boolean') {
        return null;
      }
      return { type: 'summon_answer', by: msg.by, name: msg.name, accepted: msg.accepted };
    default:
      return null;
  }
}

export const join = (name: string, seat?: Seat): string => JSON.stringify({ type: 'join', name, seat: seat ?? null });
export const walk = (x: number, y: number): string => JSON.stringify({ type: 'walk', x, y });
export const introduce = (to: number): string => JSON.stringify({ type: 'introduce', to });
export const signal = (to: number, payload: string): string => JSON.stringify({ type: 'signal', to, payload });
/** Turn a door at a cell on a floor. Anybody may: it is not an edit, and needs no lock. */
export const toggleDoor = (floor: number, row: number, col: number): string =>
  JSON.stringify({ type: 'toggle_door', floor, row, col });
/** Take the stairs at a cell: the floor is not named, because the stairs lead where they lead. */
export const takeStairs = (row: number, col: number): string =>
  JSON.stringify({ type: 'take_stairs', row, col });
/** A change to the building on one floor, for the server to validate and apply. */
export const edit = (floor: number, change: Edit): string =>
  JSON.stringify({ type: 'edit', floor, edit: change });
/** The figure I want to be drawn as. Mine alone; the server checks it and keeps it with my person. */
export const setFigure = (figure: Figure): string => JSON.stringify({ type: 'figure', figure });
/** I am talking, or I have stopped: my own microphone against the speaking threshold. */
export const speak = (speaking: boolean): string => JSON.stringify({ type: 'speaking', speaking });
/** My microphone is stopped, or it is running again. A gesture, never a status. */
export const mute = (muted: boolean): string => JSON.stringify({ type: 'muted', muted });
/** Put this server's one demo figure on the floor, or send it home. Its name and the recording it speaks are
 *  the server's settings, so they are not named here. */
export const demoGuest = (on: boolean): string => JSON.stringify({ type: 'demo_guest', on });

/** Ask somebody to come over: a question, and their own client decides. */
export const summon = (to: number): string => JSON.stringify({ type: 'summon', to });

/** The answer to a call: yes walks to where the caller stands, no lets the question lapse. */
export const answeredSummon = (from: number, accept: boolean): string =>
  JSON.stringify({ type: 'answered_summon', from, accept });

/** A whole plan, put in place of the one being served: what an import is. The server checks it like it checks
 *  every plan, and only the holder of the edit lock may send one. */
export const replacePlan = (plan: PlanFile): string => JSON.stringify({ type: 'replace', plan });
