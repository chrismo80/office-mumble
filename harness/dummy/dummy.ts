/**
 * A synthetic colleague: a floor can be listened to without a second person. It borrows the hearing rule from
 * the product — the same rule or the measurement means nothing — and brings its own connection handling, so it
 * cannot grow into the client it was meant to check.
 *
 *   source=file|tone|bursts|silence   a recording, a tone (the encoder's upper bound), generated syllables, silence
 *   voice=<url>      which recording, default ./voice.wav beside the page
 *   walk=x,y         send the figure there once, in metres
 *   name=            what to be called
 *
 * Nothing here is ever taken from a real meeting: it is a test voice, put there on purpose.
 */

import { within, type Person } from '../../client/src/hearing';
import { SPEAKING_LEVEL } from '../../client/src/voice';
import { introduce, join, parse, signal, speak, walk } from '../../client/src/wire';

const params = new URLSearchParams(location.search);
const name = params.get('name') ?? 'Dummy';
const source = params.get('source') ?? 'file';
const destination = params.get('walk');
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const serverUrl = params.get('server') ?? `${scheme}://${location.hostname || '127.0.0.1'}:8787/ws`;

const label = document.querySelector<HTMLDivElement>('#state')!;
const readout = document.querySelector<HTMLPreElement>('#readout')!;

/** Ask for a click, and take it, when the browser will not give out sound without one. */
function startOnGesture(): void {
  const note = 'click once in this tab: this browser gives no sound without it';
  document.title = `office-mumble · ${note}`;
  label.textContent = note;
  const begin = (): void => {
    void context.resume().then(() => {
      label.textContent = 'the voice is running';
      document.title = 'office-mumble · a synthetic colleague';
    });
  };
  addEventListener('pointerdown', begin, { once: true });
  addEventListener('keydown', begin, { once: true });
}

type Link = {
  pc: RTCPeerConnection;
  analyser: AnalyserNode | null;
  level: number;
  offered: boolean;
  candidates: RTCIceCandidateInit[];
  remote: boolean;
  sent: number;
  received: number;
  sentBytes: number;
  receivedBytes: number;
};

const context = new AudioContext();
const peers = new Map<number, Link>();
let me = 0;
// The plan as the model carries it: one row of cell codes per floor row, and the size of a cell.
let cells: string[][] = [];
let cellM = 0.5;
let standing: Person[] = [];
let mine: Person | null = null;
let socket: WebSocket | null = null;

/** The voice of this colleague, chosen rather than captured. */
function synthetic(): MediaStream {
  const to = context.createMediaStreamDestination();
  if (source === 'silence') {
    const quiet = context.createConstantSource();
    quiet.offset.value = 0;
    quiet.connect(to).connect(context.destination);
    quiet.start();
    return to.stream;
  }
  if (source === 'tone') {
    const tone = context.createOscillator();
    tone.frequency.value = 220;
    const volume = context.createGain();
    volume.gain.value = 0.2;
    tone.connect(volume).connect(to);
    tone.start();
    return to.stream;
  }
  // Bursts: syllables with the pauses between them, which is the difference between what an encoder costs
  // when nobody stops talking and what it costs when somebody does.
  const seconds = 8;
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, rate * seconds, rate);
  const samples = buffer.getChannelData(0);
  let at = 0;
  while (at < samples.length) {
    const burst = Math.floor(rate * (0.25 + Math.random() * 0.4));
    const pause = Math.floor(rate * (0.2 + Math.random() * 0.5));
    for (let i = 0; i < burst && at + i < samples.length; i++) {
      const envelope = Math.sin((Math.PI * i) / burst);
      samples[at + i] = (Math.random() * 2 - 1) * 0.35 * envelope;
    }
    at += burst + pause;
  }
  const voice = context.createBufferSource();
  voice.buffer = buffer;
  voice.loop = true;
  voice.connect(to);
  voice.start();
  return to.stream;
}

/**
 * A recording, if somebody put one beside the page: harness/dummy/public/voice.wav lands at ./voice.wav, and
 * ?voice=<url> takes any other. Speech with its own pauses beats anything generated, both to listen to and to
 * measure — and when there is nothing there, this says so and the generated voices stand in.
 */
async function recorded(): Promise<MediaStream | null> {
  const url = params.get('voice') ?? './voice.wav';
  try {
    const answer = await fetch(url);
    if (!answer.ok) throw new Error(String(answer.status));
    const buffer = await context.decodeAudioData(await answer.arrayBuffer());
    const to = context.createMediaStreamDestination();
    const player = context.createBufferSource();
    player.buffer = buffer;
    player.loop = true;
    const volume = context.createGain();
    volume.gain.value = 0.5;
    player.connect(volume).connect(to);
    player.start();
    return to.stream;
  } catch {
    const note = `no recording at ${url} — generated syllables instead`;
    document.title = `office-mumble · ${note}`;
    label.textContent = note;
    return null;
  }
}

const voice = source === 'file' ? ((await recorded()) ?? synthetic()) : synthetic();
const track = voice.getAudioTracks()[0];
/** Metered once, for the same reason the client meters its microphone: to say whether it is talking. */
const voiceMeter = context.createAnalyser();
voiceMeter.fftSize = 1024;
context.createMediaStreamSource(voice).connect(voiceMeter);
let talking = false;

function meter(stream: MediaStream): AnalyserNode {
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  return analyser;
}

function levelOf(analyser: AnalyserNode | null): number {
  if (!analyser) return 0;
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

function link(id: number): Link {
  const existing = peers.get(id);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTrack(track, voice); // one track per connection: N people in earshot means N encoders
  const opened: Link = {
    pc,
    analyser: null,
    level: 0,
    offered: me < id,
    candidates: [],
    remote: false,
    sent: 0,
    received: 0,
    sentBytes: 0,
    receivedBytes: 0,
  };
  pc.onicecandidate = event => {
    if (event.candidate) socket?.send(signal(id, JSON.stringify({ candidate: event.candidate.toJSON() })));
  };
  pc.ontrack = event => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    opened.analyser = meter(stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') close(id);
  };
  peers.set(id, opened);
  return opened;
}

function close(id: number): void {
  const opened = peers.get(id);
  if (!opened) return;
  peers.delete(id);
  try {
    opened.pc.close();
  } catch {
    // already gone
  }
}

async function offer(opened: Link, id: number): Promise<void> {
  opened.offered = true;
  socket?.send(introduce(id));
  const created = await opened.pc.createOffer();
  await opened.pc.setLocalDescription(created);
  socket?.send(signal(id, JSON.stringify({ description: opened.pc.localDescription })));
}

async function receive(from: number, kind: string, payload?: string): Promise<void> {
  const opened = link(from);
  if (kind === 'introduction') return;
  let data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  try {
    data = JSON.parse(payload ?? '{}');
  } catch {
    return;
  }
  if (data.description) {
    if (data.description.type === 'offer') opened.offered = false;
    await opened.pc.setRemoteDescription(data.description);
    opened.remote = true;
    for (const candidate of opened.candidates.splice(0)) await opened.pc.addIceCandidate(candidate);
    if (data.description.type === 'offer') {
      const answer = await opened.pc.createAnswer();
      await opened.pc.setLocalDescription(answer);
      socket?.send(signal(from, JSON.stringify({ description: opened.pc.localDescription })));
    }
  } else if (data.candidate) {
    if (opened.remote) await opened.pc.addIceCandidate(data.candidate);
    else opened.candidates.push(data.candidate);
  }
}

async function refresh(): Promise<void> {
  if (!mine) return;
  const nearby = within(cells, cellM, mine, standing);
  for (const entry of nearby) {
    if (entry.level <= 0) {
      close(entry.id);
      continue;
    }
    const opened = link(entry.id);
    // The lower id opens; the higher one waits for an offer it has already been told about.
    if (opened.offered && !opened.remote && opened.pc.connectionState === 'new') await offer(opened, entry.id);
  }
  for (const id of [...peers.keys()]) {
    if (!nearby.some(entry => entry.id === id && entry.level > 0)) close(id);
  }
}

function connect(): void {
  socket = new WebSocket(serverUrl);
  socket.onopen = () => socket?.send(join(name));
  socket.onclose = () => {
    socket = null;
    setTimeout(connect, 1500);
  };
  socket.onmessage = async event => {
    const message = parse(String(event.data));
    if (!message) return;
    if (message.type === 'plan') {
      cells = message.plan.floors[0]?.cells ?? [];
      cellM = message.plan.cell_m;
    } else if (message.type === 'hello') {
      me = message.id;
      if (destination) {
        const [x, y] = destination.split(',').map(Number);
        socket?.send(walk(x, y));
      }
    } else if (message.type === 'state') {
      standing = message.people;
      mine = standing.find(person => person.id === me) ?? mine;
      await refresh();
    } else if (message.type === 'introduction' || message.type === 'signal') {
      await receive(message.from, message.type, message.type === 'signal' ? message.payload : undefined);
    }
  };
}

/** What this colleague is doing, for anybody looking at it and for whatever wants to measure it. */
function stats(): unknown {
  return [...peers].map(([id, opened]) => ({
    id,
    connection: opened.pc.connectionState,
    level: Number(levelOf(opened.analyser).toFixed(4)),
    sent: opened.sent,
    received: opened.received,
    sentBytes: opened.sentBytes,
    receivedBytes: opened.receivedBytes,
  }));
}

async function countPackets(): Promise<void> {
  for (const opened of peers.values()) {
    const report = await opened.pc.getStats();
    report.forEach(entry => {
      if (entry.type === 'outbound-rtp') {
        const out = entry as { packetsSent?: number; bytesSent?: number };
        opened.sent = out.packetsSent ?? opened.sent;
        opened.sentBytes = out.bytesSent ?? opened.sentBytes;
      }
      if (entry.type === 'inbound-rtp') {
        const inbound = entry as { packetsReceived?: number; bytesReceived?: number };
        opened.received = inbound.packetsReceived ?? opened.received;
        opened.receivedBytes = inbound.bytesReceived ?? opened.receivedBytes;
      }
    });
  }
}

(window as unknown as { officeMumbleDummy?: unknown }).officeMumbleDummy = {
  stats: () => stats(),
  packets: async () => {
    await countPackets();
    return stats();
  },
  at: () => (mine ? { x: mine.x, y: mine.y } : null),
  // The level of this colleague's own voice, so a driver can wait for it to be talking before photographing
  // the floor rather than guessing from the readout.
  voice: () => Number(levelOf(voiceMeter).toFixed(4)),
};

// Sound is handed out on a gesture, and this page is meant to be left alone in its own tab. So it asks
// without one first, and when the browser insists, it says so and takes the first click — instead of
// connecting and sending silence, which is indistinguishable from a floor with nobody in it.
void context.resume().then(
  () => {
    if (context.state !== 'running') startOnGesture();
  },
  startOnGesture,
);
connect();

setInterval(() => {
  void countPackets();
  // A synthetic colleague says when it is talking, like a person does: the level of its own voice against
  // the same threshold the client uses, so a figure in a browser shows it talking.
  const own = levelOf(voiceMeter) > SPEAKING_LEVEL;
  if (own !== talking) {
    talking = own;
    socket?.send(speak(own));
  }
  const lines = [...peers].map(([id, opened]) => {
    const level = levelOf(opened.analyser);
    return `#${id}  ${opened.pc.connectionState}  in ${opened.received}  out ${opened.sent}  level ${level.toFixed(3)}`;
  });
  readout.textContent = lines.join('\n') || 'nobody in earshot';
  label.textContent = `${name} · ${source} · ${mine ? `${mine.x.toFixed(1)} m, ${mine.y.toFixed(1)} m` : 'not joined'} · hearing ${peers.size}`;
}, 500);
