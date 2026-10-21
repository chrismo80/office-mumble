//! The building as the server reads, keeps and serves it, and as the client edits it. The rule only ever
//! asks for cells, so a floor hands it its `Grid`; everything else here — what a floor is made of, what
//! stands on it, what a room is called — is for the people looking at it.

use serde::{Deserialize, Serialize};

use crate::{Cell, Grid, Seat, CELL_M};

/// What a floor is covered with: an office is not one material, and a room out of one colour does not read as a place.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    Parquet,
    Tile,
    Carpet,
    Concrete,
}

fn surface_parquet() -> Surface {
    Surface::Parquet
}

/// Which way something stands, so a sofa can stand against a wall and a desk face its screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Facing {
    North,
    East,
    #[default]
    South,
    West,
}

/// Anything anchored to one cell of a floor. A cell carries at most one of each kind, so putting one down
/// replaces whatever stood there, and a cell that stops existing takes them all with it.
pub trait OnCell {
    fn cell(&self) -> (usize, usize);
    /// Anchor it to another cell, as a floor that grows at its top or left edge moves everything on it.
    fn anchor(&mut self, row: usize, col: usize);
}

/// The longest side a floor may have, in cells: 200 m. Larger is several floors or a slip of the hand, and forty
/// thousand cells is already a lot for every client to draw.
pub const MAX_SIDE_CELLS: usize = 400;

/// Something standing on a cell. `kind` is the sprite's name in whatever set the client draws from, so the model
/// stays clear of one library's file names.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Object {
    pub kind: String,
    pub row: usize,
    pub col: usize,
    #[serde(default)]
    pub facing: Facing,
}

impl Object {
    pub fn check(&self) -> Result<(), String> {
        if self.kind.trim().is_empty() {
            return Err("something stands there without a kind".into());
        }
        Ok(())
    }
}

/// A name on the map: a room, the coffee corner. Anchored to a cell, so it travels with the floor.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Label {
    pub text: String,
    pub row: usize,
    pub col: usize,
}

impl Label {
    pub fn check(&self) -> Result<(), String> {
        if self.text.trim().is_empty() {
            return Err("a label says nothing".into());
        }
        Ok(())
    }
}

/// A cell whose surface is not the floor's own.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Painted {
    pub row: usize,
    pub col: usize,
    pub surface: Surface,
}

impl OnCell for Object {
    fn cell(&self) -> (usize, usize) {
        (self.row, self.col)
    }
    fn anchor(&mut self, row: usize, col: usize) {
        (self.row, self.col) = (row, col);
    }
}

impl OnCell for Label {
    fn cell(&self) -> (usize, usize) {
        (self.row, self.col)
    }
    fn anchor(&mut self, row: usize, col: usize) {
        (self.row, self.col) = (row, col);
    }
}

impl OnCell for Painted {
    fn cell(&self) -> (usize, usize) {
        (self.row, self.col)
    }
    fn anchor(&mut self, row: usize, col: usize) {
        (self.row, self.col) = (row, col);
    }
}

/// Move everything anchored to a floor by a whole number of cells, and drop what falls off its edge.
fn shift_all<T: OnCell>(items: &mut Vec<T>, top: i64, left: i64, height: usize, width: usize) {
    items.retain_mut(|item| {
        let (row, col) = item.cell();
        let (row, col) = (row as i64 + top, col as i64 + left);
        if row < 0 || col < 0 || row >= height as i64 || col >= width as i64 {
            return false;
        }
        item.anchor(row as usize, col as usize);
        true
    });
}

/// Take whatever of this kind is anchored to a cell away.
pub(crate) fn remove_at<T: OnCell>(items: &mut Vec<T>, at: (usize, usize)) {
    items.retain(|item| item.cell() != at);
}

/// Put something on its cell, replacing what of its kind stood there: one cell carries one of each.
pub(crate) fn put<T: OnCell>(items: &mut Vec<T>, item: T) {
    remove_at(items, item.cell());
    items.push(item);
}

/// The side of a flight you step off at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    North,
    South,
    East,
    West,
}

/// A staircase: a rectangular flight that leads to another floor. Both floors carry the flight in the same
/// place, and you leave the floor by walking its treads to the `exits` side — so the two floors name opposite
/// sides, and the way up is the way down. A flight, not a cell: a stair you reach in one step is a hole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stair {
    pub row: usize,
    pub col: usize,
    #[serde(default = "one_cell")]
    pub rows: usize,
    #[serde(default = "one_cell")]
    pub cols: usize,
    /// The side the flight leaves the floor at: the last tread of the climb.
    pub exits: Side,
    /// The floor it leads to.
    pub to: usize,
}

fn one_cell() -> usize {
    1
}

impl Stair {
    pub fn height(&self) -> usize {
        self.rows.max(1)
    }

    pub fn width(&self) -> usize {
        self.cols.max(1)
    }

    /// Whether the flight covers this cell.
    pub fn covers(&self, row: usize, col: usize) -> bool {
        row >= self.row
            && row < self.row + self.height()
            && col >= self.col
            && col < self.col + self.width()
    }

    /// Whether this cell is on the side you step off at — the tread that takes you to the other floor.
    pub fn is_exit(&self, row: usize, col: usize) -> bool {
        if !self.covers(row, col) {
            return false;
        }
        match self.exits {
            Side::North => row == self.row,
            Side::South => row == self.row + self.height() - 1,
            Side::West => col == self.col,
            Side::East => col == self.col + self.width() - 1,
        }
    }

    /// The tread the climb ends at: where a walker stands when the floor changes under it.
    pub fn exit_cell(&self) -> (usize, usize) {
        match self.exits {
            Side::North => (self.row, self.col + self.width() / 2),
            Side::South => (self.row + self.height() - 1, self.col + self.width() / 2),
            Side::West => (self.row + self.height() / 2, self.col),
            Side::East => (self.row + self.height() / 2, self.col + self.width() - 1),
        }
    }

    /// The step from the flight's first tread onto the floor it is entered from, in rows and columns: the way
    /// opposite `exits`.
    fn entry(&self) -> (isize, isize) {
        match self.exits {
            Side::North => (1, 0),
            Side::South => (-1, 0),
            Side::East => (0, -1),
            Side::West => (0, 1),
        }
    }

    /// The cells just beyond the end the flight is entered at, on or off the floor: where it is stepped onto.
    pub fn foot(&self) -> Vec<(usize, usize)> {
        let (dr, dc) = self.entry();
        (self.row..self.row + self.height())
            .flat_map(|row| (self.col..self.col + self.width()).map(move |col| (row, col)))
            .filter_map(|(row, col)| Some((row.checked_add_signed(dr)?, col.checked_add_signed(dc)?)))
            .filter(|&(row, col)| !self.covers(row, col))
            .collect()
    }

    /// Every step between the flight and the floor around it, except across the end it is entered at: the
    /// side opposite `exits`, where the flight meets the floor. Its long sides drop off or stand up as a wall
    /// of treads, and its exit end is the top or the bottom of the flight, a storey from the floor beyond.
    pub fn fences(&self) -> Vec<((usize, usize), (usize, usize))> {
        let entry = self.entry();
        let mut fences = Vec::new();
        for row in self.row..self.row + self.height() {
            for col in self.col..self.col + self.width() {
                for step in [(-1isize, 0isize), (1, 0), (0, -1), (0, 1)] {
                    let (Some(r), Some(c)) = (row.checked_add_signed(step.0), col.checked_add_signed(step.1)) else {
                        continue;
                    };
                    if step != entry && !self.covers(r, c) {
                        fences.push(((row, col), (r, c)));
                    }
                }
            }
        }
        fences
    }
}

impl OnCell for Stair {
    fn cell(&self) -> (usize, usize) {
        (self.row, self.col)
    }
    fn anchor(&mut self, row: usize, col: usize) {
        self.row = row;
        self.col = col;
    }
}

/// One floor of the building.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Floor {
    pub name: String,
    #[serde(default = "surface_parquet")]
    pub surface: Surface,
    /// One code per cell, in rows: `void`, `floor`, `wall`, `doorOpen`, `doorShut`.
    pub cells: Grid,
    /// Only the cells that differ from `surface`.
    #[serde(default)]
    pub painted: Vec<Painted>,
    #[serde(default)]
    pub objects: Vec<Object>,
    #[serde(default)]
    pub labels: Vec<Label>,
    /// The stairs, if the building has more than one floor.
    #[serde(default)]
    pub stairs: Vec<Stair>,
}

impl Floor {
    /// What the cell at `row`, `col` is covered with: the floor's own surface, unless it was painted over.
    pub fn surface_at(&self, row: usize, col: usize) -> Surface {
        self.painted
            .iter()
            .find(|patch| patch.cell() == (row, col))
            .map(|patch| patch.surface)
            .unwrap_or(self.surface)
    }

    /// Refuse a cell that is not on this floor — the one check every change to a floor starts with.
    pub fn require_cell(&self, row: usize, col: usize) -> Result<(), String> {
        if self.cells.contains(row, col) {
            Ok(())
        } else {
            Err(format!("cell {row}, {col} is outside the floor"))
        }
    }

/// Turn the door at a cell, or refuse. Not a lock: anybody may work it, which is why it is separate from an edit.
/// Any other cell is refused by name, so a click says what it hit rather than doing nothing.
    pub fn toggle_door(&mut self, row: usize, col: usize) -> Result<(), String> {
        self.require_cell(row, col)?;
        let cell = self.cells.get(row, col);
        let toggled = cell
            .toggled()
            .ok_or_else(|| format!("the cell at {row}, {col} is {}, not a door", cell.code()))?;
        self.cells.set(row, col, toggled);
        Ok(())
    }

/// A cell turned to `void` is not a cell any more, so an erase takes what stood on it, the name it carried and
/// the paint it wore. A desk drawn over void is a lie about the ground.
    pub fn erase(&mut self, row: usize, col: usize) {
        self.cells.set(row, col, Cell::Void);
        remove_at(&mut self.objects, (row, col));
        remove_at(&mut self.labels, (row, col));
        remove_at(&mut self.painted, (row, col));
        remove_at(&mut self.stairs, (row, col));
    }

/// Grow or shrink the floor at its edges, in cells: positive adds void, negative cuts off. Whatever stood on a
/// cut cell goes with it; a floor grown at its top moves its contents down the grid, not across the building.
    pub fn resize(&mut self, top: i64, right: i64, bottom: i64, left: i64) -> Result<(), String> {
        let height = self.cells.height() as i64 + top + bottom;
        let width = self.cells.width() as i64 + left + right;
        if height < 1 || width < 1 {
            return Err("a floor needs at least one row and one column".into());
        }
        if height > MAX_SIDE_CELLS as i64 || width > MAX_SIDE_CELLS as i64 {
            return Err(format!("a floor is at most {} m on a side", MAX_SIDE_CELLS as f32 * CELL_M));
        }
        let (height, width) = (height as usize, width as usize);
        self.cells = self.cells.resized(top, left, height, width);
        shift_all(&mut self.objects, top, left, height, width);
        shift_all(&mut self.labels, top, left, height, width);
        shift_all(&mut self.painted, top, left, height, width);
        shift_all(&mut self.stairs, top, left, height, width);
        Ok(())
    }

    /// Everything that has to hold for a floor to be one: a grid with somewhere to stand, and nothing
    /// anchored outside it or saying nothing.
    pub fn check(&self) -> Result<(), String> {
        self.cells.check()?;
        for object in &self.objects {
            object.check()?;
        }
        for label in &self.labels {
            label.check()?;
        }
        self.check_on_floor(&self.objects, "furniture")?;
        self.check_on_floor(&self.labels, "a label")?;
        self.check_on_floor(&self.painted, "paint")?;
        self.check_on_floor(&self.stairs, "a stair")?;
        for stair in &self.stairs {
            if !matches!(self.cells.get(stair.row, stair.col), Cell::Floor | Cell::DoorOpen) {
                return Err(format!(
                    "the stair at {}, {} stands on a cell nobody can stand on",
                    stair.row, stair.col
                ));
            }
            // Its sides are fenced, so the floor before its foot is the only way on and off it.
            let footing = stair
                .foot()
                .into_iter()
                .any(|(row, col)| self.cells.contains(row, col) && matches!(self.cells.get(row, col), Cell::Floor | Cell::DoorOpen));
            if !footing {
                return Err(format!(
                    "the stair at {}, {} has no floor at its foot, so nobody could step off it",
                    stair.row, stair.col
                ));
            }
        }
        Ok(())
    }

    fn check_on_floor<T: OnCell>(&self, items: &[T], what: &str) -> Result<(), String> {
        for item in items {
            let (row, col) = item.cell();
            if !self.cells.contains(row, col) {
                return Err(format!("{what} at {row}, {col} is outside the floor"));
            }
        }
        Ok(())
    }
}

/// The building: the file on disk, and the same thing when a client asks for the plan.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanFile {
    pub version: u32,
    pub cell_m: f32,
    pub floors: Vec<Floor>,
    /// Where somebody arrives who brings no seat of their own. Without it they arrive at the ground floor's
    /// first walkable cell, which is wherever the drawing happens to start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrival: Option<Seat>,
}

impl PlanFile {
/// Read a plan. Refused rather than repaired: a plan nobody checked is a plan two clients disagree about.
    pub fn parse(text: &str) -> Result<PlanFile, String> {
        let file: PlanFile = serde_json::from_str(text).map_err(|problem| format!("not a plan: {problem}"))?;
        file.check()?;
        Ok(file)
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|problem| format!("a plan cannot be written: {problem}"))
    }

    pub fn floor(&self, index: usize) -> Result<&Floor, String> {
        self.floors.get(index).ok_or_else(|| format!("the plan has no floor {index}"))
    }

    /// The floor an edit changes. Only floor 0 is editable today; the building is one floor until the
    /// stairs arrive, and an edit that named another floor is refused rather than quietly ignored.
    pub fn floor_mut(&mut self, index: usize) -> Result<&mut Floor, String> {
        let count = self.floors.len();
        self.floors.get_mut(index).ok_or_else(|| format!("the plan has no floor {index} of {count}"))
    }

    /// Everything that has to hold for a plan to be a plan, in one place.
    pub fn check(&self) -> Result<(), String> {
        if (self.cell_m - CELL_M).abs() > 0.001 {
            return Err(format!(
                "the plan is measured in {} m cells; this build walks on {CELL_M} m ones",
                self.cell_m
            ));
        }
        if self.floors.is_empty() {
            return Err("the plan has no floors".into());
        }
        for (index, floor) in self.floors.iter().enumerate() {
            floor.check().map_err(|problem| format!("floor {:?}: {problem}", floor.name))?;
            for stair in &floor.stairs {
                if stair.to >= self.floors.len() {
                    return Err(format!(
                        "a stair on {:?} leads to floor {}, and the building has {} floors",
                        floor.name,
                        stair.to,
                        self.floors.len()
                    ));
                }
                if stair.to == index {
                    return Err(format!("a stair on {:?} leads to its own floor", floor.name));
                }
                let back = self.floors[stair.to]
                    .stairs
                    .iter()
                    .any(|other| other.row == stair.row && other.col == stair.col && other.to == index);
                if !back {
                    return Err(format!(
                        "the stair at {}, {} on {:?} has no way back",
                        stair.row, stair.col, floor.name
                    ));
                }
            }
        }
        if let Some(arrival) = self.arrival {
            let floor = self.floors.get(arrival.floor).ok_or_else(|| {
                format!("people arrive on floor {}, and the building has {} floors", arrival.floor, self.floors.len())
            })?;
            if !floor.cells.contains(arrival.row, arrival.col) {
                return Err(format!("people arrive at {}, {}, outside {:?}", arrival.row, arrival.col, floor.name));
            }
            // Arriving on a tread would be arriving halfway to another floor.
            if floor.stairs.iter().any(|stair| stair.covers(arrival.row, arrival.col)) {
                return Err(format!("people arrive at {}, {}, on a stair", arrival.row, arrival.col));
            }
        }
        Ok(())
    }

    /// A floor grew or shrank at its top or left edge, and the place people arrive at moves with what stood
    /// there. Cut off with the edge, it is gone, and people arrive where a plan without one sends them.
    pub fn move_arrival(&mut self, floor: usize, by: (i64, i64)) {
        let Some(arrival) = self.arrival.filter(|arrival| arrival.floor == floor) else {
            return;
        };
        let (row, col) = (arrival.row as i64 + by.0, arrival.col as i64 + by.1);
        let on_floor = row >= 0 && col >= 0 && self.floors[floor].cells.contains(row as usize, col as usize);
        self.arrival = on_floor.then_some(Seat { floor, row: row as usize, col: col as usize });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: &str = r#"{
      "version": 1,
      "cell_m": 0.5,
      "floors": [
        {
          "name": "Erdgeschoss",
          "surface": "parquet",
          "cells": [
            ["wall", "wall", "wall", "wall"],
            ["wall", "floor", "doorShut", "wall"],
            ["wall", "floor", "floor", "wall"],
            ["wall", "wall", "wall", "wall"]
          ],
          "painted": [{ "row": 2, "col": 1, "surface": "tile" }],
          "objects": [{ "kind": "desk", "row": 2, "col": 2, "facing": "north" }],
          "labels": [{ "text": "Kaffeeküche", "row": 1, "col": 1 }]
        }
      ]
    }"#;

    #[test]
    fn a_plan_survives_being_read_and_written() {
        let plan = PlanFile::parse(SMALL).unwrap();
        let again = PlanFile::parse(&plan.to_json().unwrap()).unwrap();
        assert_eq!(again.floor(0).unwrap().cells.width(), 4);
        assert_eq!(again.floor(0).unwrap().objects[0].kind, "desk");
        assert_eq!(again.floor(0).unwrap().objects[0].facing, Facing::North);
        assert_eq!(again.floor(0).unwrap().labels[0].text, "Kaffeeküche");
    }

    #[test]
    fn a_shut_door_is_a_wall_to_the_rule_and_an_open_floor_is_not() {
        let plan = PlanFile::parse(SMALL).unwrap();
        let rule = &plan.floor(0).unwrap().cells;
        assert!(rule.walkable(1, 1), "the room behind the door is walkable");
        assert!(!rule.walkable(1, 2), "a shut door is not walkable");
        assert!(rule.get(1, 2).blocks_sound(), "a shut door stops sound");
        assert!(rule.get(0, 0).blocks_sound(), "and a wall does too");
        assert!(rule.path((0.75, 0.75), (0.75, 1.25)).is_some(), "one floor cell leads to the next");
    }

    #[test]
    fn the_surface_is_the_floors_own_unless_it_was_painted_over() {
        let plan = PlanFile::parse(SMALL).unwrap();
        let floor = plan.floor(0).unwrap();
        assert_eq!(floor.surface_at(1, 1), Surface::Parquet);
        assert_eq!(floor.surface_at(2, 1), Surface::Tile);
    }

    #[test]
    fn a_ragged_plan_is_refused() {
        let ragged = SMALL.replace(r#"["wall", "floor", "floor", "wall"]"#, r#"["wall", "floor", "wall"]"#);
        let problem = PlanFile::parse(&ragged).unwrap_err();
        assert!(problem.contains("wide"), "{problem}");
    }

    #[test]
    fn an_unknown_cell_is_refused_by_name() {
        let strange = SMALL.replace(r#""doorShut""#, r#""doorAjar""#);
        let problem = PlanFile::parse(&strange).unwrap_err();
        assert!(problem.contains("doorAjar"), "{problem}");
    }

    #[test]
    fn furniture_outside_the_floor_is_refused() {
        let adrift = SMALL.replace(r#""row": 2, "col": 2"#, r#""row": 9, "col": 2"#);
        let problem = PlanFile::parse(&adrift).unwrap_err();
        assert!(problem.contains("outside the floor"), "{problem}");
    }

    #[test]
    fn a_plan_in_another_cell_size_is_refused_rather_than_quietly_believed() {
        let metres = SMALL.replace(r#""cell_m": 0.5"#, r#""cell_m": 1.0"#);
        let problem = PlanFile::parse(&metres).unwrap_err();
        assert!(problem.contains("0.5 m"), "{problem}");
    }

    #[test]
    fn an_arrival_that_is_not_a_place_on_a_floor_is_refused() {
        let arriving = |seat: &str| SMALL.replace(r#""floors": ["#, &format!(r#""arrival": {seat}, "floors": ["#));
        assert!(PlanFile::parse(&arriving(r#"{ "floor": 0, "row": 2, "col": 1 }"#)).is_ok(), "a cell on the floor is a place");

        let problem = PlanFile::parse(&arriving(r#"{ "floor": 1, "row": 2, "col": 1 }"#)).unwrap_err();
        assert!(problem.contains("floor 1"), "an arrival on a floor the building lacks must be refused: {problem}");

        let problem = PlanFile::parse(&arriving(r#"{ "floor": 0, "row": 9, "col": 1 }"#)).unwrap_err();
        assert!(problem.contains("outside"), "an arrival off the floor must be refused: {problem}");

        let two_floors = r#"{ "version": 1, "cell_m": 0.5, "arrival": { "floor": 0, "row": 1, "col": 2 },
          "floors": [
            { "name": "Ground", "cells": [["wall","wall","wall"],["wall","floor","floor"],["wall","wall","wall"]],
              "stairs": [{ "row": 1, "col": 2, "exits": "east", "to": 1 }] },
            { "name": "Up", "cells": [["wall","wall","wall"],["wall","floor","floor"],["wall","wall","wall"]],
              "stairs": [{ "row": 1, "col": 2, "exits": "east", "to": 0 }] } ] }"#;
        let problem = PlanFile::parse(two_floors).unwrap_err();
        assert!(problem.contains("on a stair"), "an arrival on a tread must be refused: {problem}");
    }

    #[test]
    fn a_stair_with_a_wall_at_its_foot_is_refused() {
        let plan = |exits: &str| {
            format!(
                r#"{{ "version": 1, "cell_m": 0.5, "floors": [
                  {{ "name": "Ground", "cells": [["wall","wall","wall"],["wall","floor","floor"],["wall","wall","wall"]],
                     "stairs": [{{ "row": 1, "col": 2, "exits": "{exits}", "to": 1 }}] }},
                  {{ "name": "Up", "cells": [["wall","wall","wall"],["wall","floor","floor"],["wall","wall","wall"]],
                     "stairs": [{{ "row": 1, "col": 2, "exits": "east", "to": 0 }}] }} ] }}"#
            )
        };
        assert!(PlanFile::parse(&plan("east")).is_ok(), "a stair entered from the floor beside it is a stair");
        let problem = PlanFile::parse(&plan("south")).unwrap_err();
        assert!(problem.contains("foot"), "a stair entered from a wall must be refused, its sides are fenced: {problem}");
    }
}
