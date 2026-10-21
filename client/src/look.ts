/**
 * Every colour, line weight and type face the map is drawn with, in one value. Kept apart from the drawing so
 * the drawing says *how* and this says *with what*: a colour changes here and nowhere else.
 */

/** How a surface is patterned once a cell is large enough on screen to carry one. */
export type Pattern = 'planks' | 'tiles' | 'weave' | 'speckle';

export type SurfaceLook = { base: string; ink: string; pattern: Pattern };

export type Look = {
  /** Behind the building. */
  background: string;
  /** The shadow the whole building casts onto the background, so the floor reads as one object. */
  buildingShadow: string;
  surfaces: Record<string, SurfaceLook>;
  wall: {
    /** A wall seen from above: its footprint. */
    top: string;
    /** Its front, hanging beneath the top wherever open floor lies to its south. */
    front: string;
    /** The lit edge where the top meets the front. */
    edge: string;
    /** The thin line round a wall's top and front, so a light wall still has an edge on a light floor. */
    outline: string;
  };
  window: {
    /** The glazing lines: the plan's way of saying "glass", three thin lines in the wall's thickness. The
     *  pane itself is the hour's own colour — see `glassAt`. */
    line: string;
  };
  door: {
    /** The leaf, standing open against its jamb. */
    leaf: string;
    /** The swing arc the open leaf leaves behind. */
    arc: string;
    /** A shut leaf, filling the opening — loud on purpose: a shut door is the one thing that cuts a voice. */
    shut: string;
    /** The shut leaf's face, hanging beneath it as a wall's front does. */
    shutFront: string;
    /** The outline a leaf carries. */
    edge: string;
  };
  /** The shadow everything that stands casts onto the floor. */
  furnitureShadow: string;
  /** What darkens a piece's own outline into its front. */
  furnitureFront: string;
  /** A room's name: set in capitals on a pill of its own. `{px}` in the font is its size. */
  /** A stair, in the walls' white board: the top of a tread, its sides, and the edge that lets the treads be
   *  counted; its railing, a pane of acrylic and the rail along its top. */
  stair: { top: string; side: string; outline: string; pane: string; rail: string };
  /** The outline of the cell under the pointer in the office. */
  hover: string;
};

export const look: Look = {
  background: '#0f172a',
  buildingShadow: 'rgba(0, 0, 0, 0.55)',
  // The model's base: birch ply, white board, grey felt, grey board. Quiet on purpose — the people are the colour.
  surfaces: {
    parquet: { base: '#e2d5bb', ink: 'rgba(130, 104, 70, 0.13)', pattern: 'planks' },
    tile: { base: '#efede8', ink: 'rgba(110, 104, 94, 0.16)', pattern: 'tiles' },
    carpet: { base: '#d3cfc6', ink: 'rgba(80, 74, 66, 0.08)', pattern: 'weave' },
    concrete: { base: '#cbc7bf', ink: 'rgba(74, 70, 64, 0.12)', pattern: 'speckle' },
  },
  wall: { top: '#f8f6f1', front: '#d2ccc1', edge: 'rgba(255, 255, 255, 0.7)', outline: 'rgba(90, 80, 66, 0.4)' },
  window: { line: 'rgba(110, 120, 124, 0.7)' },
  door: { leaf: '#b9b2a6', arc: 'rgba(110, 100, 86, 0.4)', shut: '#f59e0b', shutFront: '#b45309', edge: '#78350f' },
  furnitureShadow: 'rgba(48, 40, 30, 0.24)',
  furnitureFront: 'rgba(60, 52, 40, 0.3)',
  stair: { top: '#f1ede5', side: '#cfc8bc', outline: 'rgba(90, 80, 66, 0.45)', pane: 'rgba(214, 228, 236, 0.3)', rail: 'rgba(96, 108, 116, 0.75)' },
  hover: 'rgba(15, 23, 42, 0.35)',
};

/** The surfaces a floor can be covered with, in the order the editor offers them. */
export const SURFACE_NAMES = Object.keys(look.surfaces);
