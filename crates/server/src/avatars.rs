//! Test avatars: figures nobody is behind. They exist for what only a second person can test — whether sound
//! arrives, whether a wall stops it, how a floor sounds with somebody walking on it — so they are real clients,
//! not drawings. A walking avatar is a person the world moves; a speaking one is the harness's colleague, which
//! carries real Opus exactly as a browser does. Both kinds are moved from here, through `World::handle`.
//!
//! | Endpoint              | What it does                                        |
//! |-----------------------|-----------------------------------------------------|
//! | `GET /avatars`        | the avatars that exist, with their kind and voice   |
//! | `GET /avatars/voices` | the recordings a speaking avatar can be given       |
//! | `POST /avatars`       | make one: `{"name": ..., "voice": "<a recording>"}` |
//! | `DELETE /avatars/<n>` | send one home                                       |
//!
//! A test affordance, not part of the office: here so the floor can be listened to alone.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use axum::{
    extract::{Path as UrlPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use office_mumble_wire::FromClient;
use serde::{Deserialize, Serialize};

use crate::session::Hub;
use crate::world::World;

/// How long an avatar stands before it picks somewhere new: long enough to be found, short enough not to look frozen.
// Long enough that a figure can be found where it stands, short enough that a round through the building
// takes minutes and not an evening.
const WANDER_EVERY: Duration = Duration::from_secs(5);


/// How many places are tried before it keeps standing. A random cell is often a wall, so this is a retry count.
const WANDER_TRIES: usize = 24;

/// A long run for a colleague process: it stays until it is sent home, so the number is out of the way.
const FOR_A_DAY: &str = "86400";

pub struct Avatars {
    /// The recordings a speaking avatar may be given, by file name.
    voices: PathBuf,
    /// The colleague program, if it has been built. Without it nothing can speak — a walking avatar needs
    /// nothing but the world this server already has.
    colleague: Option<PathBuf>,
    /// The port this server answers on, so a colleague process can be told where to connect.
    port: u16,
    /// What exists right now, by name.
    running: Mutex<HashMap<String, Avatar>>,
    /// The name of the one demo figure the sidebar offers, and the recording it speaks — both from this
    /// machine's settings, because the recordings are here and the interface runs elsewhere. `None` for the
    /// recording means this server has none, and the sidebar says so instead of offering a button that fails.
    demo_name: String,
    demo_voice: Option<String>,
    /// Only here to make the next place random: no crate in this workspace needs a generator for anything
    /// else, and a wander that always picks the same place is not a wander.
    rolls: Mutex<u64>,
    /// Speaking avatars say here when their process ends. The one event this registry cannot see for itself,
    /// and the reason a name could outlive its voice.
    died_tx: mpsc::UnboundedSender<String>,
    died: tokio::sync::Mutex<mpsc::UnboundedReceiver<String>>,
}

struct Avatar {
    /// The person on the floor, once they are on it. A speaking avatar is its own client, so its id is not
    /// known until it has joined; a walking one is given its id here and now.
    id: Option<u64>,
    /// The recording this avatar speaks, or `None` for one that only walks.
    voice: Option<String>,
    /// How to end the process behind a speaking avatar. The task that owns the process listens here; the
    /// registry never holds the child itself, so nothing has to be looked at twice a second to learn it is gone.
    end: Option<oneshot::Sender<()>>,
    /// Where in the round this figure is going next. Kept per figure, so two of them are never at the same
    /// room at the same time unless they caught up.
    stop: usize,
    /// The place reserved for a speaking figure before its process has joined: three presses in a row would
    /// otherwise all pick the same stop, because none of them is on the floor yet.
    at: Option<(usize, (f32, f32))>,
}

#[derive(Serialize)]
struct Told {
    name: String,
    kind: &'static str,
    voice: Option<String>,
    /// Whether it is on the floor yet — a speaking avatar has to connect first.
    on_floor: bool,
    /// Where it stands and whether it is on its way. Position is the world's, looked up when the list is asked for.
    x: f32,
    y: f32,
    walking: bool,
}

/// One avatar as this registry keeps it, before the world is asked where it stands.
struct Entry {
    name: String,
    id: Option<u64>,
    kind: &'static str,
    voice: Option<String>,
}

#[derive(Deserialize)]
struct Wanted {
    name: Option<String>,
    voice: Option<String>,
}

/// The first recording in the folder, by name. `None` for a folder that is not there or holds no .wav.
fn first_recording(folder: &std::path::Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    names.into_iter().next()
}

impl Avatars {
    /// Where the recordings and the colleague program live. The program is looked for beside this server's own
    /// binary first, because both live under `target/`: the colleague in `debug/`, the server usually in `release/`.
    pub fn new(port: u16) -> Avatars {
        let voices = PathBuf::from(setting("OFFICE_MUMBLE_VOICES_DIR", "harness/dummy/public"));
        let colleague = std::env::var("OFFICE_MUMBLE_COLLEAGUE")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(find_colleague);
        // The demo figure's name and recording are settings of this machine, because the recordings are here.
        // A recording named but not on disk is said out loud and treated as absent — a button that fails is worse.
        let demo_name = std::env::var("OFFICE_MUMBLE_DEMO_NAME")
            .ok()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Mark-Uwe".to_string());
        let demo_voice = std::env::var("OFFICE_MUMBLE_DEMO_VOICE")
            .ok()
            .map(|voice| voice.trim().to_string())
            .filter(|voice| !voice.is_empty())
            .filter(|voice| {
                let there = voices.join(voice).is_file();
                if !there {
                    eprintln!(
                        "no demo recording called {voice} in {}: the sidebar will offer no demo figure",
                        voices.display()
                    );
                }
                there
            })
            // A machine that never set the variable still gets the button: the folder is checked for the first
            // recording, because a clone with a clip in it is a clone that can show a figure speaking.
            .or_else(|| first_recording(&voices));
        let (died_tx, died) = mpsc::unbounded_channel::<String>();
        Avatars {
            voices,
            colleague,
            port,
            running: Mutex::new(HashMap::new()),
            demo_name,
            demo_voice,
            rolls: Mutex::new(seed()),
            died_tx,
            died: tokio::sync::Mutex::new(died),
        }
    }

    /// What the one demo figure is: its name, and the recording it speaks if this server has one.
    pub(crate) fn demo(&self) -> (String, Option<String>) {
        (self.demo_name.clone(), self.demo_voice.clone())
    }

    /// Put the one demo figure on the floor, or send it home. Deliberately narrow: one name, one recording, and
    /// no list to choose from — the sidebar's whole test affordance is a button that goes on and off.
    pub(crate) fn demo_guest(&self, world: &mut World, on: bool) -> Result<(), NoAvatar> {
        let voice = self.demo_voice.clone().ok_or_else(|| {
            NoAvatar::NoRecording(
                "this server has no demo recording — set OFFICE_MUMBLE_DEMO_VOICE to one of its recordings"
                    .to_string(),
            )
        })?;
        if on {
            // Every press is another figure, at the next stop nobody stands on: one listener can hear a whole
            // building without running between floors.
            let mut count = 1;
            let mut name = self.demo_name.clone();
            while self.taken(&name) {
                count += 1;
                name = format!("{} {count}", self.demo_name);
            }
            self.make(world, &name, Some(&voice))
        } else {
            // Off takes the whole family home, not just the first: the button is the test, and the test ends
            // when it says so.
            let names: Vec<String> = self
                .running
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .keys()
                .filter(|name| *name == &self.demo_name || name.starts_with(&format!("{} ", self.demo_name)))
                .cloned()
                .collect();
            if names.is_empty() {
                return Err(NoAvatar::Taken(format!("{} is not here", self.demo_name)));
            }
            for name in names {
                let _ = self.send_home(world, &name);
            }
            Ok(())
        }
    }

    /// The routes this module answers, ready to be joined to the server's own.
    pub fn routes() -> Router<Hub> {
        Router::new()
            .route("/avatars", get(listed).post(make))
            .route("/avatars/voices", get(voices))
            .route("/avatars/{name}", axum::routing::delete(send_home))
    }

    /// The recordings, by file name, in the order the file system gives them.
    pub(crate) fn recordings(&self) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(&self.voices)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.path().is_file())
                    .filter(|entry| {
                        entry.path().extension().is_some_and(|kind| kind.eq_ignore_ascii_case("wav"))
                    })
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        found.sort();
        found
    }

    /// What exists right now, with the id of each figure resolved against the floor: a speaking avatar is a
    /// client of its own, so which person it is only shows once it has joined.
    fn entries(&self, world: &World) -> Vec<Entry> {
        let running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        let mut entries: Vec<Entry> = running
            .iter()
            .map(|(name, avatar)| Entry {
                name: name.clone(),
                id: avatar.id.or_else(|| world.id_of(name)),
                kind: if avatar.voice.is_some() { "speaking" } else { "walking" },
                voice: avatar.voice.clone(),
            })
            .collect();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        entries
    }
}

/// Where each avatar is, told to whoever asks: the sidebar draws this, and it is also how a wander is visible
/// from outside.
fn tell(world: &World, entries: Vec<Entry>) -> Vec<Told> {
    entries
        .into_iter()
        .map(|entry| {
            let place = entry.id.and_then(|id| world.place(id));
            Told {
                name: entry.name,
                kind: entry.kind,
                voice: entry.voice,
                on_floor: place.is_some(),
                x: place.map(|(x, _, _)| x).unwrap_or_default(),
                y: place.map(|(_, y, _)| y).unwrap_or_default(),
                walking: place.map(|(_, _, standing)| !standing).unwrap_or_default(),
            }
        })
        .collect()
}

async fn listed(State(hub): State<Hub>) -> Json<Vec<Told>> {
    let world = hub.world().lock().await;
    let entries = hub.avatars().entries(&world);
    Json(tell(&world, entries))
}

async fn voices(State(hub): State<Hub>) -> Json<Vec<String>> {
    Json(hub.avatars().recordings())
}

/// Make an avatar. A name already taken is refused: two figures with one name are two figures nobody can tell apart.
async fn make(State(hub): State<Hub>, Json(wanted): Json<Wanted>) -> Response {
    let mut world = hub.world().lock().await;
    match hub.avatars().make(&mut world, wanted.name.as_deref().unwrap_or_default(), wanted.voice.as_deref()) {
        Ok(()) => {
            let entries = hub.avatars().entries(&world);
            (StatusCode::CREATED, Json(tell(&world, entries))).into_response()
        }
        // What went wrong matters to a caller: a name that is taken is 409, a recording that is not there is
        // 400, and a machine that cannot speak at all is 503 — nothing the caller did.
        Err(NoAvatar::Taken(why)) => (StatusCode::CONFLICT, why).into_response(),
        Err(NoAvatar::NoRecording(why)) => (StatusCode::BAD_REQUEST, why).into_response(),
        Err(NoAvatar::CannotSpeak(why)) => (StatusCode::SERVICE_UNAVAILABLE, why).into_response(),
    }
}

/// Send one home: the process behind a speaking avatar is ended, which is what closes its connection, and a
/// walking one is taken off the floor directly.
async fn send_home(State(hub): State<Hub>, UrlPath(name): UrlPath<String>) -> Response {
    let mut world = hub.world().lock().await;
    match hub.avatars().send_home(&mut world, &name) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(why) => (StatusCode::NOT_FOUND, why).into_response(),
    }
}

/// Why an avatar could not be made. Three different answers to a caller, so the two doors into this module —
/// the socket and the plain request — can both say which one it was.
pub(crate) enum NoAvatar {
    Taken(String),
    NoRecording(String),
    CannotSpeak(String),
}

impl NoAvatar {
    /// What to tell whoever asked.
    pub(crate) fn said(&self) -> String {
        match self {
            NoAvatar::Taken(why) | NoAvatar::NoRecording(why) | NoAvatar::CannotSpeak(why) => why.clone(),
        }
    }
}

impl Avatars {
    /// Make an avatar on the floor. A walking one is a person the world puts down; a speaking one is the
    /// colleague program, which joins as a client of its own and is marked when it arrives.
    pub(crate) fn make(&self, world: &mut World, name: &str, voice: Option<&str>) -> Result<(), NoAvatar> {
        let name = name.trim();
        if name.is_empty() {
            return Err(NoAvatar::Taken("a figure wants a name".to_string()));
        }
        if self.taken(name) {
            return Err(NoAvatar::Taken(format!("{name} is already here")));
        }
        match voice {
            Some(voice) => {
                if !self.recordings().iter().any(|known| known == voice) {
                    return Err(NoAvatar::NoRecording(format!("no recording called {voice}")));
                }
                let (floor, stop, at) = self.free_stop(world);
                self.speak(name, voice, (floor, stop, at)).map_err(NoAvatar::CannotSpeak)
            }
            None => {
                // First stop of the round nobody is standing on: the figures spread out over the building
                // instead of all starting at the same door and walking in each other's footsteps.
                let (floor, start, at) = self.free_stop(world);
                let id = world.join_on(name.to_string(), floor, at).0;
                world.mark_avatar(id);
                self.walking_at(name, id, start);
                Ok(())
            }
        }
    }

    /// Send an avatar home: the process behind a speaking one is ended, which is what closes its connection,
    /// and a walking one is taken off the floor here.
    pub(crate) fn send_home(&self, world: &mut World, name: &str) -> Result<(), String> {
        match self.gone(name) {
            Some(Some(id)) => {
                world.depart(id);
                Ok(())
            }
            Some(None) => Ok(()),
            None => Err(format!("no avatar called {name}")),
        }
    }

    /// Whether an avatar answers to this name. Asked when somebody joins under it, so the person that arrives
    /// is marked as the figure it is.
    pub(crate) fn taken(&self, name: &str) -> bool {
        self.running.lock().unwrap_or_else(|p| p.into_inner()).contains_key(name)
    }

    fn walking_at(&self, name: &str, id: u64, stop: usize) {
        self.running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(name.to_string(), Avatar { id: Some(id), voice: None, end: None, stop, at: None });
    }

    /// The round moves on: the figure has reached its stop and looks at the next one.
    pub(crate) fn advance(&self, name: &str) {
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(avatar) = running.get_mut(name) {
            avatar.stop = avatar.stop.wrapping_add(1);
        }
    }

    /// Where in the round a figure is going next, if it is still here.
    fn stop_of(&self, name: &str) -> Option<usize> {
        self.running.lock().unwrap_or_else(|p| p.into_inner()).get(name).map(|avatar| avatar.stop)
    }

    /// The place a speaking figure was given before it joined, if it has not joined yet.
    pub(crate) fn reserved(&self, name: &str) -> Option<(usize, (f32, f32))> {
        self.running.lock().unwrap_or_else(|p| p.into_inner()).get(name).and_then(|avatar| avatar.at)
    }

    pub(crate) fn set_stop(&self, name: &str, stop: usize) {
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(avatar) = running.get_mut(name) {
            avatar.stop = stop;
        }
    }

    /// The first stop of the round nobody stands on: where a new figure is put down. A speaking avatar is a
    /// client of its own, so its join is the moment this is decided — not the press that started it.
    pub(crate) fn free_stop(&self, world: &World) -> (usize, usize, (f32, f32)) {
        let stops = world.route();
        // A place is a place on a floor: two figures on the same cell on different floors are not in each
        // other's way, and a round that crosses floors would otherwise burn a stop on every crossing.
        let taken: Vec<(usize, f32, f32)> = {
            let running = self.running.lock().unwrap_or_else(|p| p.into_inner());
            running
                .values()
                .filter_map(|avatar| avatar.id.map(|id| (world.floor_of(id), id)))
                .filter_map(|(floor, id)| world.place(id).map(|(x, y, _)| (floor, x, y)))
                .chain(running.values().filter_map(|avatar| avatar.at.map(|(floor, (x, y))| (floor, x, y))))
                .collect()
        };
        let free = stops.iter().enumerate().find(|(_, (floor, (x, y)))| {
            taken.iter().all(|(other, tx, ty)| other != floor || (tx - x).hypot(ty - y) > 1.0)
        });
        match free {
            Some((index, (floor, at))) => (*floor, index, *at),
            None => {
                let (floor, at) = world.arrival();
                (floor, 0, at)
            }
        }
    }

    /// Start the colleague for a speaking avatar. It joins like any client, and the world prints it joining.
    /// A task of its own watches the process: whatever ends it — a crash, a kill, its own time running out —
    /// the office hears about it in the same moment, not on the next look.
    fn speak(&self, name: &str, voice: &str, at: (usize, usize, (f32, f32))) -> Result<(), String> {
        let (floor, stop, point) = at;
        let program = self
            .colleague
            .clone()
            .ok_or("nothing can speak here: the colleague program is not built — `cargo build -p office-mumble-colleague`")?;
        let recording = self.voices.join(voice);
        let mut command = Command::new(&program);
        command
            .arg("--name")
            .arg(name)
            .arg("--server")
            .arg(format!("wss://127.0.0.1:{}/ws", self.port))
            .arg("--cert")
            .arg(crate::tls::cert_dir().join("cert.pem"))
            .arg("--voice")
            .arg(&recording)
            .arg("--seconds")
            .arg(FOR_A_DAY)
            // Its own lines are a counter per second, which would bury the office's; its complaints are worth
            // seeing in the console that started it.
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            // A colleague is the server's child in the strict sense: if this process ends, so does it.
            .kill_on_drop(true);
        #[cfg(target_os = "linux")]
        // The kernel ends the child when the parent goes, which no amount of care in the parent can do for a
        // kill it never got to handle.
        unsafe {
            command.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|problem| format!("{} could not be started: {problem}", program.display()))?;
        let (end, ended) = oneshot::channel::<()>();
        let died = self.died_tx.clone();
        let named = name.to_string();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = ended => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
            let _ = died.send(named);
        });
        self.running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(name.to_string(), Avatar { id: None, voice: Some(voice.to_string()), end: Some(end), stop, at: Some((floor, point)) });
        Ok(())
    }

    /// Take an avatar out of the books. `Some(Some(id))` is a walking avatar whose person the caller has to
    /// take off the floor; `Some(None)` is a speaking one, whose process ends and whose connection closing is
    /// what leaves the floor.
    fn gone(&self, name: &str) -> Option<Option<u64>> {
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        let avatar = running.remove(name)?;
        if let Some(end) = avatar.end {
            // The task that owns the process does the killing and the waiting; this only says it is time.
            let _ = end.send(());
        }
        Some(avatar.id)
    }

    /// A speaking avatar's process has ended: said once, by the task that was watching it.
    pub(crate) fn report_death(&self, name: String) {
        let _ = self.died_tx.send(name);
    }

    /// The next speaking avatar whose process has ended. Awaited by the office, which puts the figure away.
    pub(crate) async fn next_death(&self) -> Option<String> {
        self.died.lock().await.recv().await
    }

    /// Take a name out of the books without touching its process: it has already ended.
    pub(crate) fn forget(&self, name: &str) {
        self.running.lock().unwrap_or_else(|p| p.into_inner()).remove(name);
    }

    /// A number to wander by: the clock, walked forward once per roll.
    fn roll(&self, up_to: usize) -> usize {
        let mut rolls = self.rolls.lock().unwrap_or_else(|p| p.into_inner());
        *rolls = rolls.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*rolls >> 33) as usize) % up_to.max(1)
    }
}

pub async fn hear_forever(hub: Hub) {
    loop {
        let Some(name) = hub.avatars().next_death().await else { return };
        hub.avatars().forget(&name);
        let mut world = hub.world().lock().await;
        let Some(id) = world.person_named(&name) else { continue };
        for out in world.depart(id) {
            if let crate::world::Outbound::Everybody(message) = out {
                hub.announce(&message);
            }
        }
    }
}

/// Somewhere for each avatar to go, now and then — the coffee, the fridge, a table, the sofa, never a random
/// cell. A figure that crosses the room at random is a screensaver; one that keeps finding the coffee is a
/// colleague. One already on its way is left alone, and a place is kept only if the floor really has a way
/// there.
pub async fn wander_forever(hub: Hub) {
    loop {
        tokio::time::sleep(WANDER_EVERY).await;
        let mut world = hub.world().lock().await;
        let route = world.route();
        if route.is_empty() {
            continue;
        }
        for entry in hub.avatars().entries(&world) {
            let Some(id) = entry.id else { continue };
            let Some((x, y, standing)) = world.place(id) else { continue };
            // On the way somewhere already: a walk, not a drumbeat.
            if !standing {
                continue;
            }
            let Some(stop) = hub.avatars().stop_of(&entry.name) else { continue };
            let (stop_floor, (to_x, to_y)) = route[stop % route.len()];
            let floor = world.floor_of(id);
            // The next stop is another floor: the stair is the only way, and stepping on its last tread is
            // what carries the figure up. No click, no teleport — the same rule as for anybody else.
            if stop_floor != floor {
                if let Some((stair_x, stair_y)) = world.stair_exit(floor) {
                    if (stair_x - x).hypot(stair_y - y) > 0.4 {
                        let _ = world.handle(id, FromClient::Walk { x: stair_x, y: stair_y });
                    }
                }
                continue;
            }
            if (to_x - x).hypot(to_y - y) < 0.9 {
                hub.avatars().advance(&entry.name);
                continue;
            }
            if world.can_walk(floor, (x, y), (to_x, to_y)) {
                // The way there was just checked, so there is nothing to answer: a walk that failed would
                // come back as `NoWay`, and that is the one thing a wander must not do.
                let _ = world.handle(id, FromClient::Walk { x: to_x, y: to_y });
            } else {
                // A stop behind a shut door is skipped: a round that stopped dead there would leave the
                // figure standing in front of it for the rest of the evening.
                hub.avatars().advance(&entry.name);
            }
        }
    }
}

/// The colleague program as it is built beside this server. `EXE_SUFFIX` matters: without it a Windows server
/// never finds the `colleague.exe` built right beside it.
fn find_colleague() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let target = exe.parent()?.parent()?;
    // What the program is called where this server was built: `colleague` on unix, `colleague.exe` on Windows,
    // which is what `EXE_SUFFIX` says — without it a server on Windows never finds the colleague that was built
    // right beside it, and every speaking figure reports that none was built.
    let name = format!("colleague{}", std::env::consts::EXE_SUFFIX);
    ["debug", "release"].iter().map(|profile| target.join(profile).join(&name)).find(|path| path.is_file())
}

/// A setting from the environment, or its default.
fn setting(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn seed() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_nanos() as u64).unwrap_or(0x2545F4914F6CDD1D)
}

#[cfg(test)]
mod tests {
    use super::*;
    use office_mumble_wire::PlanFile;

    #[test]
    fn a_folder_with_a_recording_offers_the_figure_without_being_told() {
        let folder = std::env::temp_dir().join("office-mumble-voices-one");
        std::fs::create_dir_all(&folder).expect("a place to put a clip");
        std::fs::write(folder.join("werbung.wav"), b"RIFF").expect("a clip");
        std::fs::write(folder.join("notes.txt"), b"not a clip").expect("a file that is not one");
        assert_eq!(first_recording(&folder).as_deref(), Some("werbung.wav"));
        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn a_folder_without_a_recording_offers_nothing() {
        let folder = std::env::temp_dir().join("office-mumble-voices-none");
        std::fs::create_dir_all(&folder).expect("a place");
        std::fs::write(folder.join("notes.txt"), b"not a clip").expect("a file that is not one");
        assert_eq!(first_recording(&folder), None);
        std::fs::remove_dir_all(&folder).ok();
    }

    const ROUND: &str = r#"{
  "version": 1, "cell_m": 0.5,
  "floors": [
    { "name": "Ground", "surface": "parquet",
      "cells": [["wall","wall","wall","wall","wall"],["wall","floor","floor","floor","wall"],["wall","floor","floor","floor","wall"],["wall","wall","wall","wall","wall"]],
      "labels": [{"text":"Kitchen","row":1,"col":1},{"text":"Desk","row":2,"col":3}],
      "stairs": [{"row":2,"col":3,"rows":1,"cols":1,"exits":"east","to":1}] },
    { "name": "Up", "surface": "parquet",
      "cells": [["wall","wall","wall","wall","wall"],["wall","floor","floor","floor","wall"],["wall","floor","floor","floor","wall"],["wall","wall","wall","wall","wall"]],
      "labels": [{"text":"Meeting","row":1,"col":1},{"text":"Quiet","row":2,"col":1}],
      "stairs": [{"row":2,"col":3,"rows":1,"cols":1,"exits":"east","to":0}] }
  ]
}"#;

    #[tokio::test]
    async fn a_death_is_reported_in_the_order_it_happened() {
        let avatars = Avatars::new(0);
        avatars.report_death("First".into());
        avatars.report_death("Second".into());
        assert_eq!(avatars.next_death().await.as_deref(), Some("First"));
        assert_eq!(avatars.next_death().await.as_deref(), Some("Second"));
    }

    #[tokio::test]
    async fn a_second_figure_is_put_down_at_another_stop_of_the_round() {
        let mut world = World::new(PlanFile::parse(ROUND).unwrap(), "round".to_string());
        let avatars = Avatars::new(0);

        assert!(avatars.make(&mut world, "first", None).is_ok(), "the first figure is made");
        assert!(avatars.make(&mut world, "second", None).is_ok(), "the second figure is made");

        let first = world.id_of("first").unwrap();
        let second = world.id_of("second").unwrap();
        let a = world.place(first).unwrap();
        let b = world.place(second).unwrap();
        // Two stops of the same round may share a cell across floors — a figure upstairs is not in the way of
        // one downstairs — so the floor counts too.
        assert!(
            world.floor_of(first) != world.floor_of(second) || (a.0 - b.0).hypot(a.1 - b.1) > 1.0,
            "the second figure does not stand where the first one stands"
        );
    }
}
