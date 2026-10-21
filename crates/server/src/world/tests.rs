//! What the floor does, without a socket: the plan, the walks, the doors and the calls.

use super::*;

use office_mumble_wire::{At, Cell, CellChange, Edit, Figure, Object, Painted, PlanFile, Seat, Surface, CELL_M};

/// A world on a small, known floor: two cells on either side of a shut door, so an edit has somewhere
/// to build and a door has something to change.
fn a_world() -> World {
    let text = r#"{
      "version": 1, "cell_m": 0.5,
      "floors": [{
        "name": "Test", "surface": "parquet",
        "cells": [
          ["wall","wall","wall","wall","wall","wall"],
          ["wall","floor","floor","doorShut","floor","wall"],
          ["wall","floor","floor","doorShut","floor","wall"],
          ["wall","wall","wall","wall","wall","wall"]
        ]
      }]
    }"#;
    let model = PlanFile::parse(text).expect("test plan parses");
    World::new(model, "test".into())
}

fn one_cell(row: usize, col: usize, cell: Cell) -> Edit {
    Edit::Cells { cells: vec![CellChange { row, col, cell }] }
}

fn place(kind: &str, row: usize, col: usize, facing: office_mumble_wire::Facing) -> Edit {
    Edit::Place { objects: vec![Object { kind: kind.into(), row, col, facing }] }
}

#[test]
fn a_floor_grown_at_its_top_left_moves_the_people_with_it_and_one_cut_away_under_them_carries_them() {
    let mut world = a_world();
    world.model.arrival = Some(Seat { floor: 0, row: 1, col: 4 });
    let (id, _) = world.join("Ada".into(), None);
    world.people[0].x = 2.25;
    world.people[0].y = 0.75;
    assert_eq!(world.grid().cell_at(2.25, 0.75), (1, 4));

    let grow = Edit::Resize { top: 2, right: 0, bottom: 0, left: 1 };
    world.apply_edit(1, 0, grow).1.expect("a floor may grow");
    let ada = world.people.iter().find(|p| p.id == id).unwrap();
    assert_eq!(world.grid().cell_at(ada.x, ada.y), (3, 5), "she stands where she stood in the building");
    let arrival = world.model.arrival.map(|seat| (seat.row, seat.col));
    assert_eq!(arrival, Some((3, 5)), "the arrival must move with the floor it is on");

    let cut = Edit::Resize { top: 0, right: -3, bottom: 0, left: 0 };
    world.apply_edit(1, 0, cut).1.expect("a floor may shrink while somewhere is left to stand");
    assert!(world.model.arrival.is_none(), "an arrival cut off with the edge must be gone, not moved onto the edge");
    let ada = world.people.iter().find(|p| p.id == id).unwrap();
    // Asked with `cell_containing`, not `cell_at`: the latter clamps a point off the grid onto its edge,
    // and the edge cell here is floor — exactly the case where somebody could be left standing on nothing.
    let (row, col) = world.grid().cell_containing(ada.x, ada.y).expect("she must stand on the floor that is left");
    assert!(world.grid().walkable(row, col), "whoever stood on the cut is carried onto the floor that is left");
}

#[test]
fn an_edit_applies_to_the_plan_the_rule_walks_on() {
    let mut world = a_world();
    let (took_the_lock, outcome) = world.apply_edit(1, 0, one_cell(1, 1, Cell::Wall));
    outcome.expect("an edit inside the floor is applied");
    assert!(took_the_lock, "the first editor takes the lock");
    assert_eq!(world.model.floor(0).unwrap().cells.get(1, 1), Cell::Wall);
    assert!(!world.grid().walkable(1, 1), "the rule the clients get walks on the edited cell");
}

#[test]
fn an_invalid_edit_is_refused_with_a_reason_and_the_plan_is_untouched() {
    // Outside the floor: refused by name, and nothing written.
    let mut world = a_world();
    let before = world.model.floor(0).unwrap().cells.clone();
    let (took_the_lock, outcome) = world.apply_edit(1, 0, one_cell(99, 99, Cell::Wall));
    let reason = outcome.unwrap_err();
    assert!(reason.contains("outside"), "{reason}");
    assert_eq!(world.model.floor(0).unwrap().cells, before);
    assert!(!took_the_lock, "a refused edit does not take the lock");
    assert_eq!(world.lock, None, "and the building is left free for somebody else");

    // A stroke that would leave nothing to stand on is refused by the whole model, not by the edit.
    let mut world = a_world();
    let walls: Vec<CellChange> = (0..4)
        .flat_map(|row| (0..6).map(move |col| CellChange { row, col, cell: Cell::Wall }))
        .collect();
    let (took_the_lock, outcome) = world.apply_edit(1, 0, Edit::Cells { cells: walls });
    assert!(outcome.unwrap_err().contains("no floor"), "the whole model refused it");
    assert!(!took_the_lock, "the whole model's refusal takes no lock either");
    assert_eq!(world.lock, None);
}

#[test]
fn a_refused_edit_does_not_take_the_lock_so_another_editor_may_still_build() {
    // The one accidental bad edit must not block the building: Ada's out-of-bounds stroke is refused,
    // and the lock is still free, so Bob is the first editor who actually edits.
    let mut world = a_world();
    world.join("Ada".into(), None); // id 1
    world.join("Bob".into(), None); // id 2

    let (took_the_lock, outcome) = world.apply_edit(1, 0, one_cell(99, 99, Cell::Wall));
    assert!(!took_the_lock);
    assert!(outcome.is_err());
    assert_eq!(world.lock, None, "the refused edit left the building free");

    let (took_the_lock, outcome) = world.apply_edit(2, 0, one_cell(1, 1, Cell::Wall));
    assert!(took_the_lock, "Bob takes the lock by being the first edit that lands");
    assert!(outcome.is_ok());
    assert_eq!(world.lock, Some(2));
    assert_eq!(world.model.floor(0).unwrap().cells.get(1, 1), Cell::Wall);
}

#[test]
fn the_lock_refuses_a_second_editor_and_lapses_when_the_holder_leaves() {
    let mut world = a_world();
    world.join("Ada".into(), None); // id 1
    world.join("Bob".into(), None); // id 2

    // Ada edits first and holds it; she may keep editing while she does.
    let (took_the_lock, outcome) = world.apply_edit(1, 0, one_cell(1, 1, Cell::Wall));
    assert!(took_the_lock);
    assert!(outcome.is_ok());
    assert_eq!(world.lock, Some(1));
    assert!(world.apply_edit(1, 0, one_cell(2, 1, Cell::Wall)).1.is_ok(), "the holder keeps editing");

    // Bob is refused, by name, and nothing he asked for is written.
    let (took_the_lock, outcome) = world.apply_edit(2, 0, one_cell(2, 2, Cell::Wall));
    assert!(!took_the_lock, "a refused editor does not take the lock");
    let reason = outcome.unwrap_err();
    assert!(reason.contains("Ada"), "{reason}");
    assert!(world.grid().walkable(2, 2), "Bob's edit changed nothing");

    // When Ada's connection ends the lock lapses, and Bob may edit.
    assert!(world.release_lock(1), "the holder's leave releases it");
    assert!(!world.release_lock(2), "Bob was never the holder");
    assert_eq!(world.lock, None);
    let (took_the_lock, outcome) = world.apply_edit(2, 0, one_cell(2, 2, Cell::Wall));
    assert!(took_the_lock);
    assert!(outcome.is_ok());
}

#[test]
fn an_edit_that_walls_somebody_in_carries_them_to_the_nearest_floor() {
    let mut world = a_world();
    let (id, _) = world.join("Ada".into(), None);
    // Stand Ada in the far room by hand, on a cell an edit is about to make a wall.
    world.people[0].x = 2.25;
    world.people[0].y = 0.75;
    assert_eq!(world.grid().cell_at(2.25, 0.75), (1, 4));
    assert!(world.grid().walkable(1, 4));

    world.apply_edit(1, 0, one_cell(1, 4, Cell::Wall)).1.expect("an edit inside the floor is applied");

    assert!(!world.grid().walkable(1, 4));
    let person = world.people.iter().find(|p| p.id == id).unwrap();
    let (row, col) = world.grid().cell_at(person.x, person.y);
    assert!(world.grid().walkable(row, col), "she was carried onto the floor, not left inside a wall");
}

#[test]
fn an_edit_that_blocks_a_later_waypoint_sends_the_walker_round_it() {
    let mut world = a_world();
    let (id, _) = world.join("Ada".into(), None);
    // Ada stands at (1,1) and has been sent to (2,2). The short way there runs through (2,1), which an
    // edit is about to make a wall — she is on good ground, only her route is blocked.
    world.people[0].x = 0.75;
    world.people[0].y = 0.75;
    assert_eq!(world.grid().cell_at(0.75, 0.75), (1, 1));
    let route = world.grid().path((0.75, 0.75), world.grid().center(2, 2)).expect("there is a way");
    assert!(
        route.iter().any(|&(x, y)| world.grid().cell_at(x, y) == (2, 1)),
        "the planned way runs through (2,1)"
    );
    world.people[0].walk_to(route);

    world.apply_edit(1, 0, one_cell(2, 1, Cell::Wall)).1.expect("an edit inside the floor is applied");

    let person = world.people.iter().find(|p| p.id == id).unwrap();
    assert!(!person.path.is_empty(), "there is a way round, so walking on continues");
    for &(x, y) in &person.path {
        let (row, col) = world.grid().cell_at(x, y);
        assert!(world.grid().walkable(row, col), "waypoint {x},{y} is inside what the edit blocked");
    }
    assert!(
        person.path.iter().all(|&(x, y)| world.grid().cell_at(x, y) != (2, 1)),
        "the route no longer goes through the cell the edit made a wall"
    );
}

#[test]
fn a_route_to_a_place_an_edit_shut_off_is_let_go_of_rather_than_walked() {
    let mut world = a_world();
    let (id, _) = world.join("Ada".into(), None);
    world.people[0].x = 0.75;
    world.people[0].y = 0.75;
    let route = world.grid().path((0.75, 0.75), world.grid().center(2, 2)).expect("there is a way");
    world.people[0].walk_to(route);

    // Both approaches to (2,2) become walls: the place is shut off, so there is nowhere to keep walking.
    let both_ways = Edit::Cells {
        cells: vec![
            CellChange { row: 2, col: 1, cell: Cell::Wall },
            CellChange { row: 1, col: 2, cell: Cell::Wall },
        ],
    };
    world.apply_edit(1, 0, both_ways).1.expect("the edit is applied");

    let person = world.people.iter().find(|p| p.id == id).unwrap();
    assert!(person.path.is_empty(), "she stands rather than walking into what blocks her");
    let (row, col) = world.grid().cell_at(person.x, person.y);
    assert!(world.grid().walkable(row, col), "and she is on the floor she was already standing on");
}

#[test]
fn a_route_an_edit_does_not_touch_is_left_exactly_as_it_was() {
    // The fix only acts on a route the new plan actually blocks; anything else is nobody's business.
    let mut world = a_world();
    let (id, _) = world.join("Ada".into(), None);
    world.people[0].x = 0.75;
    world.people[0].y = 0.75;
    let route = world.grid().path((0.75, 0.75), world.grid().center(2, 2)).expect("there is a way");
    world.people[0].walk_to(route.clone());

    world.apply_edit(1, 0, one_cell(2, 4, Cell::Wall)).1.expect("an edit away from the route is applied");

    let person = world.people.iter().find(|p| p.id == id).unwrap();
    assert_eq!(person.path, route, "an edit elsewhere leaves the way alone");
}

#[test]
fn erasing_a_cell_takes_its_furniture_and_its_name_with_it() {
    // The Erase tool sends only a `cells` edit of `void`. That edit is what takes the desk, the name and
    // the paint off the cell, so the plan the clients get has nothing standing on ground that is gone.
    let mut world = a_world();
    world
        .apply_edit(1, 0, Edit::Paint { cells: vec![Painted { row: 1, col: 1, surface: Surface::Carpet }] })
        .1
        .expect("paint is applied");
    world
        .apply_edit(1, 0, place("desk", 1, 1, Default::default()))
        .1
        .expect("a thing is placed");
    world
        .apply_edit(1, 0, Edit::Label { row: 1, col: 1, text: "Labor".into() })
        .1
        .expect("a name is put down");

    world.apply_edit(1, 0, one_cell(1, 1, Cell::Void)).1.expect("the erase is applied");

    let floor = world.model.floor(0).unwrap();
    assert_eq!(floor.cells.get(1, 1), Cell::Void);
    assert!(floor.objects.is_empty(), "nothing stands on a cell that is no longer there");
    assert!(floor.labels.is_empty(), "the name went with it");
    assert_eq!(floor.surface_at(1, 1), floor.surface, "and no paint is left on it");
}

#[test]
fn a_door_toggled_on_the_server_is_the_rule_the_clients_get_and_needs_no_lock() {
    let mut world = a_world();
    world.join("Ada".into(), None); // holds nothing yet, and arrives at the first floor cell: here
    world.people.push(Person::new(2, "Bob", 2.25, 0.75)); // there, behind the door
    let here = office_mumble_hearing::Person { id: 1, x: 0.75, y: 0.75 };
    let there = office_mumble_hearing::Person { id: 2, x: 2.25, y: 0.75 };
    let introduced = |world: &mut World| {
        world
            .handle(1, FromClient::Introduce { to: 2 })
            .iter()
            .any(|out| matches!(out, Outbound::To(2, ToClient::Introduction { from: 1 })))
    };

    // Shut, and the rule hears nothing across it; there is no way through either, and the server carries
    // no introduction or signal between the two sides.
    assert!(world.grid().path((here.x, here.y), (there.x, there.y)).is_none());
    assert_eq!(office_mumble_hearing::audible(world.grid(), here, &[here, there]), vec![]);
    assert!(!introduced(&mut world));
    assert!(world.handle(2, FromClient::Signal { to: 1, payload: "{}".into() }).is_empty());

    // Working the door takes no lock — a door is not a lock — and the plan changes for everybody.
    world.toggle_door(1, 0, 1, 3).expect("a door toggles");
    assert_eq!(world.model.floor(0).unwrap().cells.get(1, 3), Cell::DoorOpen);
    assert!(world.grid().path((here.x, here.y), (there.x, there.y)).is_some());
    assert_eq!(
        office_mumble_hearing::audible(world.grid(), here, &[here, there]),
        vec![office_mumble_hearing::Audible { id: 2, level: 1.0 }],
        "the rule the clients will compute hears them now"
    );
    assert!(introduced(&mut world), "and the server carries what they say to each other");

    // Shutting it again cuts them off just as immediately.
    world.toggle_door(1, 0, 1, 3).expect("a door toggles back");
    assert_eq!(office_mumble_hearing::audible(world.grid(), here, &[here, there]), vec![]);
    assert!(!introduced(&mut world));
    assert!(world.lock.is_none(), "working a door never took the edit lock");
}

#[test]
fn carries_between_two_people_far_out_of_earshot_and_never_to_somebody_who_is_not_here() {
    // Fifteen metres down one corridor is out of earshot and still one area: whether to answer is the
    // listener's rule, and a distance check here would flicker at the edge between two ticks.
    let corridor = vec!["\"floor\""; 40].join(",");
    let text = format!(
        r#"{{"version": 1, "cell_m": 0.5, "floors": [{{"name": "Flur", "surface": "parquet", "cells": [[{corridor}]]}}]}}"#
    );
    let mut world = World::new(PlanFile::parse(&text).expect("test plan parses"), "test".into());
    world.people.push(Person::new(1, "Ada", 0.25, 0.25));
    world.people.push(Person::new(2, "Bob", 15.25, 0.25));

    let carried = world.handle(1, FromClient::Introduce { to: 2 });
    assert!(matches!(carried.as_slice(), [Outbound::To(2, ToClient::Introduction { from: 1 })]));
    assert!(world.handle(1, FromClient::Introduce { to: 7 }).is_empty(), "7 is nobody");
    assert!(world.handle(7, FromClient::Signal { to: 1, payload: "{}".into() }).is_empty());
}

#[test]
fn toggling_something_that_is_not_a_door_is_refused_by_name() {
    let mut world = a_world();
    world.people.push(Person::new(1, "Ada", 1.75, 0.75));
    let reason = world.toggle_door(1, 0, 1, 1).unwrap_err();
    assert!(reason.contains("door"), "{reason}");
    // And the refusal left the floor alone.
    assert_eq!(world.model.floor(0).unwrap().cells.get(1, 1), Cell::Floor);
}

#[test]
fn a_door_is_not_worked_from_across_the_room() {
    let mut world = a_world();
    world.people.push(Person::new(1, "Ada", 20.75, 20.75));
    let reason = world.toggle_door(1, 0, 1, 1).unwrap_err();
    assert!(reason.contains("walk up"), "{reason}");
    assert!(world.lock.is_none(), "a refused handle takes nothing");
}

#[test]
fn the_lock_message_names_the_holder_and_is_empty_when_nobody_is_editing() {
    let mut world = a_world();
    world.join("Ada".into(), None);
    assert!(matches!(world.lock_message(), ToClient::Lock { holder: None, .. }));
    world.apply_edit(1, 0, one_cell(1, 1, Cell::Wall)).1.expect("an edit is applied");
    match world.lock_message() {
        ToClient::Lock { holder: Some(1), name } => assert_eq!(name.as_deref(), Some("Ada")),
        other => panic!("the lock became {other:?}"),
    }
    world.release_lock(1);
    match world.lock_message() {
        ToClient::Lock { holder: None, name: None } => {}
        other => panic!("a lapsed lock became {other:?}"),
    }
}

#[test]
fn paint_and_furniture_edits_reach_the_model_the_clients_get() {
    let mut world = a_world();
    world
        .apply_edit(1, 0, Edit::Paint { cells: vec![Painted { row: 2, col: 1, surface: Surface::Carpet }] })
        .1
        .expect("paint is applied");
    assert_eq!(world.model.floor(0).unwrap().surface_at(2, 1), Surface::Carpet);
    world
        .apply_edit(1, 0, place("desk", 2, 1, Default::default()))
        .1
        .expect("a thing is placed");
    assert_eq!(world.model.floor(0).unwrap().objects[0].kind, "desk");
    world.apply_edit(1, 0, Edit::Clear { cells: vec![At { row: 2, col: 1 }] }).1.expect("a thing is cleared");
    assert!(world.model.floor(0).unwrap().objects.is_empty());
}

/// The figure in force for a person, as everybody else would be sent it.
fn figure_of(world: &World, id: u64) -> Figure {
    match world.state() {
        ToClient::State { people } => people.iter().find(|p| p.id == id).expect("a person").figure.clone(),
        other => panic!("the state became {other:?}"),
    }
}

#[test]
fn a_figure_a_person_chooses_reaches_everybody_and_needs_no_lock() {
    let mut world = a_world();
    world.join("Ada".into(), None); // id 1
    world.join("Bob".into(), None); // id 2
    let before = figure_of(&world, 1);

    // Ada picks a figure the drawing knows, and everybody's next state carries it — hers alone.
    let mut chosen = Figure::for_id(1);
    chosen.parts.head = Some("bald".to_string());
    chosen.parts.arms = Some("folded".to_string());
    chosen.palette.shirt = "#123456".to_string();
    world.set_figure(1, chosen.clone()).expect("a figure the drawing can draw is kept");
    assert_eq!(figure_of(&world, 1), chosen);
    assert_ne!(figure_of(&world, 1), before, "the person is drawn differently now");
    assert_eq!(figure_of(&world, 2), Figure::for_id(2), "nobody else's figure changed");
    assert!(world.lock.is_none(), "a figure is not a building edit and takes no lock");
}

#[test]
fn a_figure_that_cannot_be_drawn_is_refused_and_the_person_keeps_the_one_they_had() {
    let mut world = a_world();
    world.join("Ada".into(), None); // id 1
    let before = figure_of(&world, 1);

    // A colour that is not a colour: refused by name, and Ada keeps the figure she had.
    let mut wrong_colour = Figure::for_id(1);
    wrong_colour.palette.skin = "not-a-colour".to_string();
    let problem = world.set_figure(1, wrong_colour).unwrap_err();
    assert!(problem.contains("skin"), "{problem}");

    // A part the drawing has no style for: refused the same way, never quietly repaired.
    let mut wrong_part = Figure::for_id(1);
    wrong_part.parts.body = Some("hovercraft".to_string());
    let problem = world.set_figure(1, wrong_part).unwrap_err();
    assert!(problem.contains("hovercraft"), "{problem}");

    assert_eq!(figure_of(&world, 1), before, "a refusal changes nothing");
}

#[test]
fn talking_and_muted_are_stated_about_oneself_and_carried_in_the_state() {
    let mut world = a_world();
    world.join("Ada".into(), None); // id 1
    world.join("Bob".into(), None); // id 2

    let person = |world: &World, id: u64| match world.state() {
        ToClient::State { people } => people.into_iter().find(|p| p.id == id).expect("a person"),
        other => panic!("the state became {other:?}"),
    };
    assert!(!person(&world, 1).speaking && !person(&world, 1).muted, "a new arrival is silent");

    world.set_speaking(1, true);
    assert!(person(&world, 1).speaking, "Ada is shown talking");
    assert!(!person(&world, 2).speaking, "and Bob is not");
    world.set_speaking(1, false);
    assert!(!person(&world, 1).speaking, "she stopped, and it shows");

    world.set_muted(1, true);
    assert!(person(&world, 1).muted, "a stopped microphone is carried, so it can be seen");
    assert!(!person(&world, 1).speaking, "and somebody muted is not talking");
}

/// A building with an upstairs: the same small room twice, and a stair at (1, 2) each way.
fn a_world_with_stairs() -> World {
    let text = r#"{
      "version": 1, "cell_m": 0.5,
      "floors": [
        { "name": "Ground", "surface": "parquet",
          "cells": [["wall","wall","wall"],["wall","floor","floor"],["wall","wall","wall"]],
          "stairs": [{ "row": 1, "col": 2, "rows": 1, "cols": 1, "exits": "east", "to": 1 }] },
        { "name": "Up", "surface": "parquet",
          "cells": [["wall","wall","wall"],["wall","floor","floor"],["wall","wall","wall"]],
          "stairs": [{ "row": 1, "col": 2, "rows": 1, "cols": 1, "exits": "east", "to": 0 }] }
      ]
    }"#;
    World::new(PlanFile::parse(text).expect("a plan with stairs parses"), "test".into())
}

/// A room with a flight of three treads along its east wall, and a cell of floor beyond either end of it: the
/// foot downstairs is the north end, the foot upstairs the south end. A stair you have to walk, not step onto.
fn a_world_with_a_flight() -> World {
    let text = r#"{
      "version": 1, "cell_m": 0.5,
      "floors": [
        { "name": "Ground", "surface": "parquet",
          "cells": [["wall","wall","wall","wall","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","wall","wall","wall","wall"]],
          "stairs": [{ "row": 2, "col": 3, "rows": 3, "cols": 1, "exits": "south", "to": 1 }] },
        { "name": "Up", "surface": "parquet",
          "cells": [["wall","wall","wall","wall","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","wall"],
                    ["wall","wall","wall","wall","wall"]],
          "stairs": [{ "row": 2, "col": 3, "rows": 3, "cols": 1, "exits": "north", "to": 0 }] }
      ]
    }"#;
    World::new(PlanFile::parse(text).expect("a plan with a flight parses"), "test".into())
}

/// A room with a desk in the middle and a chair beside it: what a body has to go round, and what it may
/// walk through.
fn a_world_with_furniture() -> World {
    let text = r#"{
      "version": 1, "cell_m": 0.5,
      "floors": [
        { "name": "Ground", "surface": "parquet",
          "cells": [["wall","wall","wall","wall","wall","wall","wall"],
                    ["wall","floor","floor","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","floor","floor","wall"],
                    ["wall","floor","floor","floor","floor","floor","wall"],
                    ["wall","wall","wall","wall","wall","wall","wall"]],
          "objects": [
            { "kind": "desk", "row": 2, "col": 2 },
            { "kind": "chairDesk", "row": 2, "col": 4 }
          ] }
      ]
    }"#;
    World::new(PlanFile::parse(text).expect("a plan with furniture parses"), "test".into())
}

#[test]
fn a_path_goes_round_a_desk() {
    let world = a_world_with_furniture();
    let grid = walk_grid(&world.model, 0);
    let path = grid.path((0.75, 1.75), (5.75, 1.75)).expect("there is a way past");
    let through: Vec<_> = path
        .iter()
        .filter(|(x, y)| (x / CELL_M) as usize == 2 && ((y / CELL_M) as usize == 2 || (y / CELL_M) as usize == 3))
        .collect();
    assert!(through.is_empty(), "the way went through the desk: {through:?}");
}

#[test]
fn a_chair_is_not_a_wall() {
    let world = a_world_with_furniture();
    let grid = walk_grid(&world.model, 0);
    assert!(grid.get(2, 4).walkable(), "a chair is stepped past, not walked round");
}

#[test]
fn the_first_floor_spawn_is_not_inside_a_desk() {
    let world = a_world_with_furniture();
    let grid = walk_grid(&world.model, 0);
    let (x, y) = grid.spawn_point();
    assert!(grid.cell_at(x, y).0 != 2 || grid.cell_at(x, y).1 < 2, "the arrival stood in the desk");
}

#[test]
fn a_whole_plan_can_be_put_in_place() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    let text = r#"{"version":1,"cell_m":0.5,"floors":[{"name":"Only","surface":"parquet",
        "cells":[["wall","wall","wall"],["wall","floor","wall"],["wall","wall","wall"]]}]}"#;
    let plan = PlanFile::parse(text).expect("parses");
    world.handle(id, FromClient::Replace { plan });
    assert_eq!(world.model.floors.len(), 1, "the old floors are gone");
    assert_eq!(world.people[0].floor, 0, "somebody on a floor that is gone comes down");
}

#[test]
fn a_colleague_has_somewhere_to_go() {
    let text = r#"{"version":1,"cell_m":0.5,"floors":[{"name":"Ground","surface":"parquet",
        "cells":[["wall","wall","wall","wall","wall"],
                 ["wall","floor","floor","floor","wall"],
                 ["wall","floor","floor","floor","wall"],
                 ["wall","floor","floor","floor","wall"],
                 ["wall","wall","wall","wall","wall"]],
        "objects":[{"kind":"table","row":2,"col":2}]}]}"#;
    let world = World::new(PlanFile::parse(text).expect("parses"), "test".into());
    let spots = world.haunts();
    assert!(!spots.is_empty(), "a table is somewhere to go");
    for (floor, (x, y)) in spots {
        let grid = walk_grid(&world.model, floor);
        let (row, col) = grid.cell_at(x, y);
        assert!(grid.walkable(row, col), "beside the table, never on it: {row}, {col}");
    }
}

#[test]
fn an_edit_is_written_where_the_plan_came_from() {
    let dir = std::env::temp_dir().join(format!("office-mumble-save-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a temp dir");
    let path = dir.join("plan.json");
    let text = r#"{"version":1,"cell_m":0.5,"floors":[{"name":"Ground","surface":"parquet",
        "cells":[["wall","doorOpen","wall"],["wall","floor","wall"],["wall","wall","wall"]]}]}"#;
    let mut world = World::new(PlanFile::parse(text).expect("parses"), "test".into())
        .keep_on_disk(path.clone());
    world.people.push(Person::new(1, "Ada", 0.75, 0.75));
    world.toggle_door(1, 0, 0, 1).expect("the door turns");
    let written = std::fs::read_to_string(&path).expect("the plan was written");
    assert!(written.contains("doorShut"), "the door's new state is on disk");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_world_without_a_path_writes_nothing() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    world.handle(id, FromClient::TakeStairs { row: 1, col: 2 });
    assert_eq!(world.floor_of(id), 1, "the world still works without a file");
}

#[test]
fn a_flight_takes_you_at_its_last_tread() {
    let mut world = a_world_with_a_flight();
    let (id, _) = world.join("Ada".into(), None);
    world.walk(id, 1.75, 1.25);
    for _ in 0..90 {
        world.step(1.0 / 60.0);
    }
    assert_eq!(world.floor_of(id), 0, "the first tread is still this floor");
    world.walk(id, 1.75, 2.25);
    for _ in 0..60 {
        world.step(1.0 / 60.0);
    }
    assert_eq!(world.floor_of(id), 1, "the last tread takes you up");
}

#[test]
fn a_flight_may_be_clicked_anywhere_on_it() {
    let mut world = a_world_with_a_flight();
    let (id, _) = world.join("Ada".into(), None);
    world.handle(id, FromClient::TakeStairs { row: 3, col: 3 });
    assert_eq!(world.floor_of(id), 1, "a click on the middle tread is a stair too");
}

#[test]
fn a_flight_is_stepped_onto_at_its_foot_and_off_it_there_too() {
    let world = a_world_with_a_flight();
    // From beside the middle tread, the way onto it goes round to the foot and along the treads: the north end
    // downstairs, where the flight starts, and the south end upstairs, where the well starts.
    for (floor, foot) in [(0, (2, 3)), (1, (4, 3))] {
        let grid = walk_grid(&world.model, floor);
        let stair = world.model.floors[floor].stairs[0];
        let cells: Vec<(usize, usize)> = grid
            .path(grid.center(3, 2), grid.center(3, 3))
            .expect("the flight can be reached")
            .into_iter()
            .map(|(x, y)| grid.cell_at(x, y))
            .collect();
        let first = cells.iter().position(|&(row, col)| stair.covers(row, col)).expect("the route ends on the flight");
        assert_eq!(cells[first], foot, "the flight must be stepped onto at its foot on floor {floor}");
        assert!(
            cells[first..].iter().all(|&(row, col)| stair.covers(row, col)),
            "a route must not leave the flight by its side and come back on floor {floor}"
        );
    }
}

#[test]
fn the_stairs_move_you_between_floors() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    assert_eq!(world.floor_of(id), 0);
    world.handle(id, FromClient::TakeStairs { row: 1, col: 2 });
    assert_eq!(world.floor_of(id), 1, "the stair leads up");
    world.handle(id, FromClient::TakeStairs { row: 1, col: 2 });
    assert_eq!(world.floor_of(id), 0, "and back down");
}

#[test]
fn walking_onto_a_stair_takes_you_up() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    assert_eq!(world.floor_of(id), 0);
    world.walk(id, 1.25, 0.75);
    for _ in 0..90 {
        world.step(1.0 / 60.0);
    }
    assert_eq!(world.floor_of(id), 1, "the feet arrived, so the floor changed");
}

#[test]
fn standing_on_the_stair_you_arrived_by_does_not_bounce() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    world.walk(id, 1.25, 0.75);
    for _ in 0..300 {
        world.step(1.0 / 60.0);
    }
    assert_eq!(world.floor_of(id), 1, "still upstairs after five seconds");
}

#[test]
fn clicking_the_stair_underfoot_takes_you_back() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    world.walk(id, 1.25, 0.75);
    for _ in 0..90 {
        world.step(1.0 / 60.0);
    }
    assert_eq!(world.floor_of(id), 1);
    world.walk(id, 1.25, 0.75);
    for _ in 0..10 {
        world.step(1.0 / 60.0);
    }
    assert_eq!(world.floor_of(id), 0, "a click on the stair you stand on takes you back");
}

#[test]
fn a_seat_is_taken_when_it_can_be_stood_on() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), Some(Seat { floor: 1, row: 1, col: 1 }));
    assert_eq!(world.floor_of(id), 1, "the seat names the floor");
    let ada = world.people.iter().find(|p| p.id == id).unwrap();
    assert!((ada.x - 0.75).abs() < 1e-3 && (ada.y - 0.75).abs() < 1e-3, "and the cell");
}

#[test]
fn somebody_without_a_seat_arrives_where_the_plan_says_and_beside_it_once_it_is_built_over() {
    let mut world = a_world();
    world.model.arrival = Some(Seat { floor: 0, row: 2, col: 4 });
    let cell_of = |world: &World, id: u64| {
        let person = world.people.iter().find(|p| p.id == id).unwrap();
        world.grid().cell_at(person.x, person.y)
    };
    let (ada, _) = world.join("Ada".into(), None);
    assert_eq!(cell_of(&world, ada), (2, 4), "somebody without a seat must arrive at the plan's arrival");

    world.apply_edit(ada, 0, one_cell(2, 4, Cell::Wall)).1.expect("the arrival may be built over");
    let (bob, _) = world.join("Bob".into(), None);
    assert_eq!(cell_of(&world, bob), (1, 4), "an arrival built over must send people to the nearest cell beside it");
}

#[test]
fn a_seat_that_became_a_wall_is_not_taken() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), Some(Seat { floor: 1, row: 0, col: 0 }));
    assert_eq!(world.floor_of(id), 0, "the arrival falls back to the spawn");
}

#[test]
fn a_cell_without_a_stair_is_refused() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    let out = world.handle(id, FromClient::TakeStairs { row: 2, col: 1 });
    assert!(out.iter().any(|out| matches!(out, Outbound::Reply(ToClient::Refused { .. }))));
    assert_eq!(world.floor_of(id), 0, "a refused stair moves nobody");
}

#[test]
fn an_edit_changes_only_the_floor_it_names() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    let (_, outcome) = world.apply_edit(id, 1, one_cell(0, 0, Cell::Void));
    outcome.expect("an edit upstairs is applied");
    assert_eq!(world.model.floor(0).unwrap().cells.get(0, 0), Cell::Wall);
    assert_eq!(world.model.floor(1).unwrap().cells.get(0, 0), Cell::Void);
}

#[test]
fn a_wall_may_not_cover_a_stair() {
    let mut world = a_world_with_stairs();
    let (id, _) = world.join("Ada".into(), None);
    let (_, outcome) = world.apply_edit(id, 1, one_cell(1, 2, Cell::Wall));
    let reason = outcome.expect_err("a stair is a way through the building, not a wall");
    assert!(reason.contains("stair"), "the reason says what stands in the way: {reason}");
}

#[test]
fn two_floors_do_not_hear_each_other() {
    let mut world = a_world_with_stairs();
    let (ada, _) = world.join("Ada".into(), None);
    let (bob, _) = world.join("Bob".into(), None);
    assert!(world.same_area(ada, bob), "one room, one floor");
    world.handle(ada, FromClient::TakeStairs { row: 1, col: 2 });
    assert!(!world.same_area(ada, bob), "the ceiling is a wall");
}

#[test]
fn the_round_walks_every_room_on_every_floor_and_takes_the_stair() {
    let plan = r#"{
  "version": 1, "cell_m": 0.5,
  "floors": [
{ "name": "Ground", "surface": "parquet",
  "cells": [["wall","wall","wall","wall","wall"],["wall","floor","floor","floor","wall"],["wall","floor","floor","floor","wall"],["wall","wall","wall","wall","wall"]],
  "labels": [{"text":"Kitchen","row":1,"col":1},{"text":"Desk","row":2,"col":3}],
  "stairs": [{"row":2,"col":3,"rows":1,"cols":1,"exits":"east","to":1}] },
{ "name": "Up", "surface": "parquet",
  "cells": [["wall","wall","wall","wall","wall"],["wall","floor","floor","floor","wall"],["wall","floor","floor","floor","wall"],["wall","wall","wall","wall","wall"]],
  "labels": [{"text":"Meeting","row":1,"col":1},{"text":"Quiet","row":2,"col":1}],
  "stairs": [{"row":2,"col":3,"rows":1,"cols":1,"exits":"east","to":0}] }
  ]
}"#;
    let world = World::new(PlanFile::parse(plan).unwrap(), "round".to_string());
    let route = world.route();

    // The stair is not a stop: stepping on its last tread already changes the floor, so a figure sent
    // there would be turned round before it ever arrived. The label that stood on the tread goes with it.
    assert_eq!(route.len(), 3);
    assert_eq!(route.iter().filter(|(floor, _)| *floor == 0).count(), 1);
    assert_eq!(route.iter().filter(|(floor, _)| *floor == 1).count(), 2);
    let last_ground = route.iter().rposition(|(floor, _)| *floor == 0).unwrap();
    assert_eq!(route[last_ground + 1].0, 1, "the stair ends the floor it belongs to");
}

#[test]
fn the_round_never_stops_on_the_flight() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/floor-t1.json"))
        .expect("the house is in the repository");
    let world = World::new(PlanFile::parse(&text).expect("the fixture is a plan"), "house".to_string());

    for (floor, (x, y)) in world.route() {
        let grid = grid_of(&world.model, floor);
        let (row, col) = grid.cell_containing(x, y).expect("a stop is on a cell");
        let on_flight = world.model.floors[floor]
            .stairs
            .iter()
            .any(|stair| stair.covers(row, col));
        assert!(!on_flight, "a stop on the flight at ({x}, {y}) can never be reached");
    }
}

#[test]
fn the_flight_is_the_one_place_the_ceiling_is_not_a_wall() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/floor-t1.json"))
        .expect("the house is in the repository");
    let mut world = World::new(PlanFile::parse(&text).expect("the fixture is a plan"), "house".to_string());
    let (down, _) = world.join_on("Down".into(), 0, (1.25, 1.25));
    let (up, _) = world.join_on("Up".into(), 1, (10.25, 10.25));

    // Feet on a tread: the voice crosses, because the stair joins both floors.
    assert!(world.same_area(down, up));

    // A step beside the flight, and the ceiling is a wall again.
    if let Some(person) = world.people.iter_mut().find(|p| p.id == down) {
        person.x = 5.25;
        person.y = 5.25;
    }
    assert!(!world.same_area(down, up));
}

#[test]
fn the_round_covers_both_floors_of_the_house() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/floor-t1.json"))
        .expect("the house is in the repository");
    let world = World::new(PlanFile::parse(&text).expect("the fixture is a plan"), "house".to_string());
    let route = world.route();

    assert!(route.iter().any(|(floor, _)| *floor == 0), "the ground floor is walked");
    assert!(route.iter().any(|(floor, _)| *floor == 1), "and so is the one above it");
    assert!(route.len() > 10, "a round of a whole building, not two corners");
}

#[test]
fn a_call_meets_the_caller_a_metre_short() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/floor-t1.json"))
        .expect("the house is in the repository");
    let mut world = World::new(PlanFile::parse(&text).expect("the fixture is a plan"), "house".to_string());
    let (caller, _) = world.join("Caller".to_string(), None);
    let (guest, _) = world.join("Guest".to_string(), None);
    let (x, y, _) = world.place(caller).expect("the caller is on the floor");

    let (tx, ty) = world.a_metre_before(guest, (x, y));
    assert!((tx - x).hypot(ty - y) > 0.9, "a metre short, not on the caller");
    assert!(
        world.can_walk(world.floor_of(guest), (x, y), (tx, ty)),
        "and reachable, not a step into a wall"
    );
}
