//! The cells of one floor, and the questions the rules ask of them: what may be walked, what stops
//! sound, which cell a point is in, and the way from one point to another.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeSet, VecDeque};

use crate::CELL_M;

/// One cell: what may be walked and what stops sound. Spelled on the wire as a person reads it in a diff —
/// `doorShut`, not `4` — and refused by name when unknown.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "&'static str")]
pub enum Cell {
    Void,
    Floor,
    DoorOpen,
    DoorShut,
    Wall,
    /// A wall with glass in it: it keeps you out and damps a voice, but it lets the day in.
    Window,
}

impl Cell {
    /// The one place a code is spelled. The wire, the error messages and the client all use these.
    pub fn code(self) -> &'static str {
        match self {
            Cell::Void => "void",
            Cell::Floor => "floor",
            Cell::DoorOpen => "doorOpen",
            Cell::DoorShut => "doorShut",
            Cell::Wall => "wall",
            Cell::Window => "window",
        }
    }

    pub fn from_code(code: &str) -> Result<Cell, String> {
        [Cell::Void, Cell::Floor, Cell::DoorOpen, Cell::DoorShut, Cell::Wall, Cell::Window]
            .into_iter()
            .find(|cell| cell.code() == code)
            .ok_or_else(|| format!("unknown cell {code:?}"))
    }

    /// A shut door is as impassable as a wall until the handle turns it into an open one.
    pub fn walkable(self) -> bool {
        matches!(self, Cell::Floor | Cell::DoorOpen)
    }

    /// Walls and shut doors are what cut a floor into areas that cannot hear each other. Glass is a wall
    /// that has been made thin: it still keeps a voice on its own side, only less bluntly.
    pub fn blocks_sound(self) -> bool {
        matches!(self, Cell::Wall | Cell::DoorShut | Cell::Window)
    }

    /// The same door, the other way round — or `None` for a cell that is not a door.
    pub fn toggled(self) -> Option<Cell> {
        match self {
            Cell::DoorOpen => Some(Cell::DoorShut),
            Cell::DoorShut => Some(Cell::DoorOpen),
            _ => None,
        }
    }
}

impl TryFrom<String> for Cell {
    type Error = String;

    fn try_from(code: String) -> Result<Cell, String> {
        Cell::from_code(&code)
    }
}

impl From<Cell> for &'static str {
    fn from(cell: Cell) -> &'static str {
        cell.code()
    }
}

/// A floor's cells: a rectangle, made of cells that exist, with somewhere to stand. Checked when it is
/// built and when it is read, so nothing holds a grid two clients would disagree about.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Grid {
    cells: Vec<Vec<Cell>>,
    /// Steps between two neighbouring cells that nobody takes, though both can be stood on: the sides of a
    /// stair. Only a walk asks; sound passes. Not part of the plan: the walk grid is built from it (`fence`).
    fences: BTreeSet<((usize, usize), (usize, usize))>,
}

impl Grid {
    /// The one place a grid is checked, whatever it was read from.
    pub fn from_cells(cells: Vec<Vec<Cell>>) -> Result<Grid, String> {
        let grid = Grid { cells, fences: BTreeSet::new() };
        grid.check()?;
        Ok(grid)
    }

/// Everything that has to hold for a grid to be a floor. Asked again after every edit, because an edit can take
/// the last floor away.
    pub fn check(&self) -> Result<(), String> {
        let Some(first) = self.cells.first() else {
            return Err("plan has no rows".into());
        };
        let width = first.len();
        if width == 0 {
            return Err("plan rows are empty".into());
        }
        if let Some(bad) = self.cells.iter().position(|row| row.len() != width) {
            return Err(format!("row {bad} is {} wide, row 0 is {width}", self.cells[bad].len()));
        }
        if !self.cells.iter().flatten().any(|cell| cell.walkable()) {
            return Err("plan has no floor to stand on".into());
        }
        Ok(())
    }

    pub fn height(&self) -> usize {
        self.cells.len()
    }

    pub fn width(&self) -> usize {
        self.cells[0].len()
    }

    pub fn contains(&self, row: usize, col: usize) -> bool {
        row < self.height() && col < self.width()
    }

    pub fn get(&self, row: usize, col: usize) -> Cell {
        self.cells[row][col]
    }

    /// Write one cell. The caller checks the cell is on the grid; whether the grid is still a floor
    /// afterwards is `check`'s question.
    pub fn set(&mut self, row: usize, col: usize, cell: Cell) {
        self.cells[row][col] = cell;
    }

/// The same cells in a rectangle of another size: `row + top`, `col + left`, what falls outside is cut off and
/// what is new is void. Whether the result is still a floor is `check`'s question.
    pub fn resized(&self, top: i64, left: i64, height: usize, width: usize) -> Grid {
        let cells = (0..height)
            .map(|row| {
                (0..width)
                    .map(|col| {
                        let (from_row, from_col) = (row as i64 - top, col as i64 - left);
                        if from_row < 0 || from_col < 0 {
                            return Cell::Void;
                        }
                        let (from_row, from_col) = (from_row as usize, from_col as usize);
                        if self.contains(from_row, from_col) { self.get(from_row, from_col) } else { Cell::Void }
                    })
                    .collect()
            })
            .collect();
        Grid { cells, fences: BTreeSet::new() }
    }

    pub fn walkable(&self, row: usize, col: usize) -> bool {
        self.get(row, col).walkable()
    }

    /// Close the step between two neighbouring cells to a walk, in both directions. Sound still passes.
    pub fn fence(&mut self, a: (usize, usize), b: (usize, usize)) {
        self.fences.insert((a.min(b), a.max(b)));
    }

    fn fenced(&self, a: (usize, usize), b: (usize, usize)) -> bool {
        self.fences.contains(&(a.min(b), a.max(b)))
    }

    /// The up to four cells next to one, without leaving the grid. In a fixed order, so every search
    /// over the grid visits cells the same way on every machine.
    pub fn neighbours(&self, row: usize, col: usize) -> impl Iterator<Item = (usize, usize)> + '_ {
        [(-1isize, 0isize), (1, 0), (0, -1), (0, 1)].into_iter().filter_map(move |(dr, dc)| {
            let r = row.checked_add_signed(dr)?;
            let c = col.checked_add_signed(dc)?;
            self.contains(r, c).then_some((r, c))
        })
    }

    /// Middle of a cell, in metres from the top-left corner of the plan.
    pub fn center(&self, row: usize, col: usize) -> (f32, f32) {
        ((col as f32 + 0.5) * CELL_M, (row as f32 + 0.5) * CELL_M)
    }

    /// Which cell a point is in. Points outside the plan resolve to the nearest edge cell, so a click
    /// past the outer wall still means something instead of nothing.
    pub fn cell_at(&self, x: f32, y: f32) -> (usize, usize) {
        let col = (x / CELL_M).floor().clamp(0.0, (self.width() - 1) as f32) as usize;
        let row = (y / CELL_M).floor().clamp(0.0, (self.height() - 1) as f32) as usize;
        (row, col)
    }

    /// Which cell a point is in, or `None` off the grid. Off the grid is nobody to hear, not a wall.
    pub fn cell_containing(&self, x: f32, y: f32) -> Option<(usize, usize)> {
        let (col, row) = ((x / CELL_M).floor(), (y / CELL_M).floor());
        if col < 0.0 || row < 0.0 {
            return None;
        }
        let (row, col) = (row as usize, col as usize);
        self.contains(row, col).then_some((row, col))
    }

/// The cell a click means: under the point, or the nearest walkable one. Ties by row then column, so two clients
/// never disagree about where somebody is heading.
    pub fn nearest_walkable(&self, x: f32, y: f32) -> Option<(usize, usize)> {
        let (row, col) = self.cell_at(x, y);
        if self.walkable(row, col) {
            return Some((row, col));
        }
        let mut best: Option<(f32, usize, usize)> = None;
        for r in 0..self.height() {
            for c in 0..self.width() {
                if !self.walkable(r, c) {
                    continue;
                }
                let (cx, cy) = self.center(r, c);
                let d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
                if best.is_none_or(|b| (d, r, c) < b) {
                    best = Some((d, r, c));
                }
            }
        }
        best.map(|(_, r, c)| (r, c))
    }

    /// A way from one point to another along walkable cells and across no fence, as cell centres. `None`
    /// when there is no way — a shut door is enough to make one.
    pub fn path(&self, from: (f32, f32), to: (f32, f32)) -> Option<Vec<(f32, f32)>> {
        let start = self.nearest_walkable(from.0, from.1)?;
        let goal = self.nearest_walkable(to.0, to.1)?;
        let width = self.width();
        let index = |(row, col): (usize, usize)| row * width + col;

        let mut previous: Vec<Option<(usize, usize)>> = vec![None; width * self.height()];
        let mut seen = vec![false; width * self.height()];
        let mut queue = VecDeque::from([start]);
        seen[index(start)] = true;
        while let Some(cell) = queue.pop_front() {
            if cell == goal {
                break;
            }
            for next in self.neighbours(cell.0, cell.1) {
                if !self.walkable(next.0, next.1) || seen[index(next)] || self.fenced(cell, next) {
                    continue;
                }
                seen[index(next)] = true;
                previous[index(next)] = Some(cell);
                queue.push_back(next);
            }
        }
        if !seen[index(goal)] {
            return None;
        }

        let mut route = Vec::new();
        let mut cell = goal;
        while cell != start {
            route.push(self.center(cell.0, cell.1));
            cell = previous[index(cell)]?;
        }
        route.reverse();
        Some(route)
    }

    /// Where somebody arrives who has no place of their own yet: the first walkable cell, which is
    /// deterministic and therefore the same on every machine.
    pub fn spawn_point(&self) -> (f32, f32) {
        for r in 0..self.height() {
            for c in 0..self.width() {
                if self.walkable(r, c) {
                    return self.center(r, c);
                }
            }
        }
        (CELL_M, CELL_M)
    }
}

/// On the wire a grid is its rows of cell codes, nothing more.
impl Serialize for Grid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.cells.serialize(serializer)
    }
}

/// Read and checked in one step: a grid that is not a floor is refused where it is read.
impl<'de> Deserialize<'de> for Grid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Grid, D::Error> {
        let cells = Vec::<Vec<Cell>>::deserialize(deserializer)?;
        Grid::from_cells(cells).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlanFile;

/// The seed floor, cut down to what the rule walks on. The tests ask only what the contract stands on — somewhere
/// to arrive, most of it one place, every place reachable — and never name a cell, so the floor can be laid out
/// again without a test to rewrite.
    fn seed() -> PlanFile {
        PlanFile::parse(include_str!("../../../fixtures/floor-t1.json")).expect("the seed floor parses")
    }

    fn fixture() -> Grid {
        seed().floor(0).expect("the seed has a floor").cells.clone()
    }

    /// Every cell that can be walked to from `from` with the doors as they are.
    fn reach(plan: &Grid, from: (usize, usize)) -> std::collections::HashSet<(usize, usize)> {
        let mut seen = std::collections::HashSet::from([from]);
        let mut queue = VecDeque::from([from]);
        while let Some((r, c)) = queue.pop_front() {
            let next = [(r + 1, c), (r.wrapping_sub(1), c), (r, c + 1), (r, c.wrapping_sub(1))];
            for (nr, nc) in next {
                if plan.contains(nr, nc) && plan.walkable(nr, nc) && seen.insert((nr, nc)) {
                    queue.push_back((nr, nc));
                }
            }
        }
        seen
    }

    /// Where people arrive on the ground floor: the seed's arrival, or the first walkable cell without one.
    fn arrival(plan: &Grid) -> (usize, usize) {
        match seed().arrival.filter(|arrival| arrival.floor == 0) {
            Some(arrival) => (arrival.row, arrival.col),
            None => {
                let (x, y) = plan.spawn_point();
                plan.cell_at(x, y)
            }
        }
    }

    /// Two rooms of two cells with a door between them, built the way the model builds one.
    fn corridor_plan(door: Cell) -> Grid {
        Grid::from_cells(vec![
            vec![Cell::Wall; 5],
            vec![Cell::Wall, Cell::Floor, Cell::Wall, Cell::Floor, Cell::Wall],
            vec![Cell::Wall, Cell::Floor, door, Cell::Floor, Cell::Wall],
            vec![Cell::Wall, Cell::Floor, Cell::Wall, Cell::Floor, Cell::Wall],
            vec![Cell::Wall; 5],
        ])
        .expect("test corridor parses")
    }

    /// A room with a corridor down its west side and a closet behind a door off it:
    ///
    /// ```text
    ///   #######
    ///   #.....#
    ///   #.##D##     D is `door`, at row 2, column 4
    ///   #.#...#     the closet: row 3, columns 3 to 5
    ///   #######
    /// ```
    fn closet_plan(door: Cell) -> Grid {
        use Cell::{Floor as F, Wall as W};
        Grid::from_cells(vec![
            vec![W; 7],
            vec![W, F, F, F, F, F, W],
            vec![W, F, W, W, door, W, W],
            vec![W, F, W, F, F, F, W],
            vec![W; 7],
        ])
        .expect("test closet parses")
    }

    #[test]
    fn the_seed_floor_has_somewhere_to_arrive() {
        let plan = fixture();
        let (r, c) = arrival(&plan);
        assert!(plan.walkable(r, c), "people must arrive on a cell they can stand on");
    }

    #[test]
    fn most_of_the_seed_floor_is_one_place_to_walk() {
        // The contract's own sentence: a floor is not split into smaller rooms. Most of it — three quarters —
        // is reachable from where people arrive without opening a door.
        let plan = fixture();
        let inside = (0..plan.height())
            .flat_map(|r| (0..plan.width()).map(move |c| (r, c)))
            .filter(|&(r, c)| !matches!(plan.get(r, c), Cell::Wall | Cell::Void | Cell::Window))
            .count();
        let reached = reach(&plan, arrival(&plan)).len();
        assert!(reached * 4 >= inside * 3, "only {reached} of {inside} cells are one place");
    }

    #[test]
    fn every_named_place_on_the_seed_floor_can_be_reached_once_its_doors_are_open() {
        let mut file = seed();
        let floor = file.floor_mut(0).expect("the seed has a floor");
        let shut: Vec<(usize, usize)> = (0..floor.cells.height())
            .flat_map(|r| (0..floor.cells.width()).map(move |c| (r, c)))
            .filter(|&(r, c)| floor.cells.get(r, c) == Cell::DoorShut)
            .collect();
        for (r, c) in shut {
            floor.toggle_door(r, c).expect("a shut door opens");
        }
        let reached = reach(&floor.cells, arrival(&floor.cells));
        for label in &floor.labels {
            assert!(
                reached.contains(&(label.row, label.col)),
                "nobody can get to {} at row {}, column {}",
                label.text,
                label.row,
                label.col
            );
        }
    }

    #[test]
    fn the_seed_floor_has_an_open_door_that_would_cut_it_in_two() {
        // What `verify` stands two colleagues either side of and shuts over the wire.
        let file = seed();
        let floor = file.floor(0).expect("the seed has a floor");
        let plan = &floor.cells;
        let cuts = (0..plan.height()).flat_map(|r| (0..plan.width()).map(move |c| (r, c))).any(|(r, c)| {
            if plan.get(r, c) != Cell::DoorOpen || r == 0 || c == 0 {
                return false;
            }
            let sides = if plan.walkable(r - 1, c) && plan.contains(r + 1, c) && plan.walkable(r + 1, c) {
                [(r - 1, c), (r + 1, c)]
            } else if plan.walkable(r, c - 1) && plan.contains(r, c + 1) && plan.walkable(r, c + 1) {
                [(r, c - 1), (r, c + 1)]
            } else {
                return false;
            };
            let mut shut = floor.clone();
            shut.toggle_door(r, c).expect("an open door shuts");
            !reach(&shut.cells, sides[0]).contains(&sides[1])
        });
        assert!(cuts, "no open door on the seed floor separates two places when it is shut");
    }

    #[test]
    fn an_unknown_cell_code_is_refused_instead_of_guessed() {
        assert!(Cell::from_code("garden").is_err());
        // A row shorter than the first is refused rather than padded: the grid is a rectangle or it is wrong.
        let ragged = vec![vec![Cell::Floor; 3], vec![Cell::Floor; 2]];
        assert!(Grid::from_cells(ragged).unwrap_err().contains("row 1"));
    }

    #[test]
    fn a_plan_that_cannot_be_stood_in_is_refused_rather_than_started() {
        // Nothing at all, and a grid that is only walls and void: both describe something the server could
        // run on and nobody could walk in.
        assert!(Grid::from_cells(vec![]).is_err());
        assert!(Grid::from_cells(vec![vec![]]).is_err());
        assert!(Grid::from_cells(vec![vec![Cell::Wall; 3]; 2]).unwrap_err().contains("no floor"));
        assert!(Grid::from_cells(vec![vec![Cell::Void; 3]; 2]).unwrap_err().contains("no floor"));
        // A row of void is a row of the grid, not spacing: the grid stays a rectangle.
        let with_void = Grid::from_cells(vec![
            vec![Cell::Wall; 3],
            vec![Cell::Wall, Cell::Floor, Cell::Wall],
            vec![Cell::Wall; 3],
            vec![Cell::Void; 3],
        ])
        .expect("void rows are allowed");
        assert_eq!(with_void.height(), 4);
        assert_eq!(with_void.get(3, 1), Cell::Void);
    }

    #[test]
    fn a_click_between_cells_resolves_the_same_way_twice() {
        // A point on the wall between the corridor and the closet, on the edge between two of its cells.
        let plan = closet_plan(Cell::DoorShut);
        let x = 1.0; // the edge of columns 1 and 2
        let y = 1.25; // row 2
        assert!(!plan.walkable(2, 2), "the point is on a wall, not on the floor");
        let first = plan.nearest_walkable(x, y).expect("there is floor somewhere");
        let second = plan.nearest_walkable(x, y).expect("there is floor somewhere");
        assert_eq!(first, second);
        assert!(plan.walkable(first.0, first.1));
    }

    #[test]
    fn a_shut_door_is_what_makes_a_way_impossible() {
        // Left of the door, and the floor on the other side of it: 0.75 m is column 1, 1.75 m is column 3.
        let start = (0.75, 1.25);
        let goal = (1.75, 1.25);

        let shut = corridor_plan(Cell::DoorShut);
        assert!(shut.walkable(2, 1) && shut.walkable(2, 3), "both sides are floor");
        assert!(shut.path(start, goal).is_none(), "a shut door is not a way through");

        let open = corridor_plan(Cell::DoorOpen);
        let route = open.path(start, goal).expect("an open door is a way through");
        assert!(route.iter().all(|&(x, y)| {
            let (r, c) = open.cell_at(x, y);
            open.walkable(r, c)
        }));
    }

    #[test]
    fn a_way_stays_inside_the_floor_and_ends_where_it_was_sent() {
        // From the far end of the room round the corner and down the corridor.
        let plan = closet_plan(Cell::DoorShut);
        let to = plan.center(3, 1);
        let route = plan.path(plan.center(1, 5), to).expect("the room reaches the end of the corridor");
        assert!(!route.is_empty());
        for (x, y) in &route {
            let (r, c) = plan.cell_at(*x, *y);
            assert!(plan.walkable(r, c), "waypoint {x},{y} is not on the floor");
        }
        assert_eq!(*route.last().unwrap(), to);
    }

    #[test]
    fn somebody_with_no_way_walks_to_the_nearest_floor_instead_of_into_a_wall() {
        // Clicking into the closet behind the shut door resolves to its floor, and there is no way in.
        let inside = (3, 4);
        let shut = closet_plan(Cell::DoorShut);
        assert!(shut.walkable(inside.0, inside.1));
        assert!(shut.path(shut.center(1, 1), shut.center(inside.0, inside.1)).is_none());
        // Open the door and the same click is a way.
        let open = closet_plan(Cell::DoorOpen);
        assert!(open.path(open.center(1, 1), open.center(inside.0, inside.1)).is_some());
    }
}
