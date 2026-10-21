//! The sockets. Everything decided is decided by `World`; this carries its answers — to the person who
//! asked, to everybody, or to one other person — and ticks the floor thirty times a second, which is the
//! rate at which a walk reads as a walk and not as a slide show.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use office_mumble_wire::{FromClient, ToClient};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::avatars::Avatars;
use crate::world::{Outbound, World};

/// How often the server moves everybody and tells the clients.
const TICK_MS: u64 = 33;

/// How deep the queue in front of one socket may grow. A signal is small and a handshake is a handful, so it only
/// fills when something is wrong.
const DIRECT_QUEUE: usize = 256;

/// What every session shares: the world, a way to reach each person directly, and a way to reach
/// everybody at once.
#[derive(Clone)]
pub struct Hub {
    world: Arc<Mutex<World>>,
    /// Who can be reached now, by id. A relay target is a live session or nothing — not an error to report.
    sockets: Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>,
    everybody: broadcast::Sender<String>,
    /// The test avatars: figures nobody is behind, so they are kept beside the world rather than in it.
    avatars: Arc<Avatars>,
}

type Sink = SplitSink<WebSocket, Message>;

/// The `/ws` route: every socket becomes a session on the one hub.
pub async fn upgrade(ws: WebSocketUpgrade, State(hub): State<Hub>) -> Response {
    ws.on_upgrade(move |socket| hub.session(socket))
}

impl Hub {
    pub fn new(world: World, avatars: Arc<Avatars>) -> Hub {
        let (everybody, _) = broadcast::channel::<String>(64);
        Hub {
            world: Arc::new(Mutex::new(world)),
            sockets: Arc::new(Mutex::new(HashMap::new())),
            everybody,
            avatars,
        }
    }

    /// The world, for the test-avatar routes: they put somebody on the floor and ask the world to move them.
    pub fn world(&self) -> &Arc<Mutex<World>> {
        &self.world
    }

    pub fn avatars(&self) -> &Avatars {
        &self.avatars
    }

    /// Move everybody one tick and tell everybody where they are, forever.
    pub async fn tick_forever(self) {
        let dt_s = TICK_MS as f32 / 1000.0;
        let mut ticker = tokio::time::interval(Duration::from_millis(TICK_MS));
        loop {
            ticker.tick().await;
            let state = {
                let mut world = self.world.lock().await;
                world.step(dt_s);
                world.state()
            };
            self.announce(&state);
        }
    }

    /// One connection, from the plan it is handed on arrival to the lock it lets go of when it ends.
    pub async fn session(self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let plan = self.world.lock().await.plan_message();
        if !send(&mut sink, &plan).await {
            return;
        }

        let mut broadcasts = self.everybody.subscribe();
        // What is addressed to me alone, as opposed to what the whole floor is told.
        let (direct_tx, mut direct_rx) = mpsc::channel::<String>(DIRECT_QUEUE);
        let mut me: Option<u64> = None;
        loop {
            tokio::select! {
                incoming = stream.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let outbound = self.receive(&mut me, &direct_tx, text.as_str()).await;
                        if !self.deliver(&mut sink, outbound).await {
                            break;
                        }
                    }
                    // A close frame is answered by ending the session: ignoring it leaves a half-open
                    // socket and a figure standing in the roster that nobody can account for.
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                },
                Some(text) = direct_rx.recv() => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                broadcasted = broadcasts.recv() => match broadcasted {
                    Ok(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }

        if let Some(id) = me {
            self.sockets.lock().await.remove(&id);
            let outbound = self.world.lock().await.depart(id);
            self.deliver(&mut sink, outbound).await;
        }
    }

    /// Read one message and answer it. A join is answered here, because joining ties the socket to an id.
    async fn receive(&self, me: &mut Option<u64>, direct: &mpsc::Sender<String>, text: &str) -> Vec<Outbound> {
        let message = match serde_json::from_str::<FromClient>(text) {
            Ok(message) => message,
            Err(problem) => {
                eprintln!("cannot read a client message: {problem}");
                return vec![Outbound::Reply(ToClient::Refused { reason: format!("not a message: {problem}") })];
            }
        };
        match (message, *me) {
            (FromClient::Join { name, seat }, None) => {
                let (id, name, lock, voices, demo) = {
                    let mut world = self.world.lock().await;
                    let (id, name) = match self.avatars.reserved(&name) {
                        // An avatar's place was reserved when it was made: its process joins on its own, and
                        // three presses in a row must not all land on the same stop.
                        Some((floor, at)) => world.join_on(name, floor, at),
                        None => world.join(name, seat),
                    };
                    // Somebody joining under an avatar's name *is* that avatar: a speaking figure is a client
                    // of its own, and this is the moment it becomes a person on the floor.
                    if self.avatars.taken(&name) {
                        world.mark_avatar(id);
                    }
                    (id, name, world.lock_message(), self.avatars.recordings(), self.avatars.demo())
                };
                *me = Some(id);
                self.sockets.lock().await.insert(id, direct.clone());
                println!("{name} joined as {id}");
                // Who is editing, right away, so a client that has just arrived can see it — and which
                // recordings exist here, so the sidebar can offer them without asking.
                vec![
                    Outbound::Reply(ToClient::Hello { id, name }),
                    Outbound::Reply(lock),
                    Outbound::Reply(ToClient::Voices { names: voices }),
                    Outbound::Reply(ToClient::Demo { name: demo.0, voice: demo.1 }),
                ]
            }
            (FromClient::DemoGuest { on }, Some(_)) => {
                let mut world = self.world.lock().await;
                match self.avatars.demo_guest(&mut world, on) {
                    Ok(()) => Vec::new(),
                    Err(no) => vec![Outbound::Reply(ToClient::AvatarProblem { why: no.said() })],
                }
            }
            // A test avatar is the hub's to make, not the world's: making one can mean starting a program and
            // sending one home can mean ending it. The state everybody gets is what shows the result.
            (FromClient::Avatar { name, voice, home }, Some(_)) => {
                let mut world = self.world.lock().await;
                let outcome = if home {
                    self.avatars.send_home(&mut world, &name)
                } else {
                    self.avatars.make(&mut world, &name, voice.as_deref()).map_err(|no| no.said())
                };
                match outcome {
                    Ok(()) => Vec::new(),
                    Err(why) => vec![Outbound::Reply(ToClient::AvatarProblem { why })],
                }
            }
            // A call across the room: the named person sees who it is and decides. The server carries the
            // question and the answer and moves nobody until the answer is yes.
            (FromClient::Summon { to }, Some(from)) => {
                let world = self.world.lock().await;
                let Some(name) = world.name_of(from) else { return Vec::new() };
                if !world.same_area(from, to) {
                    return vec![Outbound::Reply(ToClient::Refused {
                        reason: "too far to call".to_string(),
                    })];
                }
                vec![Outbound::To(to, ToClient::Summoned { from, name })]
            }
            (FromClient::AnsweredSummon { from, accept }, Some(me)) => {
                let mut world = self.world.lock().await;
                let Some(name) = world.name_of(me) else { return Vec::new() };
                if accept {
                    // Where the caller stands now, not where they stood when they called: the walk answers
                    // "come over", and a metre short is the same rule as go-to.
                    if let Some((x, y, _)) = world.place(from) {
                        let (tx, ty) = world.a_metre_before(me, (x, y));
                        let _ = world.handle(me, FromClient::Walk { x: tx, y: ty });
                    }
                }
                vec![Outbound::To(from, ToClient::SummonAnswer { by: me, name, accepted: accept })]
            }
            (message, Some(id)) => self.world.lock().await.handle(id, message),
            // Nothing is answered before a join, and a second join on one socket is not a second person.
            (_, _) => Vec::new(),
        }
    }

    /// Carry the world's answers. False when this session's own socket has gone, which ends the session.
    async fn deliver(&self, sink: &mut Sink, outbound: Vec<Outbound>) -> bool {
        for message in outbound {
            match message {
                Outbound::Reply(message) => {
                    if !send(sink, &message).await {
                        return false;
                    }
                }
                Outbound::Everybody(message) => self.announce(&message),
                Outbound::To(to, message) => self.relay(to, &message).await,
            }
        }
        true
    }

    /// Tell everybody the same thing. The plan and the lock both go out this way, so every client sees the
    /// change rather than inferring it — a second client watches the room it did not build appear.
    pub(crate) fn announce(&self, message: &ToClient) {
        // Nobody listening is not an error: the floor is simply empty.
        let _ = self.everybody.send(message.to_text());
    }

    /// Hand a message to one other client, unopened. Whether it is carried at all the world decided before
    /// this — only inside one area — and how loud anybody is stays the listener's rule; this only carries.
    async fn relay(&self, to: u64, message: &ToClient) {
        let Some(sender) = self.sockets.lock().await.get(&to).cloned() else {
            return;
        };
        // Bounded on purpose. Anybody can invent signals faster than a slow recipient drains them, and an
        // unbounded queue in front of a socket is memory that one peer gets to spend on another's behalf.
        // When it is full the message goes, not the house.
        if let Err(mpsc::error::TrySendError::Full(_)) = sender.try_send(message.to_text()) {
            eprintln!("dropped a signal for {to}: their queue is full");
        }
    }
}

/// Send one message on this session's own socket. False when the socket has gone.
async fn send(sink: &mut Sink, message: &ToClient) -> bool {
    sink.send(Message::Text(message.to_text().into())).await.is_ok()
}
