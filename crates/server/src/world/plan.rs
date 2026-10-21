//! The plan itself: an edit, a whole replacement, and the two things both of them must do afterwards —
//! never leave anybody inside a wall, and never leave a walk pointing into one.

use office_mumble_wire::{Edit, PlanFile, CELL_M};

use super::{grid_of, walk_grid, World};

impl World {
    /// The plan to disk, atomically: written beside the file and moved over it, so a reader never sees half
    /// a building. A failed write is reported and swallowed — the plan still lives in memory, and losing one
    /// edit to a full disk is better than taking the floor down.
    fn save(&self) {
        let Some(path) = &self.save_path else {
            return;
        };
        let text = match serde_json::to_string_pretty(&self.model) {
            Ok(text) => text,
            Err(reason) => {
                println!("cannot write {}: {reason}", path.display());
                return;
            }
        };
        let beside = path.with_extension("json.tmp");
        if let Err(reason) = std::fs::write(&beside, text).and_then(|()| std::fs::rename(&beside, path)) {
            println!("cannot write {}: {reason}", path.display());
        }
    }

    /// Apply an edit, or refuse it with a reason. The first editor takes the lock; a second is refused while it
    /// is held. The lock is taken only once the edit has landed — a refused attempt must not hold the building.
    /// Put a whole plan in place of the one being served. The same lock an edit needs, because it is the same
    /// act at a larger scale — and the same rule about people: nobody is left standing on a floor that is
    /// gone, or on a cell that is not floor any more.
    pub(super) fn replace_plan(&mut self, id: u64, plan: PlanFile) -> Result<(), String> {
        if let Some(holder) = self.lock {
            if holder != id {
                let who = self.name_of(holder).unwrap_or_else(|| format!("somebody ({holder})"));
                return Err(format!("{who} is editing the building"));
            }
        }
        plan.check()?;
        self.model = plan;
        self.save();
        let (arrival_floor, (x, y)) = self.arrival();
        for person in &mut self.people {
            if person.floor >= self.model.floors.len() {
                person.floor = arrival_floor;
                person.path.clear();
                (person.x, person.y) = (x, y);
            }
        }
        for floor in 0..self.model.floors.len() {
            self.keep_routes_on_walkable_ground(floor);
        }
        Ok(())
    }

    pub(super) fn apply_edit(&mut self, id: u64, floor: usize, edit: Edit) -> (bool, Result<(), String>) {
        if let Some(holder) = self.lock {
            if holder != id {
                // Refused rather than repaired, and the reason names the holder: that is all the second
                // editor needs to know.
                let who = self.name_of(holder).unwrap_or_else(|| format!("somebody ({holder})"));
                return (false, Err(format!("{who} is editing the building")));
            }
        }
        let took_the_lock = self.lock.is_none();
        match self.change_model(edit.moved_by(), floor, |model| edit.apply(model.floor_mut(floor)?)) {
            Ok(()) => {
                if took_the_lock {
                    self.lock = Some(id);
                }
                (took_the_lock, Ok(()))
            }
            Err(reason) => (false, Err(reason)),
        }
    }

    /// Change a copy of the model and keep it only if the whole model still holds: a change that would make the
    /// plan not a plan changes nothing. `moved_by` is how far the floor's contents moved, so people move with it.
    pub(super) fn change_model(
        &mut self,
        moved_by: (i64, i64),
        floor: usize,
        change: impl FnOnce(&mut PlanFile) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut model = self.model.clone();
        change(&mut model)?;
        model.move_arrival(floor, moved_by);
        model.check()?;
        self.model = model;
        self.save();
        let (dy, dx) = (moved_by.0 as f32 * CELL_M, moved_by.1 as f32 * CELL_M);
        for person in &mut self.people {
            if person.floor != floor {
                continue;
            }
            (person.x, person.y) = (person.x + dx, person.y + dy);
            for waypoint in &mut person.path {
                *waypoint = (waypoint.0 + dx, waypoint.1 + dy);
            }
        }
        self.carry_the_walled_in(floor);
        self.keep_routes_on_walkable_ground(floor);
        Ok(())
    }

    /// A plan changed under people: whoever stands on a cell that is no longer walkable is moved to the
    /// nearest walkable one — the same rule a click with no way uses, so there is one rule and not two.
    fn carry_the_walled_in(&mut self, floor: usize) {
        let grid = grid_of(&self.model, floor);
        for person in &mut self.people {
            if person.floor != floor {
                continue;
            }
            // Off the grid counts as walled in: a floor cut down under somebody leaves them on nothing, and
            // `cell_at` would clamp them onto an edge cell that may well be floor.
            let on_floor = grid.cell_containing(person.x, person.y).is_some_and(|(row, col)| grid.walkable(row, col));
            if on_floor {
                continue;
            }
            if let Some((r, c)) = grid.nearest_walkable(person.x, person.y) {
                (person.x, person.y) = grid.center(r, c);
                person.path.clear();
            }
        }
    }

    /// A new plan can block a walker's remaining route while leaving them on good ground, and `Person::step`
    /// follows blindly: a route with waypoints that no longer exist is recomputed or let go of.
    fn keep_routes_on_walkable_ground(&mut self, floor: usize) {
        let grid = walk_grid(&self.model, floor);
        let on_floor = |&(x, y): &(f32, f32)| {
            let (row, col) = grid.cell_at(x, y);
            grid.walkable(row, col)
        };
        for person in &mut self.people {
            if person.floor != floor || person.path.iter().all(on_floor) {
                continue;
            }
            let destination = *person.path.last().expect("a blocked route has a waypoint");
            // Where they were going still exists: keep going, along a way that exists now. Where it does
            // not, the route is let go of and they stand — a place that is gone is not somewhere to walk to.
            person.path = if on_floor(&destination) {
                grid.path((person.x, person.y), destination).unwrap_or_default()
            } else {
                Vec::new()
            };
        }
    }
}
