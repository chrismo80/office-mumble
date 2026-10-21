//! Who may reach whom: the area the server checks before it hands a signal on, and the one place where the
//! ceiling is not a wall.

use office_mumble_hearing::{within, Person as Ears};

use super::{grid_of, World};
use crate::person::Person;

impl World {
    /// Nothing but floor and open doors between two people. Distance is left to the listener's rule on purpose:
    /// walking never leaves an area, so this answer cannot flicker at the edge of earshot between two ticks.
    /// A door changes the area, but working one is deliberate, and clients cut at once.
    pub(crate) fn same_area(&self, a: u64, b: u64) -> bool {
        let find = |id: u64| self.people.iter().find(|p| p.id == id);
        let (Some(a), Some(b)) = (find(a), find(b)) else {
            return false;
        };
        // The ceiling is a wall — except on the stair, where it is not: somebody standing on the flight can
        // hear both floors, and that is what lets a voice be opened before the last tread is reached.
        if a.floor != b.floor {
            return self.on_stairs(a) || self.on_stairs(b);
        }
        let a = Ears { id: a.id, x: a.x, y: a.y };
        let b = Ears { id: b.id, x: b.x, y: b.y };
        within(grid_of(&self.model, self.floor_of(a.id)), a, &[b]).iter().any(|heard| heard.id == b.id)
    }

    /// Whether somebody's feet are on a stair of their own floor: the one place two floors meet.
    fn on_stairs(&self, person: &Person) -> bool {
        let Some(floor) = self.model.floors.get(person.floor) else {
            return false;
        };
        let grid = grid_of(&self.model, person.floor);
        let Some((row, col)) = grid.cell_containing(person.x, person.y) else {
            return false;
        };
        // Not the tread you step off at: there you are already upstairs, and the ceiling is a wall again.
        floor.stairs.iter().any(|stair| stair.covers(row, col) && !stair.is_exit(row, col))
    }
}
