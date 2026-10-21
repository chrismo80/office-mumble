//! What the client and the server agree on, and the arithmetic a plan is made of.
//!
//! The grid exists for rules — what may be walked, what stops sound — not for motion. People move in
//! metres; the grid only decides what is allowed.
//!
//! | Module    | Holds                                                              |
//! |-----------|--------------------------------------------------------------------|
//! | `grid`    | cells, and the ways across them: walkable, sound, path, nearest    |
//! | `model`   | the building as it is stored and served: floors, surfaces, objects |
//! | `edit`    | how the building changes, validated against the model              |
//! | `figure`  | what a person looks like, and what a figure may be                 |
//! | `message` | the messages on the socket, both directions                        |

mod edit;
mod figure;
mod grid;
mod message;
pub mod furniture;
mod model;

pub use edit::{At, CellChange, Edit, Shift};
pub use figure::{Figure, Palette, Parts, ARM_STYLES, BODY_STYLES, HEAD_STYLES};
pub use grid::{Cell, Grid};
pub use message::{FromClient, PersonView, Seat, ToClient};
pub use furniture::{blocks, footprint};
pub use model::{Facing, Floor, Label, Object, OnCell, Painted, PlanFile, Side, Stair, Surface};

/// Half a metre, the side of one cell.
pub const CELL_M: f32 = 0.5;
