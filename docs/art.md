# Art: figures, furniture, floors

This is the map for anybody who wants to change how the office *looks* — a designer, an illustrator, or a
developer who has been handed a picture and asked to make the client match it. It says where each kind of
thing lives, what a change costs, and which rules keep the result coherent.

## The look: a model

The office is drawn as an architect's model of itself. The room and everything in it is cut from a
material — white board, grey board, birch ply, felt, foam, acrylic, cardboard — and none of those
materials is a colour. Colour belongs to two things only: the people, who wear their own, and the
signals (a shut door, the talking ring, the ring round yourself). So a glance at the floor finds the
people first, at any zoom, without reading a single name.

Everything is drawn from code. There are no image files for figures or furniture: a piece of furniture is a
small solid described in centimetres, and a figure is a function that draws parts. That is a deliberate
choice — the drawing stays sharp at any zoom and carries no licence but this repository's — but it means a
change is a code change. See [Sprites](#sprites-if-you-want-to-supply-drawings) for the way out.

## The map

| What you see | File | Lines | What it is |
| --- | --- | --- | --- |
| Furniture, every piece | `client/src/furniture.ts` | ~770 | One entry per piece in `PIECES`, and the editor's shelves in `CATALOGUE` |
| How a solid becomes pixels | `client/src/piece.ts` | ~460 | The shapes (`loft`, `prism`, `box`, `cyl`, …) and their drawing at the floor's own angle |
| Figures | `client/src/figure.ts` | ~400 | `body` (the model), `drawFigure`, the face, and the vocabulary of parts and styles |
| The figure editor ("Du") | `client/src/figureEditor.ts` | ~140 | The screen that picks a style and four colours |
| Floor, walls, doors, shadows, labels | `client/src/floorArt.ts` | ~200 | The room itself, drawn under everything else |
| Stairs | `client/src/stair.ts` | ~300 | A flight of treads up, and the well it comes down into upstairs |
| Colours of floor and walls | `client/src/look.ts` | ~75 | The one place those colours are named |
| Where people stand and how they are drawn | `client/src/people.ts` | ~200 | The crowd: arrive, walk, leave |
| The room's light | `client/src/light.ts` | ~230 | Five moments of a day, lamps, grain |
| All of it on one page | `client/sheet.html`, `client/src/sheet.ts` | ~140 | The art sheet: see [Seeing your change](#seeing-your-change) |

## Furniture

A piece is a footprint in centimetres (`w` across, `d` deep, facing **south**) and a list of parts:

```ts
export const PIECES: Record<string, Piece> = {
  stool: {
    w: 44, d: 44,
    parts: [
      ...legs(8, 8, 28, 28, 42, 3, C.birch, 4, 0.7),         // four legs under the seat, splayed 4 cm, tapering
      cyl(22, 22, 42, 18, 4, C.birch, { r2: 17 }),           // the seat, a little narrower on top
    ],
  },
};
```

The dimension convention is the one you would use at a workbench: `x` across, `y` into the page, `z` up,
all in centimetres. The renderer turns that into the plan's angle; you never do the projection yourself.
Every shape is one of three, in `piece.ts`:

- `loft(low, high, colour, finish)` — joins two outlines of the same number of corners, one above the
  other. What most things are: `box` (with `round` corners in plan, a `top` paint and paints on its four
  `faces`), `extrude` (any outline raised), `cyl` (a cylinder, or a cone when `r2` is given — lamp shades,
  pots), `leg` (square, from a point under a top to a point on the floor: splayed, tapered) and `bar` (a
  straight bar at any angle on the plan: the arms of a star foot).
- `prism(profile, axis, from, length, colour)` — a side view pulled through the piece, for anything whose
  shape is in its profile: a shell chair, a sofa's arm, a back cushion that leans. The profile need not be
  convex.
- `ball(x, y, z, r, colour)` — plant crowns, knobs.

A part is lit by its own slope: each face is darker by how far it turns from a light above the upper left,
so a cone, a leaning back and a box share one rule. `soft` lights white things and acrylic more gently, or
they would turn grey. Parts are drawn back to front by what rests on what and what stands north of what,
so a tap stands on its worktop rather than behind it.

**Adding a piece** is three things: an entry in `PIECES`, an entry in the right shelf of `CATALOGUE`, and
nothing else — the editor, the plan format and the server all key off the name (`isMissing` reports a plan
that names a piece this build does not have). **Changing a piece** is its numbers; keep the footprint
honest, because the plan's collision and the editor's pictures both use `w` and `d`.

The palette `C` at the top of the file is the whole colour vocabulary of the furniture, named by material.
New colours go there, not inline, or two chairs will end up two different woods — and a new colour is a new
material, never a hue: upholstery differs from upholstery by how light its felt is, not by what colour it is.

## Figures

`drawFigure` is one function:

```ts
drawFigure(ctx, x, y, r, facing, palette, parts, mine, stride)
```

- `(x, y)` is where the feet are; `r` is half the shoulder width in pixels — 33 cm, which sets the scale.
- `facing` is one of four (`north`, `east`, `south`, `west`). South shows the face, north the back of the
  head, east and west a three-quarter view turned 45° — not a profile, so both eyes and the mouth stay in
  sight.
- `palette` is four colours: skin, hair, shirt, trousers.
- `parts` is one style per part, from a fixed vocabulary:
  `head: round | oval | bald`, `body: plain | broad | slight`, `arms: sides | folded | open`.
- `stride` is where the figure is in a step, −1 to 1; 0 is standing still. Legs and arms swing against
  each other on their own.
- `mine` adds the ring only your own client draws.

A figure is modelled as the furniture is: `body` builds a person 1.70 m tall out of the same shapes —
lofted legs, hips and a body narrowing from the shoulders, limbs from shoulder to hand, a ball for the head
and one for the hair — and `piece.ts` draws it in the same light and from the same angle as a chair. Each
view is drawn once and kept as a sprite (per figure, facing, step of the stride and size), outlined once
round the whole silhouette in ink, so the outline never runs between parts.

The face is not modelled but painted onto the head (`onFace`): decals in centimetres of the face, laid on the
sphere, so they curve and foreshorten with it in every facing. The hair is drawn over the whole head and the
face cleared out of it again (`revealFace`). Seen from 40° above, a face where a real one sits would be a
strip under the crown, so the whole face is lifted towards the viewer (`FACE_TILT`): everybody looks up a
little. Eyes carry a catch-light; at rest there is a small smile; speaking, the mouth opens on two beats —
the jaw on one, the width of the lips on another. Face details are left out where the head is too small.

`FIGURE_HEIGHT_R` is the figure's height in multiples of `r`, worked out from the angle. Anything placed
above a head — a name label — measures from that, so changing the proportion of a figure moves its label
with it. Whether a head is big enough to show a talking mouth is `mouthFits`; where it is not, `people.ts`
draws the talking ring on the floor instead, so the two never disagree about the size.

**Two rules the drawing keeps:**

1. **A style changes a shape, never a shade.** The styles are what tell two neighbours apart at a glance at
   the smallest zoom, so a new style must be visible in silhouette, not in colour.
2. **The vocabulary is duplicated in Rust.** `client/src/figure.ts` (`PART_STYLES`) and
   `crates/wire/src/figure.rs` (`HEAD_STYLES`, `BODY_STYLES`, `ARM_STYLES`) must agree; the server refuses
   a name it does not know. A new style is one name in both places, plus its shape in `body`.

## Floors, walls, labels

`floorArt.ts` draws the room: floor patterns per surface, walls with height, door leaves, contact shadows,
the ambient darkening where a wall meets the floor, and the room labels. `look.ts` names the floor and
wall colours. If a change makes the office read as a diagram rather than a room, it is almost always here:
a missing contact shadow under a wall, or a label that grew louder than the floor.

A stair is built in `stair.ts` from the walls' white board (`look.stair`): treads two to a cell, rising as high
as a wall on the floor the stair climbs from, and going down as deep into a well on the floor above. The edge of
every tread is drawn, because counting the steps is what tells the eye it is a stair and not a ramp. A railing
of clear acrylic (`look.stair.pane`, `rail`) stands along every side but the foot: the sides nobody walks across.

## Rules that keep it coherent

- **Material, not colour.** The room and the furniture are neutral; the people and the signals are not.
  A piece that needs a hue to be recognised needs a better shape instead.
- **One grid.** A cell is 0.5 m (`cell_m` in the plan, `fixtures/floor-t1.json`), a wall is 1.3 m tall
  (`WALL_HEIGHT_M`). Furniture is in centimetres and must fit the cell it claims.
- **One angle to design for.** The plan sees the room 40° from straight down (`ANGLE_DEG` in `depth.ts`):
  steep enough that a piece shows its legs and its profile, so a piece is designed for that view and not for
  a plan. `?winkel=` on the page, or on the art sheet, tries another. The view from behind a figure (`V`)
  looks lower, at 60° and along a diagonal; a piece is projected for it, not designed again.
- **Everything that stands rises from its footprint.** Walls, doors and furniture alike, so a counter
  against a wall stands in front of it. A wall therefore hides a strip of floor behind it; people there show
  through as a faint ghost (`people.ts`), and a click on a wall's face means the wall (`frontCell` in
  `depth.ts`).
- **One light.** It comes from the upper left, everywhere: furniture, figures, walls. A piece lit from the
  right reads as a mistake even when it is beautiful on its own.
- **Figures carry an outline, furniture does not.** Furniture is told apart by its light alone; the outline
  is what keeps people readable on top of a furnished floor at 26 px.
- **Shadows are contact shadows.** A dark pool under the footprint, never a long cast shadow — at this
  angle a long shadow crosses three neighbours' desks.

## Sprites, if you want to supply drawings

The drawing is written so a sprite set can replace it without changing any message: the part names travel
as strings, and the day a set arrives its names join the same vocabulary (the comment at the top of
`figure.ts` says so). What does not exist yet is the loader: a `figureSprites.ts` that, given a folder of
PNGs, draws them instead of calling `drawFigure`.

For that to work a set needs:

- **four facings** per figure (front, back, left, right), or three with one mirrored;
- **a stride**, or a walk cycle of at least four frames — a figure that slides is worse than a simple one;
- **one transparent PNG per facing** at a consistent height, feet on the bottom edge, and the same height
  for every figure so the crowd does not jitter;
- a **palette rule**: either the sprite is recoloured (hard) or each figure comes in the colours it wears
  (easy — ship variants).

If you want to go this way, say so and the loader is a small, contained piece of work; the rest of the
client is already indifferent to how a figure is drawn.

## Seeing your change

- `pnpm dev` in `client/` and open `/sheet.html`: the art on one page, no server needed, drawn by the
  office's own code from `fixtures/floor-t1.json`. `?panel=overview`, `close`, `pieces` or `figures` picks
  what is shown; `&hour=20` lights it as in the evening, `&winkel=` tries another angle, `&floor=1` draws the
  floor above, and on `close` `&yaw=45` looks as the view from behind does. On the figures
  `&r=90` draws them large and `&talk=160` catches everybody mid-word.
- `pnpm dev` in `client/` and open the app: the plan, the crowd and the furniture editor are the same
  build.
- The figure you see for yourself is the one in the *Du* tab (`figureEditor.ts`); the test avatars the
  server hands out are in `crates/server/src/avatars.rs`.
- `pnpm test` in `client/` runs `figure.test.ts` and `furniture.test.ts`, which hold the vocabulary and
  the catalogue's shape. A change that breaks a name shows up there before it shows up in the office.

