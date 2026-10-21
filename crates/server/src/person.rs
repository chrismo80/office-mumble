//! Somebody on the floor as the server keeps them: where they are, where they are going, and what they
//! have said about themselves. Only the server moves people; everybody else is told a `PersonView`.

use office_mumble_wire::{Figure, PersonView};

/// Walking pace, metres per second.
pub const SPEED_MPS: f32 = 1.4;

#[derive(Clone, Debug)]
pub struct Person {
    pub id: u64,
    pub name: String,
    pub x: f32,
    pub y: f32,
    /// The floor they are on. A person walks, hears and is heard on one floor at a time; the stairs change it.
    pub floor: usize,
    /// True while standing on the stair they arrived by, so a tick does not send them back down the way
    /// they came. Cleared as soon as they step off it.
    pub on_stair: bool,
    /// Remaining waypoints, in metres. Empty means standing still.
    pub path: Vec<(f32, f32)>,
    /// What this person looks like. They own it; one is chosen for them at birth so nobody has to choose
    /// one to be drawn.
    pub figure: Figure,
    /// Whether their microphone is above the speaking threshold right now, as they last said.
    pub speaking: bool,
    /// Whether their microphone is stopped, as they last said. Never a preference and never persisted:
    /// a new arrival starts transmitting again.
    pub muted: bool,
    /// A test avatar: nobody is behind this figure. Set when it is made, so the sidebar can offer to send it
    /// home — and so nobody thinks a colleague has gone quiet when a stand is taken down.
    pub avatar: bool,
}

impl Person {
    pub fn new(id: u64, name: impl Into<String>, x: f32, y: f32) -> Person {
        Person {
            id,
            name: name.into(),
            x,
            y,
            floor: 0,
            on_stair: false,
            path: Vec::new(),
            figure: Figure::for_id(id),
            speaking: false,
            muted: false,
            avatar: false,
        }
    }

    pub fn view(&self) -> PersonView {
        PersonView {
            id: self.id,
            name: self.name.clone(),
            x: self.x,
            y: self.y,
            floor: self.floor,
            figure: self.figure.clone(),
            speaking: self.speaking,
            muted: self.muted,
            avatar: self.avatar,
        }
    }

    pub fn walk_to(&mut self, path: Vec<(f32, f32)>) {
        self.path = path;
    }

    /// Move along the path for one tick. Whoever reaches a waypoint drops it; whoever runs out of path
    /// stands still, which is what makes standing still cost nothing later on.
    pub fn step(&mut self, dt_s: f32) {
        let mut budget = SPEED_MPS * dt_s;
        while budget > 0.0 {
            let Some(&(tx, ty)) = self.path.first() else { break };
            let (dx, dy) = (tx - self.x, ty - self.y);
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= budget || dist == 0.0 {
                self.x = tx;
                self.y = ty;
                self.path.remove(0);
                budget -= dist;
            } else {
                self.x += dx / dist * budget;
                self.y += dy / dist * budget;
                budget = 0.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use office_mumble_wire::{FromClient, Palette, Parts};

    #[test]
    fn walking_costs_time_and_then_stops() {
        let mut p = Person::new(1, "probe", 0.0, 0.0);
        p.walk_to(vec![(1.0, 0.0), (1.0, 1.0)]);
        p.step(0.1); // 14 cm
        let after_one_tick = (p.x, p.y);
        assert!(after_one_tick.0 > 0.0 && after_one_tick.0 < 1.0);
        assert!((after_one_tick.1 - 0.0).abs() < 1e-6);
        for _ in 0..100 {
            p.step(0.1);
        }
        assert_eq!((p.x, p.y), (1.0, 1.0));
        assert!(p.path.is_empty());
        p.step(0.1);
        assert_eq!((p.x, p.y), (1.0, 1.0));
    }

    #[test]
    fn everybody_is_given_a_figure_and_two_neighbours_are_not_the_same_one() {
        let one = Person::new(1, "Ada", 0.0, 0.0);
        let two = Person::new(2, "Bob", 0.0, 0.0);
        // Nobody has to choose a figure to be seen, and the one they are handed is a whole one.
        assert!(one.figure.palette.shirt.starts_with('#'));
        assert_eq!(one.figure.parts, Parts::default());
        // Tellable apart at a glance is the requirement, so the shirts differ between neighbours.
        assert_ne!(one.figure.palette.shirt, two.figure.palette.shirt);
        // And the same person is the same figure everywhere it is computed, or two clients would disagree.
        assert_eq!(Person::new(1, "somewhere else", 5.0, 5.0).figure, one.figure);
    }

    #[test]
    fn a_person_says_whether_they_are_talking_and_whether_they_are_muted() {
        // Both are facts people state about themselves, carried like a position, defaulted false so a
        // message written before either existed is a person who is silent and transmitting.
        let view = serde_json::to_value(Person::new(3, "Cid", 1.0, 1.0).view()).unwrap();
        assert_eq!(view["speaking"], false);
        assert_eq!(view["muted"], false);

        match serde_json::from_str::<FromClient>(r#"{"type":"speaking","speaking":true}"#).unwrap() {
            FromClient::Speaking { speaking } => assert!(speaking),
            other => panic!("a speaking became {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"muted","muted":true}"#).unwrap() {
            FromClient::Muted { muted } => assert!(muted),
            other => panic!("a muted became {other:?}"),
        }
        let sent = r##"{"type":"figure","figure":{"parts":{"head":"oval"},"palette":{"skin":"#112233","hair":"#112233","shirt":"#112233","trousers":"#112233"}}}"##;
        match serde_json::from_str::<FromClient>(sent).unwrap() {
            FromClient::Figure { figure } => {
                assert_eq!(figure.parts.head.as_deref(), Some("oval"));
                assert!(figure.check().is_ok());
            }
            other => panic!("a figure became {other:?}"),
        }
    }

    #[test]
    fn a_person_view_written_before_figures_existed_is_still_a_person() {
        let older = r#"{"id":7,"name":"Ada","x":1.0,"y":2.0}"#;
        let view: PersonView = serde_json::from_str(older).unwrap();
        assert_eq!((view.id, view.x, view.y), (7, 1.0, 2.0));
        assert_eq!(view.figure.palette, Palette::default());
        assert!(!view.speaking && !view.muted, "an older message is a silent, transmitting person");
        // The fixture the server serves already carries the figures its people own, drawn by id.
        let text = serde_json::to_string(&Person::new(3, "Cid", 1.0, 1.0).view()).unwrap();
        let again: PersonView = serde_json::from_str(&text).unwrap();
        assert_eq!(again.figure, Figure::for_id(3));
    }
}
