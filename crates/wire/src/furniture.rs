//! What the catalogue's pieces occupy on the floor, seen from the server's side: a footprint in cells, and
//! whether a body may walk through it.
//!
//! The client models every piece in `client/src/furniture.ts`; this is the same table, and the two must be
//! kept level. A footprint is the piece's own width and depth rounded up to whole cells, which is what the
//! drawing uses too — so a thing you can see covering two cells is a thing you walk around.
//!
//! A chair is not something to walk around: you step past it, and a floor where every chair were a wall
//! would be a floor nobody can use. The same goes for what stands *on* a desk or hangs on a wall — a screen,
//! a laptop, an upper cabinet. What stands on the floor is what a body goes round.

use crate::model::Facing;

/// (kind, rows, cols) as the piece stands facing south. North and south are the same shape; east and west
/// are that shape turned a quarter, so the two numbers trade places.
const FOOTPRINTS: &[(&str, usize, usize)] = &[
    ("bench", 1, 2),
    ("bookcaseClosed", 1, 1),
    ("bookcaseOpen", 1, 1),
    ("books", 1, 1),
    ("cabinetTelevision", 1, 3),
    ("cardboardBoxClosed", 1, 1),
    ("cardboardBoxOpen", 1, 1),
    ("ceilingFan", 2, 2),
    ("chairDesk", 1, 1),
    ("chairRounded", 1, 1),
    ("coatRack", 1, 1),
    ("computerScreen", 2, 2),
    ("desk", 2, 2),
    ("kitchenBar", 1, 1),
    ("kitchenBarEnd", 1, 1),
    ("kitchenCabinet", 2, 1),
    ("kitchenCabinetUpper", 2, 1),
    ("kitchenCoffeeMachine", 2, 1),
    ("kitchenFridge", 2, 1),
    ("kitchenFridgeSmall", 2, 1),
    ("kitchenMicrowave", 2, 1),
    ("kitchenSink", 2, 1),
    ("kitchenStove", 2, 1),
    ("lampRoundFloor", 1, 1),
    ("lampRoundTable", 1, 1),
    ("laptop", 2, 1),
    ("loungeChair", 2, 2),
    ("loungeChairRelax", 2, 2),
    ("loungeSofaCorner", 3, 3),
    ("loungeSofaLong", 2, 4),
    ("loungeSofaOttoman", 2, 2),
    ("pottedPlant", 1, 1),
    ("stoolBar", 1, 1),
    ("table", 2, 1),
    ("tableCoffeeGlass", 2, 2),
    ("trashcan", 1, 1),
];

/// The pieces a body may walk through: chairs, and what stands on something else or hangs above the floor.
const PASSABLE: &[&str] = &[
    "chairDesk",
    "chairRounded",
    "stoolBar",
    "computerScreen",
    "laptop",
    "kitchenCabinetUpper",
    "kitchenMicrowave",
    "kitchenCoffeeMachine",
    "lampRoundTable",
    "ceilingFan",
];

/// The piece's footprint in cells, turned with the way it faces.
pub fn footprint(kind: &str, facing: Facing) -> (usize, usize) {
    let (rows, cols) = FOOTPRINTS
        .iter()
        .find(|(name, _, _)| *name == kind)
        .map(|(_, rows, cols)| (*rows, *cols))
        .unwrap_or((1, 1));
    match facing {
        Facing::North | Facing::South => (rows, cols),
        Facing::East | Facing::West => (cols, rows),
    }
}

/// Whether a body has to go round it. Unknown kinds are solid: better a piece nobody can walk through than
/// one the server forgets and lets people stroll across.
pub fn blocks(kind: &str) -> bool {
    !PASSABLE.contains(&kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desk_is_solid_and_a_chair_is_not() {
        assert!(blocks("desk"));
        assert!(blocks("kitchenCabinet"));
        assert!(!blocks("chairDesk"));
        assert!(!blocks("computerScreen"), "a screen stands on the desk, not on the floor");
    }

    #[test]
    fn a_piece_turns_with_its_facing() {
        assert_eq!(footprint("desk", Facing::South), (2, 2));
        assert_eq!(footprint("loungeSofaLong", Facing::South), (2, 4));
        assert_eq!(footprint("loungeSofaLong", Facing::East), (4, 2));
    }

    #[test]
    fn an_unknown_piece_is_solid_and_one_cell() {
        assert_eq!(footprint("mystery", Facing::South), (1, 1));
        assert!(blocks("mystery"));
    }
}
