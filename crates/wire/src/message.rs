//! The messages on the socket. Both directions serialize and deserialize, so the server, the headless
//! colleague and any test speak the protocol through these types rather than through hand-built JSON.

use serde::{Deserialize, Serialize};

use crate::{Edit, Figure, PlanFile};

/// A person as everybody else is told about them.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersonView {
    pub id: u64,
    pub name: String,
    pub x: f32,
    pub y: f32,
/// The figure they own, on every state message so a client draws somebody the moment they appear. Defaulted, so
/// a message written before figures existed is still a person.
    #[serde(default)]
    pub figure: Figure,
/// Their microphone is above the speaking threshold: a fact they state about themselves, carried like a position.
/// Defaulted false, so an older message is a person who is silent.
    #[serde(default)]
    pub speaking: bool,
/// Their microphone is stopped: presence and hearing stay, they transmit nothing. Carried so a figure can show it
/// — nobody should believe they were heard.
    #[serde(default)]
    pub muted: bool,
    /// A test avatar: a figure nobody is behind. Carried so a client can tell them apart from people — the
    /// sidebar offers to send one home, and only one of those may be sent home.
    #[serde(default)]
    pub avatar: bool,
    /// Which floor they are on. Defaulted to the ground floor, so an older state message is a building
    /// with one floor and everybody on it.
    #[serde(default)]
    pub floor: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToClient {
    Plan { id: String, plan: PlanFile },
    Hello { id: u64, name: String },
    State { people: Vec<PersonView> },
    /// There is no way to that point — a shut door is enough to make one. Said out loud, because
    /// silence would look like a client that did not hear the click.
    NoWay { x: f32, y: f32 },
    /// Somebody in earshot is about to talk to me. Their id rather than a name, so my own hearing rule
    /// decides whether to listen. The server hands it over only inside one area, and decides nothing else.
    Introduction { from: u64 },
    /// A piece of their conversation to open: an offer, an answer, a candidate. Carried unopened, and
    /// the server reads none of it.
    Signal { from: u64, payload: String },
    /// Who is editing the building right now, so everybody can see it. `None` is nobody: the plan is
    /// whole and any edit may be made. Sent when the lock changes and to each client as they arrive.
    Lock { holder: Option<u64>, name: Option<String> },
/// Something I sent was refused. Nothing changed: the truth that follows is the one still in force, which puts a
/// client that drew ahead of the server back where it was.
    Refused { reason: String },
/// The recordings a test avatar may be given. Sent as a client arrives, so a machine with none says so by an
/// empty list rather than by failing later.
    Voices { names: Vec<String> },
/// This server's one demo figure: the name and the recording, `None` for a server that has none. Sent as a client
/// arrives, so the button knows what it would put on the floor.
    Demo { name: String, #[serde(default)] voice: Option<String> },
    /// A test avatar could not be made or sent home, and this says why. Its own message rather than
    /// `Refused`, which is about the building.
    AvatarProblem { why: String },
    /// Somebody in earshot asks me to come over. The name travels with it, because "come over" without a
    /// face is a command; with one it is an invitation.
    Summoned { from: u64, name: String },
    /// The answer to a call I made, so I know whether to wait. `accepted` is what they said.
    SummonAnswer { by: u64, name: String, accepted: bool },
}

/// A place to arrive at: one cell on one floor. The client keeps it; the server decides whether it is still
/// a place somebody can stand.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Seat {
    #[serde(default)]
    pub floor: usize,
    pub row: usize,
    pub col: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromClient {
    Join {
        name: String,
        /// The cell somebody would like to arrive at, carried from their last visit. The server takes it
        /// only if it can still be stood on.
        #[serde(default)]
        seat: Option<Seat>,
    },
    Walk { x: f32, y: f32 },
    /// Tell somebody in earshot that I want to talk to them.
    Introduce { to: u64 },
    /// Hand somebody in earshot a piece of the conversation to open.
    Signal { to: u64, payload: String },
    /// Turn the door at a cell between open and shut. Anybody may do it, and it is not an edit: a door is
    /// not a lock. The hearing rule follows at once, because the plan that changed is sent to everybody.
    ToggleDoor { #[serde(default)] floor: usize, row: usize, col: usize },
    /// A change to the building. Only the holder of the edit lock may make one; anybody else is refused.
    /// The floor is defaulted, so an edit written before stairs existed changes the ground floor.
    Edit { #[serde(default)] floor: usize, edit: Edit },
    /// Take the stairs at a cell. The floor is not named: the stairs lead where they lead, and the server
    /// knows which floor the person is on. A cell without a stair is refused, and so is a stair with a
    /// floor above it that does not exist.
    TakeStairs { row: usize, col: usize },
    /// The figure I want to be drawn as. Mine alone, and mine to set at any time; the server checks it is
    /// a figure it can draw and refuses one it is not rather than repairing it. Everybody else sees it on
    /// the very next state message.
    Figure { figure: Figure },
    /// I am talking, or I have stopped. My own microphone against the speaking threshold, said about
    /// myself — a fact carried like a position, never a lock, and no audio involved.
    Speaking { speaking: bool },
    /// My microphone is stopped, or it is running again. A gesture and not a status: a new arrival is
    /// never muted.
    Muted { muted: bool },
/// Put the one demo figure on the floor or send it home. Which figure that is belongs to the server, so the
/// interface has a button and no list of choices.
    DemoGuest { on: bool },
    /// Ask somebody in earshot to come over: the question, not the command. Their own client shows who is
    /// calling and decides; nothing moves until they answer.
    Summon { to: u64 },
    /// The answer to a `Summon`: yes walks to where the caller stands, no lets the question lapse.
    AnsweredSummon { from: u64, accept: bool },
    /// A whole plan, put in place of the one being served: what an import is. Only the holder of the edit
    /// lock may do it, and the plan has to pass the same checks a floor is read with.
    Replace { plan: PlanFile },
    /// Make a test avatar, or send one home. `voice` names a recording for one that speaks, and `None` is a
    /// figure that only walks; `home` takes that figure off the floor instead of making it. The server
    /// answers with the state everybody gets — the sidebar reads the avatars out of that — or with
    /// `AvatarProblem` when there is nothing to make.
    Avatar { name: String, voice: Option<String>, #[serde(default)] home: bool },
}

impl ToClient {
    /// The message as the socket carries it. Every type here serializes, so a failure is a bug, not a
    /// condition to handle at every call site.
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("a server message always serializes")
    }
}

impl FromClient {
    /// The message as the socket carries it; see `ToClient::to_text`.
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("a client message always serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_type_field_is_the_name_of_the_message() {
        let no_way = serde_json::to_value(ToClient::NoWay { x: 1.0, y: 2.0 }).unwrap();
        assert_eq!(no_way["type"], "no_way");
        let plan = serde_json::to_value(ToClient::Plan {
            id: "p".into(),
            plan: PlanFile { version: 1, cell_m: 0.5, floors: vec![], arrival: None },
        })
        .unwrap();
        assert_eq!(plan["type"], "plan");
        assert_eq!(plan["plan"]["cell_m"], 0.5);
        match serde_json::from_str::<FromClient>(r#"{"type":"join","name":"ada"}"#).unwrap() {
            FromClient::Join { name, .. } => assert_eq!(name, "ada"),
            other => panic!("a join became {other:?}"),
        }
        let introduction = serde_json::to_value(ToClient::Introduction { from: 3 }).unwrap();
        assert_eq!(introduction["type"], "introduction");
        assert_eq!(introduction["from"], 3);
        let signal = serde_json::to_value(ToClient::Signal { from: 3, payload: "v=0".into() }).unwrap();
        assert_eq!(signal["type"], "signal");
        assert_eq!(signal["payload"], "v=0");
        match serde_json::from_str::<FromClient>(r#"{"type":"introduce","to":7}"#).unwrap() {
            FromClient::Introduce { to } => assert_eq!(to, 7),
            other => panic!("expected an introduction, got {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"signal","to":7,"payload":"a=1"}"#).unwrap() {
            FromClient::Signal { to, payload } => {
                assert_eq!(to, 7);
                assert_eq!(payload, "a=1");
            }
            other => panic!("expected a signal, got {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"walk","x":1.5,"y":2.5}"#).unwrap() {
            FromClient::Walk { x, y } => assert_eq!((x, y), (1.5, 2.5)),
            other => panic!("a walk became {other:?}"),
        }
    }

    #[test]
    fn a_figure_is_asked_for_with_a_recording_or_without_one() {
        // A figure that speaks names the recording; one that only walks leaves it out, and the absence is what
        // says so rather than an empty name.
        match serde_json::from_str::<FromClient>(r#"{"type":"avatar","name":"Ada","voice":"voice.wav"}"#).unwrap() {
            FromClient::Avatar { name, voice, home } => {
                assert_eq!(name, "Ada");
                assert_eq!(voice.as_deref(), Some("voice.wav"));
                assert!(!home, "making a figure is the ordinary case");
            }
            other => panic!("a figure became {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"avatar","name":"Wanderer"}"#).unwrap() {
            FromClient::Avatar { voice, home, .. } => {
                assert!(voice.is_none(), "no recording is a figure that only walks");
                assert!(!home);
            }
            other => panic!("a figure became {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"avatar","name":"Ada","home":true}"#).unwrap() {
            FromClient::Avatar { name, home, .. } => {
                assert_eq!(name, "Ada");
                assert!(home, "sending one home is the same message, said the other way round");
            }
            other => panic!("a figure became {other:?}"),
        }
        let voices = serde_json::to_value(ToClient::Voices { names: vec!["voice.wav".into()] }).unwrap();
        assert_eq!(voices["type"], "voices");
        assert_eq!(voices["names"][0], "voice.wav");
        let problem = serde_json::to_value(ToClient::AvatarProblem { why: "Ada is already here".into() }).unwrap();
        assert_eq!(problem["type"], "avatar_problem");
        assert_eq!(problem["why"], "Ada is already here");
    }

    #[test]
    fn the_one_demo_figure_is_asked_for_as_on_or_off() {
        // One gesture and no name: which figure it is belongs to the server that holds the recordings, so the
        // interface never names it and there is nothing on this side to get wrong.
        match serde_json::from_str::<FromClient>(r#"{"type":"demo_guest","on":true}"#).unwrap() {
            FromClient::DemoGuest { on } => assert!(on, "on puts the demo figure on the floor"),
            other => panic!("the demo guest became {other:?}"),
        }
        match serde_json::from_str::<FromClient>(r#"{"type":"demo_guest","on":false}"#).unwrap() {
            FromClient::DemoGuest { on } => assert!(!on, "off sends it home again"),
            other => panic!("the demo guest became {other:?}"),
        }
    }

    #[test]
    fn the_demo_figure_is_told_with_its_name_and_its_recording() {
        // Told once as a client arrives: the name the sidebar shows and the recording it speaks. A server with no
        // recording leaves the recording out rather than naming a file that is not there.
        let told: ToClient =
            serde_json::from_str(r#"{"type":"demo","name":"Mark-Uwe","voice":"a.wav"}"#).unwrap();
        match told {
            ToClient::Demo { name, voice } => {
                assert_eq!(name, "Mark-Uwe");
                assert_eq!(voice.as_deref(), Some("a.wav"));
            }
            other => panic!("the demo figure was told as {other:?}"),
        }
        let bare: ToClient = serde_json::from_str(r#"{"type":"demo","name":"Mark-Uwe"}"#).unwrap();
        match bare {
            ToClient::Demo { name, voice } => {
                assert_eq!(name, "Mark-Uwe");
                assert!(voice.is_none(), "no recording is a figure nothing can speak");
            }
            other => panic!("the demo figure was told as {other:?}"),
        }
    }

    #[test]
    fn a_person_who_is_a_figure_says_so_and_an_older_message_is_a_person() {
        let figure = serde_json::to_value(PersonView {
            floor: 0,
            id: 3,
            name: "Ada".into(),
            x: 1.0,
            y: 2.0,
            figure: Figure::default(),
            speaking: false,
            muted: false,
            avatar: true,
        })
        .unwrap();
        assert_eq!(figure["avatar"], true);
        // A message written before test figures existed is a person: the field is defaulted, never required.
        let older: PersonView = serde_json::from_str(r#"{"id":3,"name":"Ada","x":1.0,"y":2.0}"#).unwrap();
        assert!(!older.avatar);
    }
}
