//! How the building changes. An edit is a message and the server applies it; it is validated here, in the model,
//! so the rules a plan is read under are the rules an edit is refused by. Nothing is repaired: an edit that
//! would make the plan not a plan is answered with the reason and changes nothing.

use serde::{Deserialize, Serialize};

use std::collections::HashSet;

use crate::model::{put, remove_at};
use crate::{Cell, Facing, Floor, Label, Object, Painted};

/// A cell, as an edit names one.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct At {
    pub row: usize,
    pub col: usize,
}

/// One piece carried from the cell it stands on to another, turned to a facing on the way.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shift {
    pub row: usize,
    pub col: usize,
    pub to_row: usize,
    pub to_col: usize,
    #[serde(default)]
    pub facing: Facing,
}

/// One cell set to a code, as a drag over the floor produces.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CellChange {
    pub row: usize,
    pub col: usize,
    pub cell: Cell,
}

/// A change to the building. One message carries a whole stroke, so a wall dragged across the floor is one round
/// trip and one broadcast rather than one per cell.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Edit {
    /// Set the code of every cell a drag passed over: walls, floor, void, and a door.
    Cells { cells: Vec<CellChange> },
    /// Set what a cell is covered with.
    Paint { cells: Vec<Painted> },
    /// Put pieces down, each replacing whatever stood on its cell — one from the palette, or a copied group.
    Place { objects: Vec<Object> },
    /// Take whatever stands on these cells away.
    Clear { cells: Vec<At> },
    /// Carry pieces to other cells and turn them, all in one: a group moved by a cell can land where one of its
    /// own pieces stood. A piece may not land on something that stays — a move never takes anything away.
    Arrange { moves: Vec<Shift> },
    /// Name a place at a cell, replacing any name already there.
    Label { row: usize, col: usize, text: String },
    /// Take the name at a cell away.
    Unlabel { row: usize, col: usize },
    /// Grow or shrink the floor at its edges, in cells: positive adds void, negative cuts off.
    Resize { top: i64, right: i64, bottom: i64, left: i64 },
}

impl Edit {
    /// Apply this edit to one floor, or refuse it with a reason. Everything is checked before anything is
    /// written, so a stroke is whole or it is nothing.
    pub fn apply(&self, floor: &mut Floor) -> Result<(), String> {
        for (row, col) in self.cells_touched() {
            floor.require_cell(row, col)?;
        }
        match self {
            Edit::Cells { cells } => {
                for change in cells {
                    // A wall or a floor is still a cell, so it leaves what is attached to it alone; only void
                    // takes it away, because the cell stops existing.
                    match change.cell {
                        Cell::Void => floor.erase(change.row, change.col),
                        cell => floor.cells.set(change.row, change.col, cell),
                    }
                }
            }
            Edit::Paint { cells } => {
                for patch in cells {
                    put(&mut floor.painted, patch.clone());
                }
            }
            Edit::Place { objects } => {
                let mut cells = HashSet::new();
                for object in objects {
                    object.check()?;
                    if !cells.insert((object.row, object.col)) {
                        return Err(format!("two pieces cannot stand at {}, {}", object.row, object.col));
                    }
                }
                for object in objects {
                    put(&mut floor.objects, object.clone());
                }
            }
            Edit::Clear { cells } => {
                for at in cells {
                    remove_at(&mut floor.objects, (at.row, at.col));
                }
            }
            Edit::Arrange { moves } => arrange(floor, moves)?,
            Edit::Label { row, col, text } => {
                let label = Label { text: text.clone(), row: *row, col: *col };
                label.check()?;
                put(&mut floor.labels, label);
            }
            Edit::Unlabel { row, col } => remove_at(&mut floor.labels, (*row, *col)),
            Edit::Resize { top, right, bottom, left } => floor.resize(*top, *right, *bottom, *left)?,
        }
        Ok(())
    }

    /// How far everything on the floor moved, so the people standing there can move with it.
    pub fn moved_by(&self) -> (i64, i64) {
        match self {
            Edit::Resize { top, left, .. } => (*top, *left),
            _ => (0, 0),
        }
    }

    /// Every cell this edit names, so all of them are checked before any of them is written.
    fn cells_touched(&self) -> Vec<(usize, usize)> {
        match self {
            Edit::Cells { cells } => cells.iter().map(|change| (change.row, change.col)).collect(),
            Edit::Paint { cells } => cells.iter().map(|patch| (patch.row, patch.col)).collect(),
            Edit::Place { objects } => objects.iter().map(|object| (object.row, object.col)).collect(),
            Edit::Clear { cells } => cells.iter().map(|at| (at.row, at.col)).collect(),
            Edit::Arrange { moves } => {
                moves.iter().flat_map(|shift| [(shift.row, shift.col), (shift.to_row, shift.to_col)]).collect()
            }
            Edit::Label { row, col, .. } | Edit::Unlabel { row, col } => vec![(*row, *col)],
            Edit::Resize { .. } => Vec::new(),
        }
    }
}

/// Carry every listed piece to its new cell, or refuse the whole move. Checked before anything moves: each
/// piece has to be there, no two may land on one cell, and none may land on a piece that is not moving.
fn arrange(floor: &mut Floor, moves: &[Shift]) -> Result<(), String> {
    let from: HashSet<(usize, usize)> = moves.iter().map(|shift| (shift.row, shift.col)).collect();
    if from.len() != moves.len() {
        return Err("one piece is moved twice".into());
    }
    let mut to = HashSet::new();
    for shift in moves {
        let (row, col) = (shift.row, shift.col);
        if !floor.objects.iter().any(|object| (object.row, object.col) == (row, col)) {
            return Err(format!("nothing stands at {row}, {col} to move"));
        }
        let target = (shift.to_row, shift.to_col);
        if !to.insert(target) {
            return Err(format!("two pieces cannot land at {}, {}", target.0, target.1));
        }
        let taken = !from.contains(&target) && floor.objects.iter().any(|object| (object.row, object.col) == target);
        if taken {
            return Err(format!("something already stands at {}, {}", target.0, target.1));
        }
    }
    for object in floor.objects.iter_mut() {
        if let Some(shift) = moves.iter().find(|shift| (shift.row, shift.col) == (object.row, object.col)) {
            (object.row, object.col, object.facing) = (shift.to_row, shift.to_col, shift.facing);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FromClient, Grid, PlanFile, Surface, ToClient};

    /// A small floor to edit: a room with a shut door in its wall, so a toggle has something to change.
    fn a_floor() -> Floor {
        let text = r#"{
          "version": 1, "cell_m": 0.5,
          "floors": [{
            "name": "Test", "surface": "parquet",
            "cells": [
              ["wall","wall","wall","wall"],
              ["wall","floor","floor","wall"],
              ["wall","doorShut","floor","wall"],
              ["wall","wall","wall","wall"]
            ]
          }]
        }"#;
        PlanFile::parse(text).unwrap().floor(0).unwrap().clone()
    }

    fn rule(floor: &Floor) -> &Grid {
        &floor.cells
    }

    fn place(kind: &str, row: usize, col: usize, facing: Facing) -> Edit {
        Edit::Place { objects: vec![Object { kind: kind.into(), row, col, facing }] }
    }

    #[test]
    fn a_stroke_writes_every_cell_it_names() {
        let mut floor = a_floor();
        let edit = Edit::Cells {
            cells: vec![
                CellChange { row: 1, col: 1, cell: Cell::Wall },
                CellChange { row: 1, col: 2, cell: Cell::Void },
                CellChange { row: 2, col: 1, cell: Cell::DoorOpen },
            ],
        };
        edit.apply(&mut floor).unwrap();
        assert_eq!(floor.cells.get(1, 1), Cell::Wall);
        assert_eq!(floor.cells.get(1, 2), Cell::Void);
        assert_eq!(floor.cells.get(2, 1), Cell::DoorOpen);
    }

    #[test]
    fn an_edit_outside_the_floor_is_refused_with_a_reason_and_changes_nothing() {
        let mut floor = a_floor();
        let before = floor.cells.clone();
        let problem = Edit::Cells {
            cells: vec![
                CellChange { row: 1, col: 1, cell: Cell::Wall },
                CellChange { row: 9, col: 9, cell: Cell::Floor },
            ],
        }
        .apply(&mut floor)
        .unwrap_err();
        assert!(problem.contains("outside"), "{problem}");
        // The good half of the stroke is not written either: a stroke is whole or it is nothing.
        assert_eq!(floor.cells, before);
    }

    #[test]
    fn an_unknown_cell_code_is_refused_by_name() {
        // A cell code is typed, so an unknown one cannot reach `apply` at all: it is refused where the
        // message is read, and the reason still names it.
        let problem = serde_json::from_str::<FromClient>(
            r#"{"type":"edit","edit":{"action":"cells","cells":[{"row":1,"col":1,"cell":"garden"}]}}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(problem.contains("garden"), "{problem}");
    }

    #[test]
    fn a_placed_thing_replaces_what_stood_there_and_a_cleared_cell_forgets_it() {
        let mut floor = a_floor();
        place("desk", 1, 1, Facing::North)
            .apply(&mut floor)
            .unwrap();
        place("chairDesk", 1, 1, Facing::South)
            .apply(&mut floor)
            .unwrap();
        assert_eq!(floor.objects.len(), 1, "one cell carries one thing");
        assert_eq!(floor.objects[0].kind, "chairDesk");
        Edit::Clear { cells: vec![At { row: 1, col: 1 }] }.apply(&mut floor).unwrap();
        assert!(floor.objects.is_empty());
    }

    #[test]
    fn a_label_can_be_put_and_taken_away_and_an_empty_one_is_refused() {
        let mut floor = a_floor();
        Edit::Label { row: 1, col: 1, text: "Labor".into() }.apply(&mut floor).unwrap();
        assert_eq!(floor.labels.len(), 1);
        assert!(Edit::Label { row: 1, col: 1, text: "   ".into() }.apply(&mut floor).is_err());
        Edit::Unlabel { row: 1, col: 1 }.apply(&mut floor).unwrap();
        assert!(floor.labels.is_empty());
    }

    #[test]
    fn paint_replaces_the_surface_a_cell_already_had() {
        let mut floor = a_floor();
        Edit::Paint { cells: vec![Painted { row: 1, col: 1, surface: Surface::Tile }] }
            .apply(&mut floor)
            .unwrap();
        Edit::Paint { cells: vec![Painted { row: 1, col: 1, surface: Surface::Carpet }] }
            .apply(&mut floor)
            .unwrap();
        assert_eq!(floor.surface_at(1, 1), Surface::Carpet);
    }

    #[test]
    fn a_door_toggles_and_the_rules_answer_changes_with_it() {
        let mut floor = a_floor();
        // Shut: a wall to the rule — not walkable, and it cuts sound.
        assert!(!rule(&floor).walkable(2, 1));
        assert!(rule(&floor).get(2, 1).blocks_sound());
        floor.toggle_door(2, 1).unwrap();
        assert_eq!(floor.cells.get(2, 1), Cell::DoorOpen);
        // Open: floor, and sound crosses it.
        assert!(rule(&floor).walkable(2, 1));
        assert!(!rule(&floor).get(2, 1).blocks_sound());
        floor.toggle_door(2, 1).unwrap();
        assert_eq!(floor.cells.get(2, 1), Cell::DoorShut);
    }

    #[test]
    fn toggling_something_that_is_not_a_door_is_refused_by_name() {
        let mut floor = a_floor();
        let problem = floor.toggle_door(1, 1).unwrap_err();
        assert!(problem.contains("floor"), "{problem}");
        assert!(floor.toggle_door(9, 9).is_err());
    }

    #[test]
    fn an_erase_takes_what_stood_on_the_cell_with_it() {
        // Erase writes `void`, and a void cell is not a cell: the furniture, the name and the paint all
        // go with it, rather than staying attached to ground that is no longer there.
        let mut floor = a_floor();
        place("desk", 1, 1, Facing::North)
            .apply(&mut floor)
            .unwrap();
        Edit::Label { row: 1, col: 1, text: "Labor".into() }.apply(&mut floor).unwrap();
        Edit::Paint { cells: vec![Painted { row: 1, col: 1, surface: Surface::Carpet }] }
            .apply(&mut floor)
            .unwrap();
        assert_eq!(floor.surface_at(1, 1), Surface::Carpet, "the paint was there to begin with");

        Edit::Cells { cells: vec![CellChange { row: 1, col: 1, cell: Cell::Void }] }
            .apply(&mut floor)
            .unwrap();

        assert_eq!(floor.cells.get(1, 1), Cell::Void);
        assert!(floor.objects.is_empty(), "nothing stands on a cell that is not there");
        assert!(floor.labels.is_empty(), "and it carries no name");
        assert_eq!(floor.surface_at(1, 1), Surface::Parquet, "and no paint is left on it");
    }

    #[test]
    fn a_wall_or_a_floor_does_not_take_the_furniture_off_a_cell() {
        // The erase takes decorations because the cell stops existing. A wall is still a cell a plan knows
        // about, so changing a cell to one leaves what stands on it alone — this is the erase, not a sweep.
        let mut floor = a_floor();
        place("desk", 1, 1, Facing::North)
            .apply(&mut floor)
            .unwrap();
        Edit::Cells { cells: vec![CellChange { row: 1, col: 1, cell: Cell::Wall }] }
            .apply(&mut floor)
            .unwrap();
        assert_eq!(floor.objects.len(), 1, "a wall keeps the desk that was on the cell");
    }

    #[test]
    fn an_edit_that_empties_the_floor_is_caught_by_the_whole_model_not_by_the_edit() {
        // A one-cell floor, owned by nobody. The edit is a legal value; the model as a whole is not.
        let text = r#"{"version":1,"cell_m":0.5,"floors":[{"name":"T","cells":[["floor"]]}]}"#;
        let mut file = PlanFile::parse(text).unwrap();
        Edit::Cells { cells: vec![CellChange { row: 0, col: 0, cell: Cell::Wall }] }
            .apply(file.floor_mut(0).unwrap())
            .unwrap();
        assert!(file.check().unwrap_err().contains("no floor"));
    }

    #[test]
    fn an_edit_and_a_door_and_a_lock_are_the_messages_they_say_they_are() {
        let json = serde_json::to_value(Edit::Cells {
            cells: vec![CellChange { row: 1, col: 2, cell: Cell::Wall }],
        })
        .unwrap();
        assert_eq!(json["action"], "cells");
        match serde_json::from_str::<FromClient>(
            r#"{"type":"edit","edit":{"action":"clear","cells":[{"row":1,"col":2}]}}"#,
        )
        .unwrap()
        {
            FromClient::Edit { edit: Edit::Clear { cells }, .. } => assert_eq!(cells, vec![At { row: 1, col: 2 }]),
            other => panic!("an edit became {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"toggle_door","row":1,"col":2}"#).unwrap() {
            FromClient::ToggleDoor { floor: _, row, col } => assert_eq!((row, col), (1, 2)),
            other => panic!("a door toggle became {other:?}"),
        }
        let lock = serde_json::to_value(ToClient::Lock { holder: Some(3), name: Some("Ada".into()) }).unwrap();
        assert_eq!(lock["type"], "lock");
        assert_eq!(lock["holder"], 3);
        assert_eq!(lock["name"], "Ada");
        let none = serde_json::to_value(ToClient::Lock { holder: None, name: None }).unwrap();
        assert!(none["holder"].is_null());
        let refused = serde_json::to_value(ToClient::Refused { reason: "no".into() }).unwrap();
        assert_eq!(refused["type"], "refused");
        match serde_json::from_str::<FromClient>(
            r#"{"type":"edit","edit":{"action":"place","objects":[{"row":1,"col":2,"kind":"desk"}]}}"#,
        )
        .unwrap()
        {
            FromClient::Edit { edit: Edit::Place { objects }, .. } => {
                assert_eq!(objects[0].kind, "desk");
                assert_eq!(objects[0].facing, Facing::South, "a piece faces south unless it says otherwise");
            }
            other => panic!("an edit became {other:?}"),
        }
    }

    fn kinds_at(floor: &Floor) -> Vec<(String, usize, usize, Facing)> {
        let mut found: Vec<_> = floor.objects.iter().map(|o| (o.kind.clone(), o.row, o.col, o.facing)).collect();
        found.sort_by_key(|(_, row, col, _)| (*row, *col));
        found
    }

    fn shift(row: usize, col: usize, to_row: usize, to_col: usize, facing: Facing) -> Shift {
        Shift { row, col, to_row, to_col, facing }
    }

    #[test]
    fn a_group_moved_onto_its_own_cells_lands_whole() {
        // Two pieces side by side, moved one cell east: the first lands where the second stood. Piece by
        // piece that is a collision; as one arrangement it is a move.
        let mut floor = a_floor();
        Edit::Place {
            objects: vec![
                Object { kind: "chairDesk".into(), row: 1, col: 1, facing: Facing::North },
                Object { kind: "desk".into(), row: 2, col: 1, facing: Facing::North },
            ],
        }
        .apply(&mut floor)
        .unwrap();
        Edit::Arrange {
            moves: vec![shift(1, 1, 1, 2, Facing::East), shift(2, 1, 2, 2, Facing::East)],
        }
        .apply(&mut floor)
        .unwrap();
        assert_eq!(
            kinds_at(&floor),
            vec![("chairDesk".into(), 1, 2, Facing::East), ("desk".into(), 2, 2, Facing::East)]
        );
    }

    #[test]
    fn a_move_never_takes_away_what_it_lands_on_and_is_refused_whole() {
        let mut floor = a_floor();
        Edit::Place {
            objects: vec![
                Object { kind: "desk".into(), row: 1, col: 1, facing: Facing::South },
                Object { kind: "plantSmall1".into(), row: 1, col: 2, facing: Facing::South },
                Object { kind: "laptop".into(), row: 2, col: 2, facing: Facing::South },
            ],
        }
        .apply(&mut floor)
        .unwrap();
        let before = kinds_at(&floor);

        let onto_a_plant = Edit::Arrange {
            moves: vec![shift(2, 2, 2, 1, Facing::South), shift(1, 1, 1, 2, Facing::South)],
        };
        let problem = onto_a_plant.apply(&mut floor).unwrap_err();
        assert!(problem.contains("already stands at 1, 2"), "{problem}");
        assert_eq!(kinds_at(&floor), before, "the half that could move must not have moved");

        let two_onto_one = Edit::Arrange {
            moves: vec![shift(1, 1, 2, 1, Facing::South), shift(2, 2, 2, 1, Facing::South)],
        };
        assert!(two_onto_one.apply(&mut floor).unwrap_err().contains("two pieces"));
        let nothing_there = Edit::Arrange { moves: vec![shift(2, 1, 1, 1, Facing::South)] };
        assert!(nothing_there.apply(&mut floor).unwrap_err().contains("nothing stands"));
        assert_eq!(kinds_at(&floor), before);
    }

    #[test]
    fn a_floor_grown_at_its_top_left_keeps_everything_where_it_was_in_the_building() {
        let mut floor = a_floor();
        place("desk", 1, 1, Facing::North).apply(&mut floor).unwrap();
        Edit::Label { row: 1, col: 2, text: "Labor".into() }.apply(&mut floor).unwrap();

        let grow = Edit::Resize { top: 2, right: 1, bottom: 0, left: 3 };
        grow.apply(&mut floor).unwrap();

        assert_eq!((floor.cells.height(), floor.cells.width()), (6, 8));
        assert_eq!(floor.cells.get(0, 0), Cell::Void, "what is new is void");
        assert_eq!(floor.cells.get(4, 4), Cell::DoorShut, "the door moved with the floor");
        assert_eq!(kinds_at(&floor), vec![("desk".into(), 3, 4, Facing::North)]);
        assert_eq!((floor.labels[0].row, floor.labels[0].col), (3, 5));
        assert_eq!(grow.moved_by(), (2, 3), "people have to move by the same cells");
    }

    #[test]
    fn a_floor_cut_down_drops_what_stood_on_the_cut_and_cannot_vanish() {
        let mut floor = a_floor();
        place("desk", 1, 1, Facing::North).apply(&mut floor).unwrap();
        place("laptop", 2, 2, Facing::North).apply(&mut floor).unwrap();

        Edit::Resize { top: -2, right: 0, bottom: 0, left: 0 }.apply(&mut floor).unwrap();
        assert_eq!(floor.cells.height(), 2);
        assert_eq!(kinds_at(&floor), vec![("laptop".into(), 0, 2, Facing::North)]);

        let problem = Edit::Resize { top: 0, right: -4, bottom: 0, left: 0 }.apply(&mut floor).unwrap_err();
        assert!(problem.contains("at least one"), "{problem}");
        let problem = Edit::Resize { top: 0, right: 500, bottom: 0, left: 0 }.apply(&mut floor).unwrap_err();
        assert!(problem.contains("200 m"), "{problem}");
    }
}
