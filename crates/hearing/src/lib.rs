//! Who hears whom: pure, symmetric, tested without a user interface. Walls and shut doors cut, distance
//! decides the level, and past `EARSHOT_M` there is no stream at all. The server asks this crate for the area
//! and carries nothing across it; `client/src/hearing.ts` is the same rule in TypeScript, and both answer
//! `fixtures/hearing-cases.json`, so neither can drift without a test failing.

use office_mumble_wire::{Grid, CELL_M};

/// One person the rule reasons about: an id and a place. The server's person carries more, but only these two
/// decide what can be heard.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Person {
    pub id: u64,
    pub x: f32,
    pub y: f32,
}

/// Somebody I can hear, and how loud they are to me.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Audible {
    pub id: u64,
    pub level: f32,
}

/// Within this distance the words are clear.
pub const CLEAR_M: f32 = 2.0;

/// Past this distance there is no stream at all. **Not settled**: it decides how many voices a floor holds, so
/// listening settles it. Was 12 m with words clear to 3 m, which on a 20 m floor put everybody in earshot.
pub const EARSHOT_M: f32 = 8.0;

/// Inverse distance, scaled to reach exactly zero at `EARSHOT_M`: twice as far is half as loud, and it fades
/// to nothing instead of ending at a step.
pub fn level_at(distance_m: f32) -> f32 {
    if distance_m <= CLEAR_M {
        return 1.0;
    }
    if distance_m >= EARSHOT_M {
        return 0.0;
    }
    let murmur_at_the_edge = CLEAR_M / EARSHOT_M;
    (CLEAR_M / distance_m - murmur_at_the_edge) / (1.0 - murmur_at_the_edge)
}

/// Whether a straight line between two places crosses nothing solid: sound with a clear path takes it, and
/// only what has to go round a corner takes the longer way.
fn clear_path(grid: &Grid, from: Person, to: Person) -> bool {
    let (Some(start), Some(end)) = (grid.cell_containing(from.x, from.y), grid.cell_containing(to.x, to.y)) else {
        return false;
    };
    let (mut row, mut col) = start;
    let (span_row, span_col) = (end.0.abs_diff(row), end.1.abs_diff(col));
    let step_row: isize = if row < end.0 { 1 } else { -1 };
    let step_col: isize = if col < end.1 { 1 } else { -1 };
    let mut error = span_col as isize - span_row as isize;
    loop {
        if !grid.walkable(row, col) {
            return false;
        }
        if (row, col) == end {
            return true;
        }
        let doubled = 2 * error;
        if doubled > -(span_row as isize) {
            error -= span_row as isize;
            col = (col as isize + step_col) as usize;
        }
        if doubled < span_col as isize {
            error += span_col as isize;
            row = (row as isize + step_row) as usize;
        }
    }
}

/// Everybody in my area with their level, level zero included. "In my area, out of earshot" and "not in my area"
/// are different — walking away keeps a connection for a moment, a door cuts at once — so the rule says which.
pub fn within(grid: &Grid, me: Person, everybody: &[Person]) -> Vec<Audible> {
    let in_reach = area(grid, me);

    let mut nearby: Vec<Audible> = Vec::new();
    for other in everybody {
        if other.id == me.id {
            continue;
        }
        // Off the grid is nobody to hear, not a wall.
        let Some((row, col)) = grid.cell_containing(other.x, other.y) else {
            continue;
        };
        let steps = in_reach[row * grid.width() + col];
        if steps == u32::MAX {
            continue; // a wall or a shut door between us, whatever the distance says
        }
        let distance = if clear_path(grid, me, *other) {
            ((other.x - me.x).powi(2) + (other.y - me.y).powi(2)).sqrt()
        } else {
            steps as f32 * CELL_M
        };
        nearby.push(Audible { id: other.id, level: level_at(distance) });
    }
    // Loudest first, ties by id, so two clients never disagree about the order.
    nearby.sort_by(|a, b| {
        b.level
            .partial_cmp(&a.level)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });
    nearby
}

/// Everybody loud enough to be a stream: the answer to "who do I connect to". Quiet is a state a person carries,
/// not part of this rule.
pub fn audible(grid: &Grid, me: Person, everybody: &[Person]) -> Vec<Audible> {
    within(grid, me, everybody).into_iter().filter(|entry| entry.level > 0.0).collect()
}

/// Every cell reachable without crossing a wall or a shut door — the only hard rule. Returned as a flat grid of
/// flags indexed `row * width + col`, so a membership test is one lookup rather than a search per person.
fn area(grid: &Grid, me: Person) -> Vec<u32> {
    let width = grid.width();
    // Cell index to the number of steps it takes to get there: the way round, not the straight line.
    let mut steps = vec![u32::MAX; width * grid.height()];
    let Some(start) = grid.cell_containing(me.x, me.y) else {
        return steps;
    };
    if !grid.walkable(start.0, start.1) {
        return steps;
    }

    let mut queue = std::collections::VecDeque::from([start]);
    steps[start.0 * width + start.1] = 0;
    while let Some((row, col)) = queue.pop_front() {
        let here = steps[row * width + col];
        for (r, c) in grid.neighbours(row, col) {
            // Floor and open door carry sound on; a wall and a shut door are what cut one area from the next.
            if !grid.walkable(r, c) || steps[r * width + c] != u32::MAX {
                continue;
            }
            steps[r * width + c] = here + 1;
            queue.push_back((r, c));
        }
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    use office_mumble_wire::{Cell, PlanFile};

    const CELL: f32 = 0.5;

    /// The real floor, read at test time from the same model file the server loads.
    const FLOOR: &str = include_str!("../../../fixtures/floor-t1.json");

    /// The real floor the rule walks on, cut out of the model the way the server cuts it.
    fn real_floor() -> Grid {
        PlanFile::parse(FLOOR)
            .expect("fixture parses")
            .floor(0)
            .expect("the fixture has a floor")
            .cells
            .clone()
    }

    /// Two rooms of two cells with a wall between them — once with a wall, once with a door open, once shut.
    fn wall() -> Grid {
        rooms(Cell::Wall)
    }
    fn open() -> Grid {
        rooms(Cell::DoorOpen)
    }
    fn shut() -> Grid {
        rooms(Cell::DoorShut)
    }

    /// A 7x3 floor with two cells on either side of `middle` at column 3.
    fn rooms(middle: Cell) -> Grid {
        Grid::from_cells(vec![
            vec![Cell::Wall; 7],
            vec![Cell::Wall, Cell::Floor, Cell::Floor, middle, Cell::Floor, Cell::Floor, Cell::Wall],
            vec![Cell::Wall; 7],
        ])
        .expect("test plan parses")
    }

    /// A single straight piece of floor `len` cells long — the corridor the walking-away cases use.
    fn corridor(len: usize) -> Grid {
        Grid::from_cells(vec![vec![Cell::Floor; len]]).expect("corridor parses")
    }

    /// The centre of a cell: cell (col, row) sits at ((col + 0.5) · cellM, (row + 0.5) · cellM).
    fn at(col: i32, row: i32) -> (f32, f32) {
        ((col as f32 + 0.5) * CELL, (row as f32 + 0.5) * CELL)
    }

    fn person(id: u64, at: (f32, f32)) -> Person {
        Person { id, x: at.0, y: at.1 }
    }

    fn here() -> Person {
        person(1, at(1, 1))
    }
    fn there() -> Person {
        person(2, at(4, 1))
    }
    fn further() -> Person {
        person(3, at(5, 1))
    }

    #[test]
    fn is_full_volume_within_reach_of_a_word_and_nothing_at_the_maximum() {
        assert_eq!(level_at(0.0), 1.0);
        assert_eq!(level_at(CLEAR_M), 1.0);
        assert_eq!(level_at(EARSHOT_M), 0.0);
        assert_eq!(level_at(EARSHOT_M + 5.0), 0.0);
    }

    #[test]
    fn falls_off_as_the_distance_grows_without_a_step_at_either_end() {
        let half = level_at((CLEAR_M + EARSHOT_M) / 2.0);
        assert!(half > 0.0);
        assert!(half < 1.0);
        assert!(level_at(4.0) > level_at(6.0));
    }

    #[test]
    fn hears_nobody_through_a_wall_however_close_they_are() {
        assert_eq!(audible(&wall(), here(), &[here(), there()]), vec![]);
    }

    #[test]
    fn hears_somebody_through_an_open_door() {
        assert_eq!(audible(&open(), here(), &[here(), there()]), vec![Audible { id: 2, level: 1.0 }]);
    }

    #[test]
    fn hears_nobody_through_a_shut_door_and_the_room_it_shut_still_hears_itself() {
        assert_eq!(audible(&shut(), here(), &[here(), there()]), vec![]);
        assert_eq!(
            audible(&shut(), there(), &[here(), there(), further()]),
            vec![Audible { id: 3, level: 1.0 }]
        );
    }

    #[test]
    fn never_hears_itself() {
        assert_eq!(audible(&open(), here(), &[here()]), vec![]);
    }

    #[test]
    fn answers_the_same_question_the_same_way_from_either_side() {
        assert_eq!(audible(&open(), here(), &[here(), there()]), vec![Audible { id: 2, level: 1.0 }]);
        assert_eq!(audible(&open(), there(), &[here(), there()]), vec![Audible { id: 1, level: 1.0 }]);
    }

    #[test]
    fn puts_the_loudest_first() {
        let me = person(1, (0.25, 0.25));
        let heard = audible(
            &corridor(60),
            me,
            &[me, person(2, (5.25, 0.25)), person(3, (2.25, 0.25))],
        );
        let ids: Vec<u64> = heard.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, vec![3, 2]);
    }

    #[test]
    fn drops_somebody_out_of_earshot_as_they_walk_away_and_back_in_as_they_return() {
        let corridor = corridor(80);
        let me = person(1, (0.25, 0.25));
        let standing = |distance_m: f32| -> Vec<Person> {
            vec![me, Person { id: 2, x: 0.25 + distance_m, y: 0.25 }]
        };

        assert_eq!(audible(&corridor, me, &standing(CLEAR_M + 1.0)).len(), 1);
        assert_eq!(audible(&corridor, me, &standing(EARSHOT_M - 0.5)).len(), 1);
        assert_eq!(audible(&corridor, me, &standing(EARSHOT_M + 0.5)), vec![]);
        assert_eq!(audible(&corridor, me, &standing(CLEAR_M + 1.0)).len(), 1);
    }

    #[test]
    fn tells_walking_away_apart_from_a_door_being_shut() {
        let corridor = corridor(80);
        let me = person(1, (0.25, 0.25));
        let far = Person { id: 2, x: 0.25 + EARSHOT_M + 1.0, y: 0.25 };

        // Out of earshot down an open corridor: still in my area, so the rule reports them at level zero.
        assert_eq!(within(&corridor, me, &[me, far]), vec![Audible { id: 2, level: 0.0 }]);
        assert_eq!(audible(&corridor, me, &[me, far]), vec![]);

        // Behind a shut door: not in my area at all, and the rule says nothing about them.
        assert_eq!(within(&shut(), here(), &[here(), there()]), vec![]);
    }

    #[test]
    fn lets_a_wall_beat_a_short_distance_and_distance_beat_nothing() {
        let corridor = corridor(60);
        let me = person(1, (0.25, 0.25));
        let down_the_corridor = Person { id: 3, x: 0.25 + CLEAR_M * 3.0, y: 0.25 };

        // 1.5 m away on the other side of a wall: nothing. Nine metres down an open corridor: murmur.
        assert_eq!(audible(&wall(), here(), &[here(), there()]), vec![]);
        let heard = audible(&corridor, me, &[me, down_the_corridor]);
        assert_eq!(heard.len(), 1);
        assert!(heard[0].level > 0.0);
        assert!(heard[0].level < 1.0);
    }

    #[test]
    fn carries_sound_along_a_straight_piece_of_floor() {
        // Wherever two floor cells sit side by side: one area, half a metre apart.
        let floor = real_floor();
        let pair = (0..floor.height()).find_map(|row| {
            (0..floor.width() - 1)
                .find(|&col| floor.get(row, col) == Cell::Floor && floor.get(row, col + 1) == Cell::Floor)
                .map(|col| (col, row))
        });
        let (col, row) = pair.expect("a row has two floor cells side by side");

        let a = person(1, floor.center(row, col));
        let b = person(2, floor.center(row, col + 1));
        assert_eq!(audible(&floor, a, &[a, b]), vec![Audible { id: 2, level: 1.0 }]);
    }

    #[test]
    fn cuts_off_the_room_behind_every_shut_door_on_the_real_floor_in_both_directions() {
        // Every shut door the seed floor has, wherever the floor puts them: the rule on the real format,
        // without naming a cell of a floor that is laid out again from time to time.
        let floor = real_floor();
        for row in 0..floor.height() {
            for col in 0..floor.width() {
                if floor.get(row, col) != Cell::DoorShut {
                    continue;
                }
                // The two walkable cells a shut door stands between: one inside the room, one outside it.
                let sides: Vec<(usize, usize)> = [(col as i32 + 1, row as i32), (col as i32 - 1, row as i32), (col as i32, row as i32 + 1), (col as i32, row as i32 - 1)]
                    .iter()
                    .filter(|&&(c, r)| {
                        c >= 0 && r >= 0 && (c as usize) < floor.width() && (r as usize) < floor.height()
                            && floor.get(r as usize, c as usize).walkable()
                    })
                    .map(|&(c, r)| (c as usize, r as usize))
                    .collect();
                if sides.len() != 2 {
                    continue;
                }
                let a = person(1, floor.center(sides[0].1, sides[0].0));
                let b = person(2, floor.center(sides[1].1, sides[1].0));
                assert_eq!(audible(&floor, a, &[a, b]), vec![], "heard through the shut door at {row},{col}");
                assert_eq!(audible(&floor, b, &[a, b]), vec![], "heard through the shut door at {row},{col}");
            }
        }
    }

    #[test]
    fn operating_a_door_changes_the_rules_answer_at_once() {
        // Two cells and a door between them, as the model holds it — the same shape the editor builds.
        let text = r#"{"version":1,"cell_m":0.5,"floors":[{"name":"T","cells":[
          ["wall","wall","wall","wall","wall"],
          ["wall","floor","doorShut","floor","wall"],
          ["wall","wall","wall","wall","wall"]
        ]}]}"#;
        let mut floor = PlanFile::parse(text).expect("plan parses").floor(0).expect("a floor").clone();
        let me = person(1, at(1, 1));
        let you = person(2, at(3, 1));

        // Shut: the rule hears nothing across it, however close the two stand.
        assert_eq!(audible(&floor.cells, me, &[me, you]), vec![]);

        // Opening it is one operation on the model, and the very next question gets the new answer.
        floor.toggle_door(1, 2).unwrap();
        assert_eq!(audible(&floor.cells, me, &[me, you]), vec![Audible { id: 2, level: 1.0 }]);

        // Shutting it again cuts them off just as immediately.
        floor.toggle_door(1, 2).unwrap();
        assert_eq!(audible(&floor.cells, me, &[me, you]), vec![]);
    }

    /// The cases this rule and `client/src/hearing.ts` both answer, so the two cannot drift unnoticed.
    #[derive(serde::Deserialize)]
    struct SharedCases {
        levels: Vec<(f32, f32)>,
        grids: std::collections::HashMap<String, Grid>,
        cases: Vec<SharedCase>,
    }

    #[derive(serde::Deserialize)]
    struct SharedCase {
        says: String,
        grid: String,
        me: Spot,
        everybody: Vec<Spot>,
        within: Vec<Heard>,
    }

    #[derive(serde::Deserialize, Clone, Copy)]
    struct Spot {
        id: u64,
        x: f32,
        y: f32,
    }

    #[derive(serde::Deserialize)]
    struct Heard {
        id: u64,
        level: f32,
    }

    #[test]
    fn answers_every_shared_case_the_way_the_client_does() {
        let shared: SharedCases =
            serde_json::from_str(include_str!("../../../fixtures/hearing-cases.json")).expect("the cases parse");
        let close = |a: f32, b: f32| (a - b).abs() < 1e-5;

        for (distance, level) in shared.levels {
            assert!(close(level_at(distance), level), "at {distance} m: {} is not {level}", level_at(distance));
        }
        for case in shared.cases {
            let grid = &shared.grids[&case.grid];
            let person = |spot: Spot| Person { id: spot.id, x: spot.x, y: spot.y };
            let everybody: Vec<Person> = case.everybody.iter().copied().map(person).collect();
            let got = within(grid, person(case.me), &everybody);

            let ids: Vec<u64> = got.iter().map(|heard| heard.id).collect();
            let expected: Vec<u64> = case.within.iter().map(|heard| heard.id).collect();
            assert_eq!(ids, expected, "{}", case.says);
            for (heard, wanted) in got.iter().zip(&case.within) {
                assert!(close(heard.level, wanted.level), "{}: {} is not {}", case.says, heard.level, wanted.level);
            }
        }
    }
}
