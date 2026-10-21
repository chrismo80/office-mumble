/**
 * The furniture: every piece the plan can name, modelled as a small solid in centimetres (see `piece.ts` for
 * the shapes and the drawing). The set is the project's own, so it carries no licence of anybody else's.
 *
 * Each piece is modelled facing south — the side a person uses faces down the page — and the other facings are
 * turns of the same model. A desk reads the other way round, since the plan stands its chair on its north side;
 * a monitor sits at the edge of its footprint that meets the desk. Rows are one cell wide with no end edge, so
 * they read as one worktop.
 *
 * Drawn as an architect's model would build them: white board, birch, felt, foam, acrylic — and the shape of a
 * thing, not its colour, says what it is.
 */

import { ball, bar, box, cyl, leg, loft, prism, rounded, type P2, type Paint, type Part, type Piece, type V3 } from './piece';

// ── the palette ──────────────────────────────────────────────────────────────────────────────────────
// Every piece is cut from a material, and none of the materials is a colour. Colour is what the people wear
// (`figure.ts`) and what a signal says (`look.ts`), and nothing here competes with it.
const C = {
  // Board.
  white: '#fbfaf7',
  paper: '#f3f1ec',
  light: '#e6e3dc',
  mid: '#cdc8bf',
  plinth: '#b4afa6',
  steel: '#d7d5d0',
  slate: '#8e8a83',
  dark: '#5b5852',
  darker: '#3f3d3a',
  screen: '#2c3035',
  sheen: 'rgba(255, 255, 255, 0.12)',
  // Birch ply.
  birch: '#e2cfab',
  birchLight: '#ecdfc6',
  birchDark: '#c8ae86',
  // Felt, in values rather than hues: light for the sofas, charcoal for the chairs.
  felt: '#c9c4ba',
  feltLight: '#d9d5cc',
  feltDark: '#a9a398',
  charcoal: '#6d6963',
  charcoalLight: '#827e77',
  // Foam: the model's green.
  foam: '#9db48f',
  foamLight: '#b2c6a4',
  foamDark: '#86a079',
  soil: '#8f877b',
  pot: '#f1efea',
  clay: '#d9c6b0',
  // Cardboard and acrylic.
  kraft: '#cfb68c',
  kraftDark: '#b99f74',
  kraftHollow: '#9c845f',
  glass: 'rgba(214, 230, 236, 0.5)',
  fan: 'rgba(205, 200, 191, 0.75)',
  basin: '#cfccc6',
  lampLit: '#f7ecd2',
};

// ── paint ────────────────────────────────────────────────────────────────────────────────────────────
const rect = (x: number, y: number, w: number, h: number, colour: string, r = 0): Paint => g => {
  g.fillStyle = colour;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
};
const line = (x1: number, y1: number, x2: number, y2: number, colour: string, width = 0.8): Paint => g => {
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
};
const oval = (cx: number, cy: number, rx: number, ry: number, colour: string): Paint => g => {
  g.fillStyle = colour;
  g.beginPath();
  g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
};
const ring = (cx: number, cy: number, r: number, colour: string, width = 1.2): Paint => g => {
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
};
const all = (...paints: Paint[]): Paint => g => paints.forEach(paint => paint(g));
/** The joint between two doors, or two boards: a shadow line, not a drawn one. */
const SEAM = 'rgba(70, 60, 45, 0.28)';

// ── shared pieces ────────────────────────────────────────────────────────────────────────────────────

/** Four legs from the corners of a rectangle under a top at `z` down to the floor, splayed outwards by `splay`. */
function legs(x: number, y: number, w: number, d: number, z: number, size: number, colour: string, splay = 0, taper = 1): Part[] {
  return [
    [x, y, -1, -1],
    [x + w, y, 1, -1],
    [x, y + d, -1, 1],
    [x + w, y + d, 1, 1],
  ].map(([lx, ly, sx, sy]) => leg([lx, ly, z], [lx + sx * splay, ly + sy * splay], size, colour, taper));
}

/** A profile with its corners rounded: `rounded` read as a side view, `(u, v)` with `v` up. */
const roundedProfile = (u: number, v: number, w: number, h: number, r: number): P2[] => rounded(u, v, w, h, r, 3);

/** An upholstered arm, `x` to `x + w` across and `y` to `y + d` deep, from `z` up `h`, rounded on top. */
const arm = (x: number, y: number, d: number, w: number, z: number, h: number, colour: string): Part =>
  prism(roundedProfile(x, z, w, h, Math.min(w, h) / 2), 'y', y, d, colour);

/** A back cushion leaning back, `x` to `x + w` across, its foot from `y` to `y + depth` at `z`, `h` tall. */
const leaningBack = (x: number, w: number, y: number, depth: number, z: number, h: number, colour: string): Part =>
  prism(
    [
      [y, z],
      [y + depth, z],
      [y + depth - 3, z + h - 5],
      [y + depth - 5.5, z + h - 1],
      [y + depth / 2 - 1, z + h],
      [y + 1.2, z + h - 2],
      [y, z + h - 6],
    ],
    'x',
    x,
    w,
    colour,
  );

/** One cell of kitchen counter: a white cabinet over a dark plinth under a birch worktop. `front` replaces the
 *  doors when the cabinet is something else — an oven, a fridge; `worktop` paints on the worktop. */
function counter(front?: Paint, worktop?: Paint): Part[] {
  return [
    box(2, 7, 0, 46, 50, 9, C.plinth),
    box(0, 4, 9, 50, 54, 77, C.white, {
      soft: true,
      faces: { s: front ?? all(line(25, 1, 25, 76, SEAM), rect(4, 70, 17, 1.6, C.slate, 0.8), rect(29, 70, 17, 1.6, C.slate, 0.8)) },
    }),
    box(0, 0, 86, 50, 60, 3.5, C.birch, { top: worktop }),
  ];
}

/** A crown of foam over a pot: a main ball and a few around it, the way a model maker builds a bush. */
function crown(cx: number, cy: number, z: number, r: number): Part[] {
  const around: Array<[number, number, number, number, string]> = [
    [-0.62, -0.1, -0.2, 0.62, C.foamDark],
    [0.6, -0.25, -0.15, 0.6, C.foam],
    [0.05, 0.6, -0.3, 0.58, C.foam],
    [-0.15, -0.55, 0.15, 0.55, C.foamDark],
  ];
  return [
    ...around.map(([dx, dy, dz, rr, colour]) => ball(cx + dx * r, cy + dy * r, z + dz * r, rr * r, colour)),
    ball(cx, cy, z + r * 0.2, r * 0.78, C.foamLight),
  ];
}

/** A pot, wider at the rim than at its foot, with soil showing. */
const pot = (cx: number, cy: number, r: number, h: number, colour: string): Part =>
  cyl(cx, cy, 0, r * 0.82, h, colour, { r2: r, top: all(oval(cx, cy, r * 0.86, r * 0.86, C.soil)) });

/** A lamp shade: a cone cut off, open at the top, lit inside. */
const shadeOf = (cx: number, cy: number, z: number, low: number, high: number, h: number): Part =>
  cyl(cx, cy, z, low, h, C.white, { r2: high, soft: true, top: oval(cx, cy, high * 0.86, high * 0.86, C.lampLit) });

/** A stack of books standing on a shelf at `z`, from `x0` to `x1`, as many as fit; `seed` varies them. */
function booksOn(x0: number, x1: number, y: number, z: number, seed: number): Part[] {
  const covers = [C.white, C.light, C.birchLight, C.paper, C.mid, C.feltLight, C.white, C.kraft];
  const parts: Part[] = [];
  let x = x0;
  let i = seed;
  while (x < x1 - 3) {
    const w = 2.4 + ((i * 7) % 4) * 0.7;
    const h = 21 + ((i * 5) % 9);
    const d = 19 + ((i * 3) % 5);
    if (x + w > x1) break;
    parts.push(box(x, y + (24 - d), z, w, d, h, covers[i % covers.length]));
    x += w + 0.3;
    // Now and then a gap, and a book leaning into it would be one detail too many: a gap is enough.
    if (i % 6 === 5) x += 5;
    i++;
  }
  return parts;
}

// ── the set ──────────────────────────────────────────────────────────────────────────────────────────
export const PIECES: Record<string, Piece> = {
  // Desks and what stands on them.
  desk: {
    w: 100,
    d: 56,
    parts: [
      // T-legs in dark steel: a runner on the floor, a column, a rail under the top.
      ...[4, 92].flatMap(x => [
        box(x, 6, 0, 4, 44, 2.5, C.darker),
        box(x, 25, 2.5, 4, 6, 66.5, C.darker),
        box(x, 6, 69, 4, 44, 3, C.darker),
      ]),
      box(0, 0, 72, 100, 56, 2.5, C.birch, {
        // White laminate with the birch showing at its edge, and a keyboard and a mouse on the user's side.
        top: all(rect(0.8, 0.8, 98.4, 54.4, C.white, 1), rect(32, 6, 36, 11, C.light, 1.5), oval(76, 11.5, 3, 4.2, C.light)),
      }),
    ],
  },
  computerScreen: {
    w: 62,
    d: 64,
    parts: [
      cyl(31, 9, 74.5, 8, 1.2, C.steel),
      box(29.5, 4, 75.7, 3, 3, 14, C.steel),
      box(4, 2, 84, 54, 2, 32, C.light, {
        soft: true,
        faces: {
          n: all(rect(0, 0, 54, 32, C.darker, 1.2), rect(1.2, 4, 51.6, 26.8, C.screen, 0.6), rect(2.5, 5.5, 22, 24, C.sheen, 0.4)),
          s: oval(27, 20, 5, 5, C.mid),
        },
      }),
    ],
  },
  laptop: {
    w: 36,
    d: 100,
    parts: [
      box(2, 2, 74.5, 32, 22, 1.2, C.steel, { round: 1.5, top: all(rect(4, 4, 28, 10, C.mid, 1), rect(13, 15.5, 10, 5.5, C.light, 1)) }),
      // The lid, open and leaning back a little.
      prism(
        [
          [23, 75.7],
          [24.4, 75.7],
          [27.5, 96],
          [26.1, 96],
        ],
        'x',
        2,
        32,
        C.steel,
      ),
    ],
  },
  chairDesk: {
    w: 48,
    d: 46,
    parts: [
      // A five-armed foot on castors, a gas column, a seat, a back on a spine, and two arms.
      ...[0, 1, 2, 3, 4].flatMap(i => {
        const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
        const tx = 24 + Math.cos(a) * 19;
        const ty = 26 + Math.sin(a) * 17;
        return [cyl(tx, ty, 0, 2, 3.5, C.darker), bar(24, 26, tx, ty, 3.4, 3.5, 2.5, C.darker)];
      }),
      cyl(24, 26, 6, 3.4, 4, C.darker),
      cyl(24, 26, 10, 1.8, 29, C.steel),
      box(5, 11, 39, 38, 34, 7, C.charcoal, { round: 6 }),
      box(22, 6, 41, 4, 5, 14, C.darker),
      prism(roundedProfile(7, 52, 34, 40, 8), 'y', 5, 5, C.charcoal),
      ...[3, 40].flatMap(x => [box(x + 0.5, 25, 46, 4, 4, 13, C.darker), box(x, 16, 59, 5, 22, 2.5, C.darker, { round: 1.5 })]),
    ],
  },
  chairRounded: {
    w: 42,
    d: 42,
    parts: [
      // A moulded shell on four splayed birch legs.
      ...legs(10, 12, 22, 20, 42, 3, C.birch, 4, 0.7),
      prism(
        [
          [38, 42.5],
          [39.5, 45.5],
          [37, 47.5],
          [17, 45.5],
          [12, 48],
          [9, 56],
          [7, 68],
          [6.5, 79],
          [3.5, 79],
          [4, 67],
          [6, 54],
          [9, 45],
          [14, 42.5],
        ],
        'x',
        5,
        32,
        C.white,
        { soft: true },
      ),
    ],
  },

  // Tables, stools and benches.
  table: {
    w: 50,
    d: 62,
    parts: [...legs(7, 7, 36, 48, 72, 3.4, C.birch, 3, 0.7), box(1, 1, 72, 48, 60, 3, C.birch, { round: 2 })],
  },
  tableCoffeeGlass: {
    w: 90,
    d: 56,
    parts: [
      ...legs(6, 6, 76, 42, 38, 2, C.darker),
      box(5, 5, 10, 80, 46, 1.5, C.birch),
      box(1, 1, 38, 88, 54, 1.2, C.glass, {
        round: 4,
        soft: true,
        top: all(rect(16, 16, 24, 17, C.paper, 0.6), line(28, 16.5, 28, 32.5, SEAM, 0.4), oval(62, 28, 4.5, 4.5, C.white), ring(62, 28, 3.2, C.mid, 0.6)),
      }),
    ],
  },
  stoolBar: {
    w: 36,
    d: 36,
    parts: [
      ...legs(10, 10, 16, 16, 62, 2.6, C.birch, 4, 0.8),
      // A foot ring, as four rails between the legs.
      bar(8, 8, 28, 8, 1.6, 24, 1.6, C.darker),
      bar(8, 28, 28, 28, 1.6, 24, 1.6, C.darker),
      bar(8, 8, 8, 28, 1.6, 24, 1.6, C.darker),
      bar(28, 8, 28, 28, 1.6, 24, 1.6, C.darker),
      cyl(18, 18, 62, 15, 3, C.birch, { r2: 14.5 }),
      cyl(18, 18, 65, 13.5, 2.5, C.charcoal, { r2: 12.5 }),
    ],
  },
  bench: {
    w: 92,
    d: 40,
    parts: [
      box(9, 4, 0, 2, 32, 41, C.darker),
      box(81, 4, 0, 2, 32, 41, C.darker),
      box(1, 2, 41, 90, 36, 4, C.birch, { round: 1.5, top: all(...[11, 20, 29].map(y => line(1, y, 89, y, SEAM, 0.5))) }),
    ],
  },

  // The lounge.
  loungeChair: {
    w: 68,
    d: 60,
    parts: [
      ...legs(8, 8, 52, 44, 12, 4, C.birchDark, 1.5, 0.75),
      box(3, 3, 12, 62, 54, 14, C.charcoal, { round: 4 }),
      leaningBack(13, 42, 4, 15, 26, 40, C.charcoalLight),
      box(13, 19, 26, 42, 37, 9, C.charcoalLight, { round: 5 }),
      arm(3, 3, 54, 10, 26, 20, C.charcoal),
      arm(55, 3, 54, 10, 26, 20, C.charcoal),
    ],
  },
  loungeChairRelax: {
    w: 68,
    d: 96,
    parts: [
      ...legs(8, 8, 52, 44, 12, 4, C.birchDark, 1.5, 0.75),
      box(3, 3, 12, 62, 54, 14, C.charcoal, { round: 4 }),
      leaningBack(13, 42, 4, 15, 26, 40, C.charcoalLight),
      box(13, 19, 26, 42, 37, 9, C.charcoalLight, { round: 5 }),
      arm(3, 3, 54, 10, 26, 20, C.charcoal),
      arm(55, 3, 54, 10, 26, 20, C.charcoal),
      // The footstool in front of it.
      ...legs(14, 70, 40, 20, 10, 3, C.birchDark, 1, 0.75),
      box(10, 66, 10, 48, 28, 14, C.charcoal, { round: 5 }),
      box(12, 68, 24, 44, 24, 5, C.charcoalLight, { round: 5 }),
    ],
  },
  loungeSofaLong: {
    w: 170,
    d: 80,
    parts: [
      ...legs(10, 10, 150, 60, 12, 4, C.birchDark, 1.5, 0.75),
      box(3, 4, 12, 164, 72, 14, C.felt, { round: 4 }),
      box(3, 4, 26, 164, 6, 34, C.felt, { round: 3 }),
      ...[0, 1, 2].flatMap(i => [
        leaningBack(20 + i * 44, 42, 10, 14, 26, 36, C.feltLight),
        box(20 + i * 44, 24, 26, 42, 50, 10, C.feltLight, { round: 5 }),
      ]),
      arm(3, 4, 72, 16, 26, 20, C.felt),
      arm(151, 4, 72, 16, 26, 20, C.felt),
    ],
  },
  loungeSofaCorner: {
    w: 132,
    d: 132,
    parts: [
      ...(
        [
          [10, 10],
          [120, 10],
          [10, 58],
          [74, 122],
          [120, 122],
        ] as P2[]
      ).map(([x, y]) => leg([x, y, 12], [x, y], 4, C.birchDark, 0.75)),
      box(3, 4, 12, 126, 62, 14, C.felt, { round: 4 }),
      box(67, 66, 12, 62, 63, 14, C.felt, { round: 4 }),
      box(3, 4, 26, 126, 6, 34, C.felt, { round: 3 }),
      box(123, 10, 26, 6, 119, 34, C.felt, { round: 3 }),
      ...[0, 1].flatMap(i => [
        leaningBack(18 + i * 52, 51, 10, 14, 26, 36, C.feltLight),
        box(18 + i * 52, 24, 26, 51, 40, 10, C.feltLight, { round: 5 }),
      ]),
      // The east wing's back leans east: the same cushion, turned a quarter.
      prism(
        [
          [123, 26],
          [109, 26],
          [112, 57],
          [114.5, 61],
          [117.5, 62],
          [121.8, 60],
          [123, 56],
        ],
        'y',
        66,
        46,
        C.feltLight,
      ),
      box(69, 64, 26, 40, 50, 10, C.feltLight, { round: 5 }),
      arm(3, 4, 62, 15, 26, 20, C.felt),
      prism(roundedProfile(113, 26, 16, 20, 8), 'x', 67, 56, C.felt),
    ],
  },
  loungeSofaOttoman: {
    w: 60,
    d: 60,
    parts: [
      cyl(30, 30, 0, 26, 30, C.feltDark, { r2: 27 }),
      cyl(30, 30, 30, 27, 4, C.felt, { r2: 24.5 }),
      cyl(30, 30, 34, 2, 0.6, C.feltDark),
    ],
  },
  cabinetTelevision: {
    w: 110,
    d: 36,
    parts: [
      ...legs(6, 9, 98, 22, 10, 2.4, C.darker),
      box(2, 6, 10, 106, 28, 38, C.birchLight, {
        faces: { s: all(line(35.3, 1, 35.3, 37, SEAM), line(70.6, 1, 70.6, 37, SEAM), ...[17.6, 53, 88.3].map(u => oval(u, 30, 1.2, 1.2, C.birchDark))) },
      }),
      box(46, 15, 48, 18, 8, 1, C.darker),
      box(53, 17, 49, 4, 2.5, 9, C.darker),
      box(14, 19.5, 56, 82, 2, 46, C.darker, {
        faces: { s: all(rect(1, 1, 80, 44, C.screen, 0.6), rect(3, 3, 32, 40, C.sheen, 0.4)) },
      }),
    ],
  },

  // Shelves and boxes.
  bookcaseClosed: {
    w: 50,
    d: 34,
    parts: [
      box(3, 4, 0, 44, 27, 6, C.plinth),
      box(1, 1, 6, 48, 32, 174, C.white, {
        soft: true,
        faces: { s: all(line(24, 1, 24, 173, SEAM), rect(20, 92, 1.4, 16, C.slate, 0.7), rect(26.6, 92, 1.4, 16, C.slate, 0.7)) },
      }),
    ],
  },
  bookcaseOpen: {
    w: 50,
    d: 34,
    parts: [
      box(3.5, 1, 0, 43, 1.5, 177.5, C.birchDark),
      box(1, 1, 0, 2.5, 32, 177.5, C.birch),
      box(46.5, 1, 0, 2.5, 32, 177.5, C.birch),
      ...[0, 36, 72, 108, 144].map(z => box(3.5, 2.5, z, 43, 30.5, 2.5, C.birch)),
      box(1, 1, 177.5, 48, 32, 2.5, C.birch),
      ...[2.5, 38.5, 74.5, 110.5, 146.5].flatMap((z, i) => booksOn(4, 46, 4, z, i * 5 + 1)),
    ],
  },
  books: {
    w: 22,
    d: 16,
    parts: [box(1, 1, 0, 20, 14, 3.2, C.dark), box(2.5, 1.5, 3.2, 17, 12.5, 2.8, C.white), box(1.8, 2.2, 6, 18, 11, 3, C.birchLight)],
  },
  cardboardBoxClosed: {
    w: 32,
    d: 32,
    parts: [
      box(1, 1, 0, 30, 30, 30, C.kraft, {
        top: all(rect(13.5, 0, 5, 30, 'rgba(255, 255, 255, 0.35)'), line(0, 15, 30, 15, SEAM, 0.5)),
        faces: { s: rect(13.5, 21, 5, 9, 'rgba(255, 255, 255, 0.35)') },
      }),
    ],
  },
  cardboardBoxOpen: {
    w: 48,
    d: 32,
    parts: [
      box(9, 1, 0, 30, 30, 28, C.kraftDark, { top: rect(10.5, 2.5, 27, 27, C.kraftHollow) }),
      // The flaps, folded out and down a little.
      prism(
        [
          [9, 28],
          [10.2, 28],
          [2.2, 37],
          [1, 37],
        ],
        'y',
        2,
        28,
        C.kraft,
      ),
      prism(
        [
          [39, 28],
          [37.8, 28],
          [45.8, 37],
          [47, 37],
        ],
        'y',
        2,
        28,
        C.kraft,
      ),
    ],
  },

  // The kitchen.
  kitchenCabinet: { w: 50, d: 60, parts: counter() },
  kitchenCabinetUpper: {
    w: 50,
    d: 60,
    parts: [
      ...counter(),
      box(0, 0, 145, 50, 34, 62, C.white, {
        soft: true,
        faces: { s: all(line(25, 1, 25, 61, SEAM), rect(4, 4, 17, 1.6, C.slate, 0.8), rect(29, 4, 17, 1.6, C.slate, 0.8)) },
      }),
    ],
  },
  kitchenSink: {
    w: 50,
    d: 60,
    parts: [
      ...counter(undefined, all(rect(8, 15, 34, 30, C.steel, 4), rect(10, 17, 30, 26, C.basin, 3), oval(25, 30, 1.8, 1.8, C.slate))),
      cyl(25, 7, 89.5, 1.8, 2, C.steel),
      cyl(25, 7, 91.5, 1.1, 18, C.steel),
      box(23.9, 6, 108, 2.2, 13, 2, C.steel, { round: 1 }),
    ],
  },
  kitchenStove: {
    w: 50,
    d: 60,
    parts: counter(
      all(rect(3, 18, 44, 50, C.darker, 2), rect(7, 26, 36, 30, C.screen, 1.5), rect(8, 62, 34, 2.2, C.slate, 1)),
      all(rect(4, 7, 42, 46, C.darker, 2.5), ...[[15, 19], [35, 19], [15, 41], [35, 41]].map(([x, y]) => ring(x, y, 7, C.dark, 1))),
    ),
  },
  kitchenFridge: {
    w: 50,
    d: 60,
    parts: [
      box(2, 7, 0, 46, 50, 9, C.plinth),
      box(1, 1, 9, 48, 58, 181, C.white, {
        soft: true,
        faces: { s: all(line(1, 112, 47, 112, SEAM, 1), rect(42, 70, 1.8, 34, C.slate, 0.9), rect(42, 118, 1.8, 34, C.slate, 0.9)) },
      }),
    ],
  },
  kitchenFridgeSmall: {
    w: 50,
    d: 60,
    parts: counter(all(line(1, 1, 1, 76, SEAM), rect(4, 70, 42, 1.6, C.slate, 0.8))),
  },
  kitchenMicrowave: {
    w: 50,
    d: 60,
    parts: [
      ...counter(),
      box(6, 12, 89.5, 38, 30, 21, C.light, {
        round: 1.5,
        soft: true,
        faces: { s: all(rect(2.5, 3, 25, 15, C.darker, 1.5), rect(3.5, 4, 10, 13, C.sheen, 1), rect(30.5, 4, 5, 13, C.mid, 1), oval(33, 8, 1.4, 1.4, C.dark)) },
      }),
    ],
  },
  kitchenCoffeeMachine: {
    w: 50,
    d: 60,
    parts: [
      ...counter(),
      // An espresso machine: body, a hopper on top, a group head, a drip tray, and a cup on it.
      box(13, 10, 89.5, 24, 28, 32, C.steel, {
        round: 2,
        faces: { s: all(rect(2, 12, 20, 18, C.dark, 1.5), rect(4, 26, 16, 2, C.slate, 0.8)) },
      }),
      cyl(25, 22, 121.5, 5, 8, C.darker, { r2: 6.5, top: oval(25, 22, 5.5, 5.5, C.dark) }),
      box(15, 38, 89.5, 20, 6, 2, C.darker),
      cyl(25, 39.5, 110, 3, 4, C.darker),
      cyl(25, 41, 91.5, 2.6, 5, C.white, { r2: 3, top: oval(25, 41, 2.4, 2.4, '#6b5644') }),
    ],
  },
  kitchenBar: {
    w: 50,
    d: 32,
    parts: [box(1, 9, 0, 48, 20, 6, C.plinth), box(0, 6, 6, 50, 24, 94, C.white, { soft: true }), box(0, 0, 100, 50, 32, 4, C.birch)],
  },
  kitchenBarEnd: {
    w: 32,
    d: 50,
    parts: [box(4, 30, 0, 24, 18, 100, C.white, { round: 9, soft: true }), box(1, 28, 100, 30, 22, 4, C.birch, { round: 11 })],
  },

  // Plants, light and air.
  pottedPlant: { w: 46, d: 46, parts: [pot(23, 23, 12, 30, C.pot), ...crown(23, 23, 50, 17)] },
  plantSmall1: { w: 24, d: 24, parts: [pot(12, 12, 7, 10, C.clay), ...crown(12, 12, 17, 7)] },
  plantSmall2: {
    w: 24,
    d: 24,
    parts: [pot(12, 12, 6.5, 10, C.pot), cyl(12, 12, 10, 3.6, 13, C.foamDark, { r2: 3.4 }), ball(12, 12, 23, 3.5, C.foam), ball(7.5, 13, 16, 2.4, C.foam)],
  },
  plantSmall3: {
    w: 22,
    d: 22,
    parts: [cyl(11, 11, 0, 5, 6, C.white, { r2: 8, top: oval(11, 11, 7, 7, C.soil) }), ball(11, 11, 9, 5.5, C.foamLight), ball(7, 13, 8, 3.5, C.foam)],
  },
  lampRoundFloor: {
    w: 32,
    d: 32,
    parts: [cyl(16, 16, 0, 11, 2, C.darker, { r2: 10 }), cyl(16, 16, 2, 1.1, 126, C.darker), shadeOf(16, 16, 128, 13, 7.5, 20)],
  },
  lampRoundTable: {
    w: 22,
    d: 22,
    parts: [cyl(11, 11, 0, 6, 2, C.darker, { r2: 5.5 }), cyl(11, 11, 2, 0.9, 16, C.darker), shadeOf(11, 11, 18, 10, 4.5, 10)],
  },
  ceilingFan: {
    w: 72,
    d: 72,
    parts: [
      ...[0, 1, 2].map(i => {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        return bar(36, 36, 36 + Math.cos(a) * 34, 36 + Math.sin(a) * 34, 9, 244, 1.2, C.fan);
      }),
      cyl(36, 36, 241, 6, 6, C.light),
    ],
  },

  // Oddments.
  coatRack: {
    w: 46,
    d: 46,
    parts: [
      cyl(23, 23, 0, 14, 2.5, C.darker, { r2: 12 }),
      cyl(23, 23, 2.5, 1.6, 170, C.darker),
      ball(23, 23, 174, 2.6, C.darker),
      // Two coats hanging from the top, wider at the hem than at the hook.
      coat([16, 21], 14, 10, 106, 164, C.charcoal),
      coat([30, 26], 15, 10, 112, 162, C.feltDark),
    ],
  },
  trashcan: {
    w: 30,
    d: 30,
    parts: [cyl(15, 15, 0, 11, 40, C.slate, { r2: 12.5 }), cyl(15, 15, 40, 13, 1.5, C.dark, { top: oval(15, 15, 11, 11, C.darker) })],
  },
};

/** A coat on a hook: a loft from narrow shoulders at `top` to a wider hem at `hem`. */
function coat([cx, cy]: P2, width: number, depth: number, hem: number, top: number, colour: string): Part {
  const ring = (w: number, d: number, z: number): V3[] => [
    [cx - w / 2, cy - d / 2, z],
    [cx + w / 2, cy - d / 2, z],
    [cx + w / 2, cy + d / 2, z],
    [cx - w / 2, cy + d / 2, z],
  ];
  return loft(ring(width, depth, hem), ring(width * 0.6, depth * 0.55, top), colour);
}

/** One shelf of the catalogue: a heading, and the pieces on it with the name a person calls them by. */
export type Shelf = { name: string; pieces: Array<{ kind: string; name: string }> };

/**
 * The catalogue: every modelled piece once, under the shelf it is looked for on, with a name beside the
 * model so the two cannot drift. `furniture.test.ts` holds that every piece is on exactly one shelf.
 */
export const CATALOGUE: Shelf[] = [
  {
    name: 'Working',
    pieces: [
      { kind: 'desk', name: 'Desk' },
      { kind: 'computerScreen', name: 'Monitor' },
      { kind: 'laptop', name: 'Laptop' },
      { kind: 'chairDesk', name: 'Office chair' },
      { kind: 'chairRounded', name: 'Chair' },
    ],
  },
  {
    name: 'Tables & seats',
    pieces: [
      { kind: 'table', name: 'Table' },
      { kind: 'tableCoffeeGlass', name: 'Coffee table' },
      { kind: 'stoolBar', name: 'Bar stool' },
      { kind: 'bench', name: 'Bench' },
    ],
  },
  {
    name: 'Lounge',
    pieces: [
      { kind: 'loungeChair', name: 'Armchair' },
      { kind: 'loungeChairRelax', name: 'Recliner' },
      { kind: 'loungeSofaLong', name: 'Sofa' },
      { kind: 'loungeSofaCorner', name: 'Corner sofa' },
      { kind: 'loungeSofaOttoman', name: 'Ottoman' },
      { kind: 'cabinetTelevision', name: 'TV stand' },
    ],
  },
  {
    name: 'Kitchen',
    pieces: [
      { kind: 'kitchenCabinet', name: 'Base cabinet' },
      { kind: 'kitchenCabinetUpper', name: 'Wall cabinet' },
      { kind: 'kitchenSink', name: 'Sink' },
      { kind: 'kitchenStove', name: 'Stove' },
      { kind: 'kitchenFridge', name: 'Fridge' },
      { kind: 'kitchenFridgeSmall', name: 'Fridge, small' },
      { kind: 'kitchenMicrowave', name: 'Microwave' },
      { kind: 'kitchenCoffeeMachine', name: 'Coffee machine' },
      { kind: 'kitchenBar', name: 'Counter' },
      { kind: 'kitchenBarEnd', name: 'Counter end' },
    ],
  },
  {
    name: 'Shelves & boxes',
    pieces: [
      { kind: 'bookcaseClosed', name: 'Cabinet' },
      { kind: 'bookcaseOpen', name: 'Shelf' },
      { kind: 'books', name: 'Books' },
      { kind: 'cardboardBoxClosed', name: 'Box' },
      { kind: 'cardboardBoxOpen', name: 'Box, open' },
    ],
  },
  {
    name: 'Plants & light',
    pieces: [
      { kind: 'pottedPlant', name: 'Potted plant' },
      { kind: 'plantSmall1', name: 'Small plant 1' },
      { kind: 'plantSmall2', name: 'Small plant 2' },
      { kind: 'plantSmall3', name: 'Small plant 3' },
      { kind: 'lampRoundFloor', name: 'Floor lamp' },
      { kind: 'lampRoundTable', name: 'Table lamp' },
      { kind: 'ceilingFan', name: 'Ceiling fan' },
    ],
  },
  {
    name: 'Misc',
    pieces: [
      { kind: 'coatRack', name: 'Coat rack' },
      { kind: 'trashcan', name: 'Bin' },
    ],
  },
];

/** The name a piece is shown under: its catalogue name, or its model name when it has none. */
export function nameOf(kind: string): string {
  for (const shelf of CATALOGUE) {
    const found = shelf.pieces.find(piece => piece.kind === kind);
    if (found) return found.name;
  }
  return kind;
}

/** The catalogue narrowed to what a search matches, by name or model name, with empty shelves left out. */
export function searchCatalogue(query: string): Shelf[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return CATALOGUE;
  return CATALOGUE.map(shelf => ({
    name: shelf.name,
    pieces: shelf.pieces.filter(
      piece => piece.name.toLowerCase().includes(wanted) || piece.kind.toLowerCase().includes(wanted) || shelf.name.toLowerCase().includes(wanted),
    ),
  })).filter(shelf => shelf.pieces.length > 0);
}

/** Whether the plan names a piece that was never modelled: a mistake to show, not to hide. */
export function isMissing(kind: string): boolean {
  return !(kind in PIECES);
}
