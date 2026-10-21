//! A colleague with no window: the office protocol spoken from a terminal, carrying the same hearing rule the
//! browser client uses, so the two hosts cannot drift. Not the client, and nothing in `crates/` refers to it —
//! delete this directory and the office does not notice. It carries real Opus out of a generated tone, decodes
//! what arrives and counts it, so a run produces numbers rather than a claim that something connected.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::io::Write;
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use audiopus::coder::Encoder;
use futures_util::{SinkExt, StreamExt};
use office_mumble_hearing::{within, Person as Ears};
use office_mumble_voice::{ear, mouth, FRAME};
use office_mumble_wire::{FromClient, Grid, PersonView, ToClient};
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_OPUS, MediaEngine};
use rtc::peer_connection::transport::RTCIceCandidateInit;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::media_stream::Track;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCPeerConnectionIceEvent,
    RTCPeerConnectionState, Registry,
};
use webrtc::rtp_transceiver::RtpSender;
use webrtc::runtime::{default_runtime, Runtime};

/// The SSRC every colleague sends under, written down so a packet can be traced in a capture.
const SSRC: u32 = 0x0FF1CE;

/// `NEW` and `DEAD` are told apart deliberately: a link that never came up is not one that fell over, and only
/// the second is torn down so the rule can try again.
const NEW: u8 = 0;
const UP: u8 = 1;
const DEAD: u8 = 2;

/// How long a connection survives once its peer stops being audible by movement — the same number as `voice.ts`.
const GRACE: Duration = Duration::from_millis(4_000);

/// A handshake is a handful of messages; anybody sending more while they wait is not shaking hands. The same
/// bound `voice.ts` keeps.
const HELD_MAX: usize = 64;

/// How long to wait before trying the office door again after the socket closes. The browser client waits
/// the same 1.5 s, and a colleague whose server blinks should come back without being told.
const RETRY: Duration = Duration::from_millis(1_500);

/// The browser's `setTargetAtTime(level, now, 0.08)` applied once per 20 ms frame, written down so both hosts
/// produce the same fade.
const FADE_PER_FRAME: f32 = 0.221_2; // 1 - exp(-0.020 / 0.08)

/// How long, in seconds, to run when `--seconds` is not given.
const DEFAULT_SECONDS: u64 = 20;

type AnyError = Box<dyn StdError>;

#[tokio::main]
async fn main() -> Result<(), AnyError> {
    let args = match parse_args() {
        Ok(args) => args,
        Err(problem) => {
            eprintln!("colleague: {problem}");
            std::process::exit(2);
        }
    };

    // The office signs its own certificate, so this trusts exactly that one — the same public half the browser
    // is told to install — and nothing else. Not a verifier that accepts anything: see `trust`.
    rustls::crypto::ring::default_provider().install_default().ok();
    let tls = Arc::new(trust(&args.cert).map_err(|message| -> AnyError { message.into() })?);
    println!("trusting {cert}", cert = args.cert);

    // Everything the WebRTC side wants to say leaves through this one queue: signalling is generated both by
    // the main loop and by the connection callbacks, and two writers on one socket would interleave frames.
    // The run loop below is also the only writer, so a socket that has to be replaced needs no second task.
    let (out, mut out_rx) = mpsc::unbounded_channel::<String>();

    let runtime = default_runtime().ok_or("the webrtc crate was built without an async runtime")?;
    // What the microphone would carry: a recording when one is named, the generated tone otherwise. The
    // recording loops, exactly as the harness page loops it.
    let source = match &args.voice {
        Some(path) => {
            let samples = read_wav(path).map_err(|message| -> AnyError { message.into() })?;
            println!("speaking {path}: {} samples at 48 kHz", samples.len());
            Source::Clip { samples, at: 0 }
        }
        None => Source::Tone { phase: 0.0 },
    };
    let mut session = Session {
        out: out.clone(),
        runtime,
        plan: None,
        me: None,
        links: HashMap::new(),
        hearing: HashMap::new(),
        seen: 0,
        nearest: f32::MAX,
        waiting: HashMap::new(),
        mouth: mouth()?,
        buffer: [0u8; 512],
        source,
        at: args.at,
        walks: args.walks.clone(),
        sent_walks: 0,
        doors: args.doors.clone(),
        sent_doors: 0,
        mixer: Mixer::new(),
        heard_sum: 0.0,
        heard_blocks: 0,
        heard_life_sum: 0.0,
        heard_life_blocks: 0,
        said_speaking: false,
    };

    let started = Instant::now();
    let deadline = tokio::time::sleep(Duration::from_secs(args.seconds));
    tokio::pin!(deadline);
    // Delay, not the default burst: a socket that had to be replaced leaves the timers unpolled for a moment,
    // and a burst of catch-up ticks would print a run's worth of lines at once and hand a clump of frames to
    // the encoder.
    let mut frame_tick = tokio::time::interval(Duration::from_millis(20));
    frame_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    status_tick.tick().await; // an interval fires at once; the first line belongs one second in.

    // The socket is not the session: a colleague whose server blinks rejoins when the door opens again, the
    // same 1.5 s the browser client waits. The plan and a fresh id arrive with the new socket, and the rule
    // then decides afresh who is worth a connection — the ids the server hands out are new ones, so links are
    // made again rather than kept. The connections between two colleagues were never the server's to give.
    let mut running = true;
    while running {
        let socket = match tokio_tungstenite::connect_async_tls_with_config(
            args.server.as_str(),
            None,
            false,
            Some(Connector::Rustls(Arc::clone(&tls))),
        )
        .await
        {
            Ok((socket, _)) => socket,
            Err(problem) => {
                eprintln!("colleague: cannot reach {}: {problem}", args.server);
                tokio::select! {
                    _ = &mut deadline => running = false,
                    _ = tokio::time::sleep(RETRY) => {}
                }
                continue;
            }
        };
        let (mut sink, mut stream) = socket.split();
        out.send(FromClient::Join { name: args.name.clone(), seat: None }.to_text())?;
        // A new socket is a new person on the server's roster, and it knows nothing about this one yet, so what
        // I say about myself starts over — otherwise a ring would hang on a figure after a floor blinks.
        session.said_speaking = false;

        let mut gap = false;
        while !gap {
            tokio::select! {
                _ = &mut deadline => { running = false; gap = true; }
                _ = status_tick.tick() => session.report(started.elapsed(), false),
                _ = frame_tick.tick() => {
                    session.walk_if_due(started.elapsed());
                    session.doors_if_due(started.elapsed());
                    session.send_frame().await;
                    session.flush();
                }
                Some(text) = out_rx.recv() => {
                    if sink.send(Message::text(text)).await.is_err() {
                        gap = true;
                    }
                }
                incoming = stream.next() => match incoming {
                    Some(Ok(Message::Text(text))) => session.handle(text.as_str()).await?,
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            session.handle(text).await?;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => gap = true,
                    Some(Ok(_)) => {}
                    Some(Err(problem)) => {
                        eprintln!("colleague: the socket failed: {problem}");
                        gap = true;
                    }
                },
            }
        }

        if running {
            eprintln!("colleague: the socket closed; trying again in 1.5 s");
            tokio::select! {
                _ = &mut deadline => running = false,
                _ = tokio::time::sleep(RETRY) => {}
            }
        }
    }

    session.report(started.elapsed(), true);
    Ok(())
}

struct Args {
    name: String,
    seconds: u64,
    server: String,
/// The office's own certificate, PEM. Never a verifier that accepts anything: a colleague holds a microphone.
    cert: String,
    /// A recording to speak instead of the generated tone, so a run sounds like a colleague rather than a
    /// beep and its bytes are the shaped ones Opus spends fewer bits on.
    voice: Option<String>,
    /// A place to walk to as soon as we are in, so a test can put two colleagues where it wants them.
    at: Option<(f32, f32)>,
    /// `x,y@seconds` — walk somewhere mid-run, for the cases only movement can produce.
    walks: Vec<(f32, f32, u64)>,
    /// `row,col@seconds` — work the door at that cell, sending the wire's own `ToggleDoor`, for the case
    /// only a door can produce: two colleagues on either side of it going quiet and coming back. Repeatable,
    /// and each fires once. The coordinates are the plan's own, row first, exactly as `toggle_door` takes
    /// them, so what is written here is what goes over the wire.
    doors: Vec<(usize, usize, u64)>,
}

fn parse_args() -> Result<Args, String> {
    let mut name = None;
    let mut seconds = DEFAULT_SECONDS;
    let mut server = "wss://127.0.0.1:8787/ws".to_string();
    let mut cert = None;
    let mut voice = None;
    let mut at = None;
    let mut walks = Vec::new();
    let mut doors = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{flag} wants a value"));
        match flag.as_str() {
            "--name" => name = Some(value()?),
            "--seconds" => seconds = value()?.parse().map_err(|_| "--seconds wants a number")?,
            "--server" => server = value()?,
            "--cert" => cert = Some(value()?),
            "--voice" => voice = Some(value()?),
            "--at" => at = Some(point(&value()?)?),
            "--walk" => walks.push(at_time(&value()?)?),
            "--door" => doors.push(door_at_time(&value()?)?),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args {
        name: name.ok_or("--name is required")?,
        seconds,
        server,
        cert: cert.ok_or(
            "--cert is required: the office signs its own certificate, so a colleague is handed its public \
             half instead of trusting anything (the harness always passes it)",
        )?,
        voice,
        at,
        walks,
        doors,
    })
}

fn point(text: &str) -> Result<(f32, f32), String> {
    let (x, y) = text.split_once(',').ok_or_else(|| format!("{text} is not x,y"))?;
    Ok((
        x.trim().parse().map_err(|_| format!("{x} is not a number"))?,
        y.trim().parse().map_err(|_| format!("{y} is not a number"))?,
    ))
}

fn at_time(text: &str) -> Result<(f32, f32, u64), String> {
    let (place, when) = text.split_once('@').ok_or_else(|| format!("{text} is not x,y@seconds"))?;
    let (x, y) = point(place)?;
    Ok((x, y, when.trim().parse().map_err(|_| format!("{when} is not a number"))?))
}

/// `row,col@seconds` — work the door at that cell, sending the wire's own `ToggleDoor`, for the case only a door
/// can produce. Row first, exactly as `toggle_door` takes it.
fn door_at_time(text: &str) -> Result<(usize, usize, u64), String> {
    let (place, when) = text.split_once('@').ok_or_else(|| format!("{text} is not row,col@seconds"))?;
    let (row, col) = place.split_once(',').ok_or_else(|| format!("{place} is not row,col"))?;
    Ok((
        row.trim().parse().map_err(|_| format!("{row} is not a row number"))?,
        col.trim().parse().map_err(|_| format!("{col} is not a column number"))?,
        when.trim().parse().map_err(|_| format!("{when} is not a number"))?,
    ))
}

/// The tallies one connection is judged by. Atomics because the receive side is counted by a task the peer
/// connection spawns, not by the main loop.
#[derive(Default)]
struct Counters {
    out_packets: AtomicU64,
    out_bytes: AtomicU64,
    in_packets: AtomicU64,
    in_bytes: AtomicU64,
    /// Received packets that decoded to exactly one 20 ms frame — the claim the number is meant to make.
    decoded: AtomicU64,
    /// Received packets that decoded, but to some other length. Counted apart so a surprise is visible.
    decoded_odd: AtomicU64,
    undecodable: AtomicU64,
}

/// Where the streams I can hear are added up, each already at the rule's level. A headless host has no speakers,
/// so the mix is read out as its energy: the only way this half of the rule can be shown rather than asserted.
#[derive(Clone)]
struct Mixer {
    block: Arc<Mutex<[f32; FRAME]>>,
}

impl Mixer {
    fn new() -> Self {
        Mixer { block: Arc::new(Mutex::new([0.0; FRAME])) }
    }

    /// Adds one decoded frame at `gain`. A poisoned lock is not a reason to drop somebody's voice.
    fn add(&self, gain: f32, samples: &[i16]) {
        let mut block = self.block.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (slot, sample) in block.iter_mut().zip(samples) {
            *slot += gain * (*sample as f32 / 32_768.0);
        }
    }

    /// The loudness of the last 20 ms, and the block is cleared for the next one.
    fn take_rms(&self) -> f32 {
        let mut block = self.block.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let energy: f32 = block.iter().map(|value| value * value).sum();
        block.fill(0.0);
        (energy / FRAME as f32).sqrt()
    }
}

/// One connection to one audible peer, with everything the hearing rule has to say about it.
struct Link {
    pc: Arc<dyn PeerConnection>,
    sender: Arc<dyn RtpSender>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
    /// The payload type and SSRC have been read back from the negotiated sender — once, when first up.
    ready: bool,
    /// How loud they are to me right now. Zero is a connection that is open and quiet.
    level: f32,
    /// The same level in a cell the receive task can read: the main loop learns the level, the task applies
    /// it as gain, and the two need not touch.
    level_cell: Arc<AtomicU32>,
    /// The audible gain, chased towards `level` rather than set to it, so the fade matches the browser's.
    fade: f32,
    /// Nobody in earshot any more: counting down to letting go.
    silent_since: Option<Instant>,
    /// The lower id opens, so both sides agree about who offers without asking.
    opens: bool,
    offered: bool,
    answered: bool,
    pending: Vec<RTCIceCandidateInit>,
    /// Three values rather than a flag: a link that never came up is not one that fell over.
    state: Arc<AtomicU8>,
    counters: Arc<Counters>,
}

struct Session {
    out: mpsc::UnboundedSender<String>,
    runtime: Arc<dyn Runtime>,
    plan: Option<Grid>,
    me: Option<u64>,
    links: HashMap<u64, Link>,
    /// Everybody in my area and how loud they are, as the rule said on the last state message.
    hearing: HashMap<u64, f32>,
    /// What the last state said: how many figures it carried, and how far the closest one stood. A colleague
    /// that hears nobody has to be able to say whether nobody was there or the rule said no.
    seen: usize,
    nearest: f32,
    /// Signals from somebody my rule did not hear yet, in the order they came, and since when they wait.
    waiting: HashMap<u64, (Instant, Vec<String>)>,
    mouth: Encoder,
    buffer: [u8; 512],
    source: Source,
    at: Option<(f32, f32)>,
    walks: Vec<(f32, f32, u64)>,
    sent_walks: usize,
    /// Doors to work mid-run, and how many have been worked so far, so each fires once.
    doors: Vec<(usize, usize, u64)>,
    sent_doors: usize,
    /// The sum of what I can hear, and the running loudness of it, read out in the report.
    mixer: Mixer,
    heard_sum: f64,
    heard_blocks: u64,
    heard_life_sum: f64,
    heard_life_blocks: u64,
    /// What the server was last told about whether I am talking. A person says this about themselves, and
    /// without it every colleague's figure stands there with no ring on it while it talks.
    said_speaking: bool,
}

impl Session {
    async fn handle(&mut self, text: &str) -> Result<(), AnyError> {
        let message: ToClient = match serde_json::from_str(text) {
            Ok(message) => message,
            Err(_) => return Ok(()),
        };
        match message {
            ToClient::Plan { id, plan: model } => match model.floor(0) {
                Ok(floor) => {
                    let grid = &floor.cells;
                    println!("plan {id}: {}x{} cells, {} m per cell", grid.width(), grid.height(), model.cell_m);
                    self.plan = Some(grid.clone());
                }
                Err(problem) => eprintln!("colleague: the plan did not parse: {problem}"),
            },
            ToClient::Hello { id, name } => {
                println!("joined as {id} ({name})");
                self.me = Some(id);
                if let Some((x, y)) = self.at {
                    self.walk(x, y);
                }
            }
            ToClient::State { people } => self.presence(people).await?,
            ToClient::NoWay { x, y } => println!("the floor has no way to ({x}, {y})"),
            ToClient::Introduction { from } => println!("{from} wants to talk"),
            ToClient::Signal { from, payload } => self.signal(from, &payload).await,
            // The editor's business, not a colleague's: nothing here edits the building.
            ToClient::Lock { .. } | ToClient::Refused { .. } => {}
            // A call from across the room: a colleague program has no opinions, so it always comes.
            ToClient::Summoned { from, name } => {
                println!("{name} asks me to come over");
                let _ = self.out.send(FromClient::AnsweredSummon { from, accept: true }.to_text());
            }
            ToClient::SummonAnswer { .. } => {}
            // Which recordings exist here — said to everybody on arrival, and worth saying back, so a run's log
            // shows what a figure could have been given. A refusal is only ever sent to whoever asked for a
            // figure, which is never a colleague; it is printed all the same rather than swallowed.
            ToClient::Voices { names } => println!("{} recordings here: {}", names.len(), names.join(", ")),
            ToClient::AvatarProblem { why } => println!("a test figure was refused: {why}"),
            // What the sidebar offers as its one demo figure. A colleague is a voice of its own, so this is
            // only said out loud — it is the office's business, not this program's.
            ToClient::Demo { name, voice } => match voice {
                Some(voice) => println!("the demo figure here is {name}, speaking {voice}"),
                None => println!("the demo figure here is {name}, with no recording set up"),
            },
        }
        Ok(())
    }

    /// Once per state message: ask the rule who I can hear, and make the connections say the same thing.
    async fn presence(&mut self, people: Vec<PersonView>) -> Result<(), AnyError> {
        let (Some(plan), Some(me)) = (self.plan.as_ref(), self.me) else {
            return Ok(());
        };
        let Some(mine) = people.iter().find(|p| p.id == me) else {
            return Ok(());
        };
        let everybody: Vec<Ears> = people.iter().map(|p| Ears { id: p.id, x: p.x, y: p.y }).collect();
        let nearby: HashMap<u64, f32> =
            within(plan, Ears { id: me, x: mine.x, y: mine.y }, &everybody)
                .into_iter()
                .map(|heard| (heard.id, heard.level))
                .collect();
        self.hearing = nearby.clone();
        self.seen = people.len();
        self.nearest = everybody
            .iter()
            .filter(|p| p.id != me)
            .map(|p| ((p.x - mine.x).powi(2) + (p.y - mine.y).powi(2)).sqrt())
            .fold(f32::MAX, f32::min);

        // What waited for the rule: answered once it hears them, dropped when they are not in my area or still out
        // of earshot after the grace — the same as `voice.ts`.
        let now = Instant::now();
        let mut released = Vec::new();
        self.waiting.retain(|from, (since, payloads)| match nearby.get(from) {
            Some(level) if *level > 0.0 => {
                released.push((*from, std::mem::take(payloads)));
                false
            }
            Some(_) => now.duration_since(*since) <= GRACE,
            None => false,
        });
        for (from, payloads) in released {
            for payload in payloads {
                self.signal(from, &payload).await;
            }
        }

        // Gone from my area is a wall or a shut door — deliberate, so it cuts at once. In my area but quiet is
        // somebody who walked away, and that keeps its connection for the grace, silent.
        let mut leaving = Vec::new();
        for (id, link) in &self.links {
            if link.state.load(Ordering::Acquire) == DEAD {
                // It never recovered on its own and the browser client does not wait either: drop it, and the
                // loop below builds a new one if they are still audible — which is the only way a blip heals.
                leaving.push(*id);
            } else if !nearby.contains_key(id) {
                leaving.push(*id);
            } else if let Some(since) = link.silent_since {
                if now.duration_since(since) > GRACE {
                    leaving.push(*id);
                }
            }
        }
        for id in leaving {
            self.close(id).await;
        }

        // A connection for somebody audible only. Nearby-but-quiet is in `nearby` with level zero on purpose —
        // that is how walking away is told from a door — and connecting them would mean opening and closing a
        // link on every tick, forever.
        let seen: Vec<(u64, f32)> = nearby.into_iter().collect();
        for (id, level) in seen {
            if level <= 0.0 && !self.links.contains_key(&id) {
                continue;
            }
            if !self.links.contains_key(&id) {
                self.open(id).await;
            }
            let Some(link) = self.links.get_mut(&id) else {
                continue;
            };
            link.level = level;
            link.silent_since = if level > 0.0 { None } else { link.silent_since.or(Some(now)) };
            let offer_now = level > 0.0 && link.opens && !link.offered;
            if offer_now {
                self.offer(id).await;
            }
        }
        Ok(())
    }

    /// Builds the connection to one peer: the local track goes in before any description, so the answer can
    /// say `sendrecv` and audio can leave this process too.
    async fn open(&mut self, id: u64) {
        let counters = Arc::new(Counters::default());
        let state = Arc::new(AtomicU8::new(NEW));
        let level_cell = Arc::new(AtomicU32::new(0));
        let callback = Arc::new(Callback {
            to: id,
            out: self.out.clone(),
            state: Arc::clone(&state),
            counters: Arc::clone(&counters),
            mixer: self.mixer.clone(),
            level_cell: Arc::clone(&level_cell),
        });
        let (media_engine, registry) = engine();
        let pc = PeerConnectionBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_runtime(Arc::clone(&self.runtime))
            .with_handler(callback)
            // Bound to every interface: a peer on the same machine may reach this over the loopback or the LAN
            // address, and the one it picks must be listening.
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await;
        let pc: Arc<dyn PeerConnection> = match pc {
            Ok(pc) => Arc::new(pc),
            Err(problem) => {
                eprintln!("colleague: the connection to {id} did not build: {problem}");
                return;
            }
        };
        let me = self.me.unwrap_or(0);
        let track = match TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "office".to_owned(),
                format!("voice-{id}"),
                format!("colleague-{me}"),
                RtpCodecKind::Audio,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(SSRC), ..Default::default() },
                    codec: opus().rtp_codec,
                    ..Default::default()
                }],
            ),
        ) {
            Ok(track) => Arc::new(track),
            Err(problem) => {
                eprintln!("colleague: the track for {id} did not build: {problem}");
                return;
            }
        };
        let sender = match pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>).await {
            Ok(sender) => sender,
            Err(problem) => {
                eprintln!("colleague: the track for {id} was not added: {problem}");
                return;
            }
        };
        self.links.insert(
            id,
            Link {
                pc,
                sender,
                track,
                ssrc: SSRC,
                payload_type: 120,
                ready: false,
                level: 0.0,
                level_cell,
                fade: 0.0,
                silent_since: None,
                opens: me < id,
                offered: false,
                answered: false,
                pending: Vec::new(),
                state,
                counters,
            },
        );
    }

    async fn offer(&mut self, id: u64) {
        let Some(pc) = self.links.get(&id).map(|link| Arc::clone(&link.pc)) else {
            return;
        };
        if let Some(link) = self.links.get_mut(&id) {
            link.offered = true;
        }
        let _ = self.out.send(FromClient::Introduce { to: id }.to_text());
        match pc.create_offer(None).await {
            Ok(offer) => {
                if pc.set_local_description(offer.clone()).await.is_ok() {
                    let payload = json!({"description": offer}).to_string();
                    let _ = self.out.send(signal_msg(id, &payload));
                    println!("offered to {id}");
                }
            }
            Err(problem) => eprintln!("colleague: the offer to {id} was not made: {problem}"),
        }
    }

    /// An introduction or a signal from somebody the server handed it on for. A new link is opened only for
    /// somebody the rule hears; anything else waits for the next state message.
    async fn signal(&mut self, from: u64, payload: &str) {
        let agreed = self.links.contains_key(&from) || self.hearing.get(&from).is_some_and(|level| *level > 0.0);
        if !agreed {
            let (_, held) = self.waiting.entry(from).or_insert_with(|| (Instant::now(), Vec::new()));
            if held.len() < HELD_MAX {
                held.push(payload.to_string());
            }
            return;
        }
        let value: Value = match serde_json::from_str(payload) {
            Ok(value) => value,
            Err(_) => return,
        };
        if !self.links.contains_key(&from) {
            self.open(from).await;
        }
        let Some(pc) = self.links.get(&from).map(|link| Arc::clone(&link.pc)) else {
            return;
        };

        if let Some(description) = value.get("description") {
            let kind = description.get("type").and_then(Value::as_str).unwrap_or("");
            let desc: rtc::peer_connection::sdp::RTCSessionDescription =
                match serde_json::from_value(description.clone()) {
                    Ok(desc) => desc,
                    Err(_) => return,
                };
            if let Err(problem) = pc.set_remote_description(desc).await {
                eprintln!("colleague: the description from {from} was refused: {problem}");
                return;
            }
            let held = match self.links.get_mut(&from) {
                Some(link) => {
                    link.answered = true;
                    std::mem::take(&mut link.pending)
                }
                None => Vec::new(),
            };
            for candidate in held {
                let _ = pc.add_ice_candidate(candidate).await;
            }
            if kind == "offer" {
                if let Some(link) = self.links.get_mut(&from) {
                    link.opens = false;
                }
                match pc.create_answer(None).await {
                    Ok(answer) => {
                        if pc.set_local_description(answer.clone()).await.is_ok() {
                            let payload = json!({"description": answer}).to_string();
                            let _ = self.out.send(signal_msg(from, &payload));
                            println!("answered {from}");
                        }
                    }
                    Err(problem) => eprintln!("colleague: the answer to {from} was not made: {problem}"),
                }
            }
        } else if let Some(candidate) = value.get("candidate") {
            let init: RTCIceCandidateInit = match serde_json::from_value(candidate.clone()) {
                Ok(init) => init,
                Err(_) => return,
            };
            let answered = self.links.get(&from).map(|link| link.answered).unwrap_or(false);
            if answered {
                let _ = pc.add_ice_candidate(init).await;
            } else if let Some(link) = self.links.get_mut(&from) {
                link.pending.push(init);
            }
        }
    }

    /// Say whether I am talking, when it changes. Said as an edge rather than with every frame: it is a fact
    /// about me, not a stream, and the server keeps it so that everybody's picture agrees.
    fn announce_speaking(&mut self, speaking: bool) {
        if speaking == self.said_speaking {
            return;
        }
        self.said_speaking = speaking;
        let _ = self.out.send(FromClient::Speaking { speaking }.to_text());
    }

    /// One 20 ms frame per tick, encoded once and written to every connection that is up: the microphone is one
    /// signal and each connection gets the same one.
    async fn send_frame(&mut self) {
        // Whether I am talking is decided by who can hear me, and it is said before the frames are dealt with:
        // the last link going away is exactly the moment the truth turns from yes to no.
        let talking = self.links.values().any(|link| link.state.load(Ordering::Acquire) == UP);
        self.announce_speaking(talking);
        if self.links.is_empty() {
            return;
        }
        let frame = self.source.next_frame();
        let len = match self.mouth.encode(&frame[..], &mut self.buffer[..]) {
            Ok(len) => len,
            Err(problem) => {
                eprintln!("colleague: the tone did not encode: {problem}");
                return;
            }
        };
        let bytes = self.buffer[..len].to_vec();

        let ids: Vec<u64> = self.links.keys().copied().collect();
        for id in ids {
            let Some(link) = self.links.get_mut(&id) else {
                continue;
            };
            if link.state.load(Ordering::Acquire) != UP {
                continue;
            }
            // Chased, not set — the browser client's `applyLevel` smooths the same way, so a peer walking in
            // or out fades rather than clicking, and the gain the receiving side applies is this one.
            link.fade += (link.level - link.fade) * FADE_PER_FRAME;
            link.level_cell.store(link.fade.to_bits(), Ordering::Relaxed);
            if !link.ready {
                if let Ok(parameters) = link.sender.get_parameters().await {
                    if let Some(codec) = parameters.rtp_parameters.codecs.first() {
                        link.payload_type = codec.payload_type;
                    }
                }
                if let Some(ssrc) = link.track.ssrcs().await.first().copied() {
                    link.ssrc = ssrc;
                }
                link.ready = true;
                println!("sending Opus to {id} as payload type {}", link.payload_type);
            }
            let mut sample = Sample::new(Instant::now());
            sample.data = bytes.clone().into();
            sample.duration = Duration::from_millis(20);
            if link.track.write_sample(link.ssrc, link.payload_type, &sample, &[]).await.is_ok() {
                link.counters.out_packets.fetch_add(1, Ordering::Relaxed);
                link.counters.out_bytes.fetch_add(len as u64, Ordering::Relaxed);
            }
        }
    }

    /// Reads the floor's loudness for this 20 ms and hands the block back to silence. The number is what a
    /// host would have played; here it is only ever read.
    fn flush(&mut self) {
        let rms = self.mixer.take_rms();
        self.heard_sum += rms as f64;
        self.heard_blocks += 1;
        self.heard_life_sum += rms as f64;
        self.heard_life_blocks += 1;
    }

    async fn close(&mut self, id: u64) {
        if let Some(link) = self.links.remove(&id) {
            let _ = link.pc.close().await;
            println!("closed the link to {id}");
        }
    }

    fn walk(&self, x: f32, y: f32) {
        let _ = self.out.send(FromClient::Walk { x, y }.to_text());
    }

    /// Sends any scheduled walk whose moment has come. Each fires once.
    fn walk_if_due(&mut self, elapsed: Duration) {
        let seconds = elapsed.as_secs();
        while self.sent_walks < self.walks.len() {
            let (x, y, at) = self.walks[self.sent_walks];
            if at > seconds {
                break;
            }
            self.walk(x, y);
            self.sent_walks += 1;
        }
    }

    /// Sends the wire's own `ToggleDoor` for any scheduled door whose moment has come — the same message a click
    /// sends, so a check drives what a person drives. Each fires once.
    fn doors_if_due(&mut self, elapsed: Duration) {
        let seconds = elapsed.as_secs();
        while self.sent_doors < self.doors.len() {
            let (row, col, at) = self.doors[self.sent_doors];
            if at > seconds {
                break;
            }
            let _ = self.out.send(FromClient::ToggleDoor { floor: 0, row, col }.to_text());
            println!("worked the door at {row}, {col}");
            self.sent_doors += 1;
        }
    }

    fn report(&mut self, elapsed: Duration, finished: bool) {
        let tag = if finished { "TOTAL" } else { "      t" };
        if self.links.is_empty() {
            println!(
                "{tag} {:>6.1}s  no connections — {} here, nearest {:.2} m",
                elapsed.as_secs_f64(),
                self.seen,
                self.nearest
            );
        }
        for (id, link) in &self.links {
            let counters = &link.counters;
            println!(
                "{tag} {:>6.1}s  #{id}  level {:>5.2}  up {}  sent {} pkt / {} B   got {} pkt / {} B   decoded {} x {}   odd {}   bad {}",
                elapsed.as_secs_f64(),
                link.level,
                link.state.load(Ordering::Acquire) == UP,
                counters.out_packets.load(Ordering::Relaxed),
                counters.out_bytes.load(Ordering::Relaxed),
                counters.in_packets.load(Ordering::Relaxed),
                counters.in_bytes.load(Ordering::Relaxed),
                counters.decoded.load(Ordering::Relaxed),
                FRAME,
                counters.decoded_odd.load(Ordering::Relaxed),
                counters.undecodable.load(Ordering::Relaxed),
            );
        }
        // The floor's loudness for the second just past, not a running average: the point of the number is
        // that it follows the level, and an average since start would barely move.
        let loudness = if finished {
            // The whole run, so the last line is the average the run is judged by — the second it fell in
            // happens to be empty.
            if self.heard_life_blocks > 0 {
                self.heard_life_sum / self.heard_life_blocks as f64
            } else {
                0.0
            }
        } else if self.heard_blocks > 0 {
            self.heard_sum / self.heard_blocks as f64
        } else {
            0.0
        };
        println!("{tag} {:>6.1}s  floor  rms {:.4}", elapsed.as_secs_f64(), loudness);
        self.heard_sum = 0.0;
        self.heard_blocks = 0;
        let _ = std::io::stdout().flush();
    }
}

/// The connection's callbacks hold the outbound queue, not the socket: candidates are made on the connection's
/// own schedule, and the writer owns the only way out.
struct Callback {
    to: u64,
    out: mpsc::UnboundedSender<String>,
    state: Arc<AtomicU8>,
    counters: Arc<Counters>,
    /// What arrives from this peer is decoded, put at the level the rule gives it, and added to the floor.
    mixer: Mixer,
    level_cell: Arc<AtomicU32>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Callback {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            let payload = json!({"candidate": init}).to_string();
            let _ = self.out.send(signal_msg(self.to, &payload));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        // The browser client closes a link the moment WebRTC says it failed or closed, and so does this: the
        // main loop then sees a dead link and takes it out, and the rule opens a fresh one on the next tick.
        // Without that, one disruption left a colleague mute to that peer until somebody walked away.
        match state {
            RTCPeerConnectionState::Connected => self.state.store(UP, Ordering::Release),
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                self.state.store(DEAD, Ordering::Release);
            }
            _ => {}
        }
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let counters = Arc::clone(&self.counters);
        let mixer = self.mixer.clone();
        let level_cell = Arc::clone(&self.level_cell);
        tokio::spawn(async move {
            let mut ear = ear().expect("the decoder opens");
            let mut back = vec![0i16; FRAME];
            while let Some(event) = track.poll().await {
                if let TrackRemoteEvent::OnRtpPacket(packet) = event {
                    counters.in_packets.fetch_add(1, Ordering::Relaxed);
                    counters.in_bytes.fetch_add(packet.payload.len() as u64, Ordering::Relaxed);
                    match ear.decode(Some(packet.payload.as_ref()), &mut back[..], false) {
                        Ok(FRAME) => {
                            counters.decoded.fetch_add(1, Ordering::Relaxed);
                            // The level the rule last gave this peer is the gain. Read here rather than
                            // handed over so a peer who walks closer mid-sentence gets louder at once.
                            let gain = f32::from_bits(level_cell.load(Ordering::Relaxed));
                            mixer.add(gain, &back);
                        }
                        Ok(_) => {
                            counters.decoded_odd.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => {
                            counters.undecodable.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
        });
    }
}

/// A generated tone never falls silent and is an upper bound on cost; a recording is the real figure, because
/// Opus spends fewer bits — not fewer packets — on the quiet parts.
enum Source {
    Tone { phase: f32 },
    Clip { samples: Vec<i16>, at: usize },
}

impl Source {
    /// The next 20 ms of the signal, looping the clip. Silence if the clip is empty, rather than a panic.
    fn next_frame(&mut self) -> Vec<i16> {
        match self {
            Source::Tone { phase } => (0..FRAME)
                .map(|_| {
                    let value = (std::f32::consts::TAU * *phase).sin() * 12_000.0;
                    *phase = (*phase + 440.0 / 48_000.0).fract();
                    value as i16
                })
                .collect(),
            Source::Clip { samples, at } => {
                if samples.is_empty() {
                    return vec![0i16; FRAME];
                }
                (0..FRAME)
                    .map(|_| {
                        let sample = samples[*at];
                        *at = (*at + 1) % samples.len();
                        sample
                    })
                    .collect()
            }
        }
    }
}

/// Reads a mono (or downmixed) 16-bit PCM WAV and resamples it to 48 kHz, the only rate Opus is handed here.
/// Enough of RIFF to read what the harness records, and no dependency for it.
fn read_wav(path: &str) -> Result<Vec<i16>, String> {
    let bytes = std::fs::read(path).map_err(|problem| format!("{path} could not be read: {problem}"))?;
    if bytes.len() < 12 || bytes[0..4] != *b"RIFF" || bytes[8..12] != *b"WAVE" {
        return Err(format!("{path} is not a RIFF/WAVE file"));
    }

    let mut channels = 1usize;
    let mut rate = 48_000u32;
    let mut bits = 16u16;
    let mut data: Option<&[u8]> = None;

    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let start = at + 8;
        let end = (start + size).min(bytes.len());
        let body = &bytes[start..end];
        match id {
            b"fmt " => {
                if body.len() < 16 {
                    return Err(format!("{path} has a short fmt chunk"));
                }
                channels = u16::from_le_bytes([body[2], body[3]]).max(1) as usize;
                rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                bits = u16::from_le_bytes([body[14], body[15]]);
            }
            b"data" => data = Some(body),
            _ => {}
        }
        at = start + size + (size & 1); // chunks sit on even boundaries
    }

    let data = data.ok_or_else(|| format!("{path} has no data chunk"))?;
    if bits != 16 {
        return Err(format!("{path} is {bits}-bit; only 16-bit PCM is read"));
    }

    let stride = 2 * channels;
    let mut mono: Vec<i16> = Vec::with_capacity(data.len() / stride);
    for frame in data.chunks_exact(stride) {
        let mut sum = 0i32;
        for channel in 0..channels {
            sum += i16::from_le_bytes([frame[channel * 2], frame[channel * 2 + 1]]) as i32;
        }
        mono.push((sum / channels as i32) as i16);
    }

    if rate == 48_000 || mono.is_empty() {
        return Ok(mono);
    }
    // Linear interpolation to 48 kHz. The recording beside the harness page is 24 kHz, and this is the one
    // conversion the encoder will not do for us.
    let out_len = ((mono.len() as f64) * 48_000.0 / rate as f64).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let pos = n as f64 * rate as f64 / 48_000.0;
        let low = pos.floor() as usize;
        let frac = (pos - low as f64) as f32;
        let a = mono.get(low).copied().unwrap_or(0) as f32;
        let b = mono.get(low + 1).copied().unwrap_or(a as i16) as f32;
        out.push((a + (b - a) * frac).round() as i16);
    }
    Ok(out)
}

fn opus() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: 48_000,
            channels: 2,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![],
        },
        payload_type: 120,
    }
}

/// A media engine with Opus and nothing else, and the default interceptors over it. The transport ships no
/// codec of its own, so a capability has to be registered even though a track carries the samples.
fn engine() -> (MediaEngine, Registry) {
    let mut media_engine = MediaEngine::default();
    media_engine.register_codec(opus(), RtpCodecKind::Audio).expect("Opus registers");
    let registry =
        register_default_interceptors(Registry::new(), &mut media_engine).expect("interceptors build");
    (media_engine, registry)
}

fn signal_msg(to: u64, payload: &str) -> String {
    FromClient::Signal { to, payload: payload.to_string() }.to_text()
}

/// Trusts exactly the office's certificate and nothing else. There is no authority to walk a chain up to, but
/// "accept anything" is the one thing this project will not ship: a client that takes any certificate can be
/// pointed elsewhere, and a colleague holds a microphone. The server's public half is compared byte for byte;
/// the handshake is still verified against its key, which proves the far side holds the private half.
#[derive(Debug)]
struct ExactlyThisOne {
    certificate: rustls::pki_types::CertificateDer<'static>,
}

impl rustls::client::danger::ServerCertVerifier for ExactlyThisOne {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() != self.certificate.as_ref() {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &algorithms())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &algorithms())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        algorithms().supported_schemes()
    }
}

/// The signature schemes this process was built with, taken from the provider rather than written down.
fn algorithms() -> rustls::crypto::WebPkiSupportedAlgorithms {
    rustls::crypto::ring::default_provider().signature_verification_algorithms
}

/// Reads the office's certificate from a PEM file and builds a configuration that trusts that one certificate.
fn trust(path: &str) -> Result<rustls::ClientConfig, String> {
    let pem = std::fs::read(path).map_err(|problem| format!("{path} could not be read: {problem}"))?;
    let certificate = rustls_pemfile::certs(&mut &pem[..])
        .next()
        .ok_or_else(|| format!("{path} holds no PEM certificate"))?
        .map_err(|problem| format!("{path} is not a PEM certificate: {problem}"))?;

    Ok(rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ExactlyThisOne { certificate }))
        .with_no_client_auth())
}
