//! Where people go: a path over walkable cells, the tick that walks it, and the stair — the one place where
//! arriving changes the floor under your feet.

use office_mumble_wire::{furniture, CELL_M};

use super::{grid_of, walk_grid, World, HAUNTS};

impl World {
    /// The cells beside the things worth walking to, per floor: the coffee, the fridge, a table, the sofa.
    /// Beside them, because a body cannot stand on a table — and taken from the walking grid, so a chair
    /// beside a desk is a place and the desk itself is not.
    pub fn haunts(&self) -> Vec<(usize, (f32, f32))> {
        let mut places = Vec::new();
        for (at, floor) in self.model.floors.iter().enumerate() {
            let grid = walk_grid(&self.model, at);
            for object in &floor.objects {
                if !HAUNTS.contains(&object.kind.as_str()) {
                    continue;
                }
                let (rows, cols) = furniture::footprint(&object.kind, object.facing);
                let top = object.row.saturating_sub(1);
                let left = object.col.saturating_sub(1);
                for row in top..=(object.row + rows).min(grid.height() - 1) {
                    for col in left..=(object.col + cols).min(grid.width() - 1) {
                        if grid.walkable(row, col) {
                            places.push((at, grid.center(row, col)));
                        }
                    }
                }
            }
        }
        places
    }

    /// Whether a body could walk from one point to another on a floor, over the furniture as it stands.
    /// The tread a stair leaves this floor at: walking onto it is what carries you to the next floor.
    pub fn stair_exit(&self, floor: usize) -> Option<(f32, f32)> {
        let stair = self.model.floors.get(floor)?.stairs.iter().find(|stair| stair.to != floor)?;
        let (row, col) = stair.exit_cell();
        Some(walk_grid(&self.model, floor).center(row, col))
    }

    /// The round the demo figures walk: every room the plan names, floor by floor, with the stair between
    /// them. The stair's own stop is the tread the climb ends at, because stepping on it is what takes you up
    /// — no teleport, the same rule as for a person at a keyboard.
    pub fn route(&self) -> Vec<(usize, (f32, f32))> {
        let mut stops = Vec::new();
        for (index, floor) in self.model.floors.iter().enumerate() {
            let grid = walk_grid(&self.model, index);
            let mut rooms: Vec<_> = floor.labels.iter().collect();
            rooms.sort_by_key(|label| (label.row, label.col));
            for label in rooms {
                let at = (
                    label.col as f32 * CELL_M + CELL_M / 2.0,
                    label.row as f32 * CELL_M + CELL_M / 2.0,
                );
                if let Some((row, col)) = grid.nearest_walkable(at.0, at.1) {
                    // A label standing on the flight is no place to stop: the tread changes the floor.
                    if !floor.stairs.iter().any(|stair| stair.covers(row, col)) {
                        stops.push((index, grid.center(row, col)));
                    }
                }
            }
            // No stop on the flight itself: the tread you leave by changes the floor the moment you step on
            // it, so a figure sent there never arrives — it is turned round and walks back down, for ever.
            // Crossing floors is the wanderer's own business (`stair_exit`), not a place on the round.
        }
        stops
    }

    /// A metre short of a point, on the side I am coming from: standing in the same cell as somebody is not
    /// arriving, it is colliding.
    pub fn can_walk(&self, floor: usize, from: (f32, f32), to: (f32, f32)) -> bool {
        walk_grid(&self.model, floor).path(from, to).is_some()
    }

    pub fn step(&mut self, dt_s: f32) {
        for person in &mut self.people {
            person.step(dt_s);
        }
        self.stairs_underfoot();
    }

    /// A stair changes the floor when somebody's feet are on it. That is the whole act: a click across the
    /// room walks, and arriving at the stair is what takes you up — there is no teleport and no second
    /// message. `on_stair` keeps somebody standing on the stair they arrived by from going back and forth
    /// on every tick; stepping off clears it.
    fn stairs_underfoot(&mut self) {
        for person in &mut self.people {
            let step = self.model.floors.get(person.floor).and_then(|floor| {
                grid_of(&self.model, person.floor)
                    .cell_containing(person.x, person.y)
                    .and_then(|(row, col)| {
                        floor
                            .stairs
                            .iter()
                            .find(|stair| stair.is_exit(row, col))
                            .map(|stair| (*stair, row, col))
                    })
            });
            match step {
                Some((stair, row, col)) if !person.on_stair => {
                    if let Some(target) = self.model.floors.get(stair.to) {
                        person.floor = stair.to;
                        (person.x, person.y) = target.cells.center(row, col);
                        person.path.clear();
                        person.on_stair = true;
                    }
                }
                Some(_) => {}
                None => person.on_stair = false,
            }
        }
    }

    /// Sends somebody toward a point. Answered only when there is a way: a shut door is allowed to mean
    /// "you cannot get there", which is a fact about the floor rather than an error.
    pub(super) fn walk(&mut self, id: u64, x: f32, y: f32) -> bool {
        let Some(floor) = self.people.iter().find(|p| p.id == id).map(|p| p.floor) else {
            return false;
        };
        let grid = walk_grid(&self.model, floor);
        let Some(person) = self.people.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        match grid.path((person.x, person.y), (x, y)) {
            Some(path) => {
                let stood_on = grid.cell_containing(person.x, person.y);
                person.walk_to(path);
                // Asking for the cell you are already standing on is how you leave a stair you arrived by:
                // the click lifts the arrival guard and the next tick takes you back.
                if grid.cell_containing(x, y) == stood_on {
                    person.on_stair = false;
                }
                true
            }
            None => false,
        }
    }

    /// Take the stairs at a cell: the person arrives on the floor the stair leads to, on the same cell there.
    /// The stair is the plan's, so the way up and the way down are the same fact.
    pub(super) fn take_stairs(&mut self, id: u64, row: usize, col: usize) -> Result<(), String> {
        let Some(person) = self.people.iter().find(|p| p.id == id) else {
            return Err("you are not on the floor".into());
        };
        let from = person.floor;
        let stair = self
            .model
            .floors
            .get(from)
            .and_then(|floor| floor.stairs.iter().find(|s| s.covers(row, col)).copied())
            .ok_or_else(|| format!("there is no stair at {row}, {col}"))?;
        let target = self
            .model
            .floors
            .get(stair.to)
            .ok_or_else(|| format!("the stair leads to floor {}, which is not there", stair.to))?;
        let (x, y) = target.cells.center(row, col);
        let person = self.people.iter_mut().find(|p| p.id == id).expect("found just above");
        person.floor = stair.to;
        person.x = x;
        person.y = y;
        person.path.clear();
        person.on_stair = true;
        Ok(())
    }
}
