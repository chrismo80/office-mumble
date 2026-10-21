//! Everything the server knows and decides, without a socket: the plan, who is where, the edit lock, and
//! what each message is answered with. The session carries the answer, so all of this is tested synchronously.

use office_mumble_wire::{furniture, Cell, FromClient, Grid, PlanFile, ToClient};

mod calls;
mod doors;
mod plan;
mod moves;
mod people;

use crate::person::Person;

/// A signal is a few kilobytes of SDP or a candidate; anything vastly larger is dropped where it arrives.
const MAX_SIGNAL_LEN: usize = 64 * 1024;

/// What a colleague goes to when it has nothing to do: the things a person in an office goes to — the coffee,
/// the fridge, a table, the sofa. A wander that never ends anywhere is not a day at work.
const HAUNTS: &[&str] = &[
    "kitchenCoffeeMachine",
    "kitchenFridge",
    "kitchenSink",
    "kitchenBar",
    "table",
    "tableCoffeeGlass",
    "loungeSofaLong",
    "loungeSofaCorner",
];

/// How close a body has to be to work a door. A handle is at arm's length: a door swung from across the room
/// is a door nobody has to walk to, and walking is the point.
const DOOR_REACH: f32 = 1.5;

/// Who a message the world produced goes to.
#[derive(Debug)]
pub enum Outbound {
    /// The person whose message this answers.
    Reply(ToClient),
    /// Everybody connected, the sender included.
    Everybody(ToClient),
    /// One other person, by id — a relay, which the server carries unopened.
    To(u64, ToClient),
}

pub struct World {
    /// The whole model, held once, so nothing has to be kept in step with it.
    model: PlanFile,
    plan_id: String,
    people: Vec<Person>,
    next_id: u64,
    /// Who is editing the building now, held until their connection ends.
    lock: Option<u64>,
    /// Where the plan is written back after every change. `None` for a world that lives only in memory, as
    /// the tests want; the server sets it, because an evening of building that a restart erases is not a
    /// building.
    save_path: Option<std::path::PathBuf>,
}

/// The grid of one floor. A free function rather than a method, so it can be borrowed beside `people`
/// while somebody is being moved.
fn grid_of(model: &PlanFile, floor: usize) -> &Grid {
    &model.floors[floor].cells
}

/// The floor as a body finds it: the cells, plus what stands on them. Pieces you can walk through — chairs,
/// a screen on a desk, an upper cabinet — are left out; the rest is as solid as a wall, and the path goes
/// round it. `Grid::path` already takes the nearest walkable cell when the one asked for is solid, so a click
/// on a table walks to its edge instead of nowhere. A stair is fenced on every side but its foot.
fn walk_grid(model: &PlanFile, floor: usize) -> Grid {
    let mut grid = model.floors[floor].cells.clone();
    for stair in &model.floors[floor].stairs {
        for (inside, outside) in stair.fences() {
            grid.fence(inside, outside);
        }
    }
    for object in &model.floors[floor].objects {
        if !furniture::blocks(&object.kind) {
            continue;
        }
        let (rows, cols) = furniture::footprint(&object.kind, object.facing);
        for row in object.row..object.row + rows {
            for col in object.col..object.col + cols {
                if grid.contains(row, col) {
                    grid.set(row, col, Cell::Wall);
                }
            }
        }
    }
    grid
}

impl World {
    /// A world on a model that has already been checked: `PlanFile::parse` guarantees a floor exists.
    pub fn new(model: PlanFile, plan_id: String) -> World {
        World { model, plan_id, people: Vec::new(), next_id: 1, lock: None, save_path: None }
    }

    /// Write the plan where it came from after every change. Chained onto `new`, so a world that should
    /// stay in memory — a test's, a scratch one — simply never asks for it.
    pub fn keep_on_disk(mut self, path: std::path::PathBuf) -> World {
        self.save_path = Some(path);
        self
    }



















    pub fn state(&self) -> ToClient {
        ToClient::State { people: self.people.iter().map(Person::view).collect() }
    }

    pub fn plan_message(&self) -> ToClient {
        ToClient::Plan { id: self.plan_id.clone(), plan: self.model.clone() }
    }















    /// What one message from a person who has joined is answered with. A join itself is the session's to
    /// answer, because it is the session that learns the socket's id from it.
    pub fn handle(&mut self, id: u64, message: FromClient) -> Vec<Outbound> {
        match message {
            // A call never reaches the world: the session carries it between two people, and only the
            // answer moves anybody.
            FromClient::Summon { .. } | FromClient::AnsweredSummon { .. } => Vec::new(),
            FromClient::Join { .. } => Vec::new(),
            // The test avatars are the hub's, not the world's: the session answers these, because making
            // an avatar can mean starting a program and sending one home can mean ending it.
            FromClient::Replace { plan } => {
                let outcome = self.replace_plan(id, plan);
                answer(id, "a plan", outcome, self.plan_message())
            }
            FromClient::Avatar { .. } | FromClient::DemoGuest { .. } => Vec::new(),
            FromClient::Walk { x, y } => {
                if self.walk(id, x, y) {
                    return Vec::new();
                }
                println!("{id} asked for a place with no way to it");
                vec![Outbound::Reply(ToClient::NoWay { x, y })]
            }
            FromClient::Introduce { to } => {
                if !self.same_area(id, to) {
                    println!("{id} asked to talk to {to} across a wall or a shut door: not carried");
                    return Vec::new();
                }
                println!("{id} is about to talk to {to}");
                vec![Outbound::To(to, ToClient::Introduction { from: id })]
            }
            FromClient::Signal { to, payload } => {
                if payload.len() > MAX_SIGNAL_LEN {
                    eprintln!("{id} sent {to} something of {} bytes, which is not a signal", payload.len());
                    return Vec::new();
                }
                if !self.same_area(id, to) {
                    println!("{id} signalled {to} across a wall or a shut door: not carried");
                    return Vec::new();
                }
                vec![Outbound::To(to, ToClient::Signal { from: id, payload })]
            }
            FromClient::ToggleDoor { floor, row, col } => {
                let outcome = self.toggle_door(id, floor, row, col);
                answer(id, &format!("the door at {row}, {col}"), outcome, self.plan_message())
            }
            FromClient::TakeStairs { row, col } => {
                let outcome = self.take_stairs(id, row, col);
                answer(id, &format!("the stairs at {row}, {col}"), outcome, self.state())
            }
            FromClient::Edit { floor, edit } => {
                let (took_the_lock, outcome) = self.apply_edit(id, floor, edit);
                let mut out = Vec::new();
                if took_the_lock {
                    out.push(Outbound::Everybody(self.lock_message()));
                }
                out.extend(answer(id, "an edit", outcome, self.plan_message()));
                out
            }
            FromClient::Figure { figure } => {
                // Answered right away, not on the next tick: the figure is the person's own and everybody
                // drawing it is the point of it.
                let outcome = self.set_figure(id, figure);
                answer(id, "a figure", outcome, self.state())
            }
            FromClient::Speaking { speaking } => {
                self.set_speaking(id, speaking);
                Vec::new()
            }
            FromClient::Muted { muted } => {
                self.set_muted(id, muted);
                Vec::new()
            }
        }
    }









    /// Who holds the edit lock, as a message everybody can be sent. The name travels with it, so a client
    /// can show who is editing without keeping a roster of its own.
    pub fn lock_message(&self) -> ToClient {
        let holder = self.lock;
        ToClient::Lock { holder, name: holder.and_then(|id| self.name_of(id)) }
    }

    /// Let go of the lock if this person held it. True when it lapsed, so the caller can tell everybody.
    fn release_lock(&mut self, id: u64) -> bool {
        if self.lock == Some(id) {
            self.lock = None;
            true
        } else {
            false
        }
    }


















}

/// What a change is answered with: the new truth to everybody, or the reason to them and the truth still in
/// force to everybody — which puts a client that drew ahead of the server back where it was.
fn answer(id: u64, what: &str, outcome: Result<(), String>, truth: ToClient) -> Vec<Outbound> {
    match outcome {
        Ok(()) => {
            println!("{id}: {what}, done");
            vec![Outbound::Everybody(truth)]
        }
        Err(reason) => {
            println!("{id}: {what}, refused: {reason}");
            vec![Outbound::Reply(ToClient::Refused { reason }), Outbound::Everybody(truth)]
        }
    }
}

#[cfg(test)]
mod tests;
