//! A door is not a lock: anybody close enough may swing it, and the plan goes out whole so that every
//! listener's rule changes at the same moment.

use super::{World, DOOR_REACH};

impl World {
    pub fn a_metre_before(&self, me: u64, at: (f32, f32)) -> (f32, f32) {
        let Some((x, y, _)) = self.place(me) else { return at };
        let (dx, dy) = (x - at.0, y - at.1);
        let distance = dx.hypot(dy);
        let (tx, ty) = if distance < 0.001 {
            (at.0, at.1 + 1.0)
        } else {
            (at.0 + dx / distance, at.1 + dy / distance)
        };
        let floor = self.floor_of(me);
        if self.can_walk(floor, (x, y), (tx, ty)) {
            (tx, ty)
        } else {
            at
        }
    }

    /// Turn the door at a cell between open and shut, or refuse. Anybody may work it — a door is not a
    /// lock — so this takes no lock and is not an edit. The hearing rule follows at once, because the plan
    /// that changed is broadcast whole.
    pub(super) fn toggle_door(&mut self, id: u64, floor: usize, row: usize, col: usize) -> Result<(), String> {
        let Some(person) = self.people.iter().find(|person| person.id == id) else {
            return Err("you are not on the floor".into());
        };
        if person.floor != floor {
            return Err("that door is on another floor".into());
        }
        let (x, y) = self.model.floors[floor].cells.center(row, col);
        let reach = ((person.x - x).powi(2) + (person.y - y).powi(2)).sqrt();
        if reach > DOOR_REACH {
            return Err("walk up to that door before you work it".into());
        }
        self.change_model((0, 0), floor, |model| model.floor_mut(floor)?.toggle_door(row, col))
    }
}
