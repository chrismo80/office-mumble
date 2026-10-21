//! Who is in the building: a name, a place to stand, and the three things a person can say about themselves
//! (a figure, that they are talking, that they are muted).

use office_mumble_wire::{Figure, Grid, Seat};

use super::{grid_of, walk_grid, Outbound, World};
use crate::person::Person;

impl World {
    /// The floor somebody is standing on, or the ground floor for somebody who is not here.
    pub fn floor_of(&self, id: u64) -> usize {
        self.people.iter().find(|person| person.id == id).map(|person| person.floor).unwrap_or(0)
    }

    pub fn grid(&self) -> &Grid {
        grid_of(&self.model, 0)
    }

    /// Say that somebody on the floor is a test avatar rather than a person. Said when they arrive, so the
    /// fact travels in the state everybody already gets.
    pub fn mark_avatar(&mut self, id: u64) {
        if let Some(person) = self.people.iter_mut().find(|person| person.id == id) {
            person.avatar = true;
        }
    }

    /// Somebody by name. A speaking test avatar is a client of its own, so which person it is only shows once
    /// it has joined.
    pub fn id_of(&self, name: &str) -> Option<u64> {
        self.people.iter().find(|person| person.name == name).map(|person| person.id)
    }

    /// Where somebody is, if they are on the floor — and whether they are standing still, which is what
    /// leaves an avatar that is already walking somewhere alone.
    pub fn place(&self, id: u64) -> Option<(f32, f32, bool)> {
        self.people
            .iter()
            .find(|person| person.id == id)
            .map(|person| (person.x, person.y, person.path.is_empty()))
    }

    pub fn join(&mut self, wanted: String, seat: Option<Seat>) -> (u64, String) {
        // A seat is a request, not a right: a desk that has since become a wall is not a place to stand.
        let place = seat.and_then(|seat| {
            let grid = walk_grid(&self.model, seat.floor);
            grid.get(seat.row, seat.col)
                .walkable()
                .then(|| (seat.floor, grid.center(seat.row, seat.col)))
        });
        let (floor, at) = place.unwrap_or_else(|| self.arrival());
        self.join_on(wanted, floor, at)
    }

    /// Where somebody arrives who brings no seat: the plan's arrival, or the cell nearest to it a body can
    /// stand on when a wall or a piece of furniture has since taken it. A plan without one sends them to the
    /// ground floor's first walkable cell.
    pub fn arrival(&self) -> (usize, (f32, f32)) {
        if let Some(arrival) = self.model.arrival {
            let grid = walk_grid(&self.model, arrival.floor);
            let (x, y) = grid.center(arrival.row, arrival.col);
            if let Some((row, col)) = grid.nearest_walkable(x, y) {
                return (arrival.floor, grid.center(row, col));
            }
        }
        (0, walk_grid(&self.model, 0).spawn_point())
    }

    /// Somebody starting where the caller says: the demo figures are put down at different stops of the round,
    /// so a whole building can be listened to at once instead of one walker at a time.
    pub fn join_on(&mut self, wanted: String, floor: usize, at: (f32, f32)) -> (u64, String) {
        let id = self.next_id;
        self.next_id += 1;
        let name = if wanted.trim().is_empty() { format!("guest-{id}") } else { wanted.trim().to_string() };
        let floor = floor.min(self.model.floors.len().saturating_sub(1));
        let mut person = Person::new(id, name.clone(), at.0, at.1);
        person.floor = floor;
        self.people.push(person);
        (id, name)
    }

    /// Somebody's connection ended: they leave the floor, and the lock falls away if they held it —
    /// nobody has to hand anything back.
    /// The person answering to a name, if one is on the floor — how a speaking avatar whose process has ended
    /// is found again.
    pub fn person_named(&self, name: &str) -> Option<u64> {
        self.people.iter().find(|person| person.name == name).map(|person| person.id)
    }

    pub fn depart(&mut self, id: u64) -> Vec<Outbound> {
        let lapsed = self.release_lock(id);
        self.leave(id);
        println!("{id} left");
        if lapsed {
            println!("the edit lock lapsed when {id} left");
            vec![Outbound::Everybody(self.lock_message())]
        } else {
            Vec::new()
        }
    }

    fn leave(&mut self, id: u64) {
        self.people.retain(|p| p.id != id);
    }

    /// Change somebody who is still connected; somebody who has gone is nobody to change.
    fn person_mut(&mut self, id: u64, change: impl FnOnce(&mut Person)) -> bool {
        match self.people.iter_mut().find(|p| p.id == id) {
            Some(person) => {
                change(person);
                true
            }
            None => false,
        }
    }

    /// The name of a person still connected, or `None` for somebody who has gone.
    pub(crate) fn name_of(&self, id: u64) -> Option<String> {
        self.people.iter().find(|p| p.id == id).map(|p| p.name.clone())
    }

    /// Keep the figure a person has just chosen. It is theirs alone and the server only holds it: the
    /// figure is checked first, and one that is not a figure the drawing can draw is refused with a reason
    /// rather than repaired into something the person did not choose.
    pub(super) fn set_figure(&mut self, id: u64, figure: Figure) -> Result<(), String> {
        figure.check()?;
        if self.person_mut(id, |person| person.figure = figure) {
            Ok(())
        } else {
            Err("you are not on the floor".to_string())
        }
    }

    /// Record that somebody is talking, or has stopped. A fact they state about themselves, carried like a
    /// position: no lock is involved and the server arbitrates nothing.
    pub(super) fn set_speaking(&mut self, id: u64, speaking: bool) {
        self.person_mut(id, |person| person.speaking = speaking);
    }

    /// Record whether somebody's microphone is stopped. A gesture, not a preference: it lives and dies with
    /// the connection that made it, so nobody has to remember to put it back.
    pub(super) fn set_muted(&mut self, id: u64, muted: bool) {
        self.person_mut(id, |person| person.muted = muted);
    }
}
