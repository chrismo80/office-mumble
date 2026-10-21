/**
 * Voice: one connection per person I can hear. The rule decides who; this file carries it out, and all of the
 * mixing happens on the receiving side, so the server is never in the path. Movement keeps a silent connection
 * for a few seconds — a reconnect is a handshake — while a shut door cuts at once. An offer from somebody the
 * rule cannot hear is not answered.
 */

import { facingVector, type Facing } from './figure';
import type { Room } from './room';
import { EARSHOT_M, type Audible, type Person } from './hearing';
import { introduce, signal } from './wire';

/** How long a connection survives after the last thing either of us said — and how long an offer waits. */
export const GRACE_MS = 4000;

/** A handshake is a handful of messages. Anybody sending more while they wait is not shaking hands. */
const HELD_MAX = 64;

type Held = { since: number; messages: Array<{ kind: 'introduction' | 'signal'; payload?: string }> };

/** RMS at which somebody is shown as talking: above the room's noise floor, under a voice. */
export const SPEAKING_LEVEL = 0.02;

/** How the room is played back, chosen by the listener and changed for nobody else. */
export type SoundProfile = 'near' | 'room' | 'wide';

/** Which side is "right": the screen's, or the one my own figure is facing. */
export type PanSide = 'user' | 'avatar';

/**
 * Three ways to play the room, because how loud a colleague across it should be is a matter of ears. They
 * bend the level, the pan depth and the filter — never who is audible, which is the shared rule.
 */
export const SOUND_PROFILES: Record<SoundProfile, { curve: number; pan: number; open: number; closed: number }> = {
  near: { curve: 2.2, pan: 0.35, open: 16000, closed: 9000 },
  room: { curve: 1, pan: 0.75, open: 13000, closed: 1600 },
  wide: { curve: 0.55, pan: 0.9, open: 18000, closed: 4500 },
};

type Link = {
  pc: RTCPeerConnection;
  gain: GainNode;
  /** Where they stand to me: negative is my left, positive my right. */
  pan: StereoPannerNode;
  /** How much air is between us: the further, the duller. */
  filter: BiquadFilterNode;
  /** How much of this voice goes into the room's tail: a far voice is mostly room. */
  send: GainNode | null;
  /** How far the sound had to travel to reach me: the way round, not the straight line. */
  distance: number;
  /** Where they were last placed, so a change of profile can be applied without waiting for a state. */
  space: { dx: number; dy: number; facing: Facing } | null;
  /** How loud they are to me right now. Zero is a connection that is open and quiet. */
  level: number;
  /** Turned down by hand, here: the rule still hears them, this ear does not. */
  silenced: boolean;
  /** Nobody in earshot any more: counting down to letting go. */
  silentSince: number | null;
  /** The lower id opens, so both sides agree about who offers without asking. */
  opens: boolean;
  offered: boolean;
  answered: boolean;
  candidates: RTCIceCandidateInit[];
  /** A muted media element holding the voice's stream: without one, Chromium never pulls a remote stream into
   *  Web Audio, and the voice arrives and stays silent. The chain above stays what is heard. */
  pull: HTMLAudioElement | null;
};

/** What the harness reads, and what anybody can look at in the browser console. */
export type VoiceReadout = {
  id: number;
  level: number;
  connection: string;
  ice: string;
  signaling: string;
  sentBytes: number;
  receivedBytes: number;
  receivedPackets: number;
};

export class Voices {
  private me: number | null = null;
  private context: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private links = new Map<number, Link>();
  private notice = '';
    /** The microphone question is settled and the sound is running. Nothing is negotiated before that. */
  private ready = false;
  /** Everybody in my area and how loud they are, as the rule said on the last state message. */
  private hearing = new Map<number, number>();
  /** What arrived before it could be answered, in the order it came. */
  private waiting = new Map<number, Held>();
  /** One analyser on my own microphone, deciding whether I am shown as talking. */
  private micAnalyser: AnalyserNode | null = null;
  /** My microphone is stopped. */
  private muted = false;
  /** Which microphone the browser is asked for, by device id. Empty means whatever the system chose. */
  private inputId = '';
  /** How this listener wants the room played back. A matter of taste, kept on this machine. */
  private profile: SoundProfile = 'room';
  private side: PanSide = 'avatar';
  /** Which way the view looks, from north towards east: what "right of the screen" means for a turned view. */
  private yaw = 0;

  constructor(private readonly send: (text: string) => void, private readonly onNotice: (what: string) => void) {}

  /** The first gesture has opened the sound, so a microphone may be taken again without another one. */
  get started(): boolean {
    return this.ready;
  }

  /** Where the browser has no WebRTC at all, which is the Linux webview measured in the first increment. */
  get available(): boolean {
    return typeof RTCPeerConnection !== 'undefined' && typeof AudioContext !== 'undefined';
  }

  joined(id: number): void {
    this.me = id;
  }

  /**
   * Gone from the office: every connection ends and the microphone is handed back. The sound stays open, so
   * coming back needs no gesture, and the mute ends here as it ends on every leaving.
   */
  leave(): void {
    for (const id of [...this.links.keys()]) this.close(id);
    this.waiting.clear();
    this.hearing = new Map();
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.micAnalyser = null;
    this.muted = false;
    this.me = null;
  }

  /** The microphone and the sound, on the first gesture — a browser opens neither without one. */
  async start(): Promise<void> {
    if (!this.available) {
      this.say('no voice here: this browser has no WebRTC');
      return;
    }
    if (!this.context) this.context = new AudioContext();
    try {
      await this.context.resume();
    } catch {
      // The gesture may not count yet; the next click will do.
    }

    this.buildHall();
    const hadMic = this.mic !== null;
    if (!hadMic) await this.openMic();
    if (this.mic && !this.micAnalyser) this.meterMic();
    // The microphone may have been granted after the mute was pressed — a key and a gesture arrive in
    // either order — so the state is put onto the new track before anything is ever connected with it.
    this.applyMute();

    const firstTime = !this.ready;
    this.ready = true;

    if (!firstTime && !hadMic && this.mic) {
      // A microphone granted after connections already existed: they were built without one, and adding a
      // track to a live connection is a renegotiation. Starting them over is the small honest way.
      for (const id of [...this.links.keys()]) this.close(id);
    }

    // Now, and only now, the introductions and offers that were waiting for this answer. Whoever my rule does
    // not hear yet goes back to waiting, for the next state message to decide.
    for (const [from, held] of [...this.waiting]) {
      this.waiting.delete(from);
      await this.replay(from, held);
    }
  }

  /** What the rule says, once per state message from the server — worked out there, because the sidebar and
   *  the overlay want the same answer, and the room's size comes out of the same fill. */
  update(
    heard: Audible[],
    everybody: Person[],
    me: Person & { facing?: Facing; yaw?: number },
    room: Room,
    now: number,
  ): void {
    if (!this.context || !this.ready) return;
    this.yaw = me.yaw ?? 0;
    const nearby = new Map<number, number>(heard.map(entry => [entry.id, entry.level]));
    this.hearing = nearby;
    this.room = room;
    const distances = new Map<number, number>(heard.map(entry => [entry.id, entry.distance]));
    this.applyRoom();
    // Where everybody stands, for the pan. The rule already decided who is audible; this only says from
    // which side they are heard.
    const places = new Map(everybody.map(person => [person.id, person]));

    for (const [from, held] of [...this.waiting]) {
      const level = nearby.get(from);
      if (level !== undefined && level > 0) {
        this.waiting.delete(from);
        void this.replay(from, held);
      } else if (level === undefined || now - held.since > GRACE_MS) {
        // Not in my area, or still out of earshot after the grace: whatever they wanted, it goes unanswered.
        this.waiting.delete(from);
      }
    }

    for (const [id, level] of nearby) {
      // A connection is opened for somebody audible only. Everybody in the area but out of earshot is in
      // `nearby` with level zero on purpose — that is how a shut door is told from walking away — and
      // connecting them would mean opening and closing a link for every one of them on every tick.
      if (level <= 0 && !this.links.has(id)) continue;
      const link = this.link(id);
      link.distance = distances.get(id) ?? link.distance;
      link.level = level;
      link.silentSince = level > 0 ? null : link.silentSince ?? now;
      this.applyLevel(link);
      const other = places.get(id);
      if (other) this.applySpace(link, other.x - me.x, other.y - me.y, me.facing ?? 'north');
      if (level > 0 && link.opens && !link.offered) void this.offer(link, id);
    }

    for (const [id, link] of [...this.links]) {
      if (!nearby.has(id)) {
        // Gone from my area: a wall or a shut door between us. Deliberate, so it cuts at once.
        this.close(id);
      } else if (link.silentSince !== null && now - link.silentSince > GRACE_MS) {
        // Walked away. Nobody chose it, so the connection was owed a moment before it went.
        this.close(id);
      }
    }
  }

  /** An introduction or an offer, from somebody the server handed it on for. */
  async received(from: number, kind: 'introduction' | 'signal', payload?: string): Promise<void> {
    if (!this.available) return;
    // A connection that exists is one the rule already agreed to. A new one is opened for somebody the rule
    // hears and for nobody else, whichever side asks.
    const agreed = this.links.has(from) || (this.hearing.get(from) ?? 0) > 0;
    if (!this.ready || !agreed) {
      const held = this.waiting.get(from) ?? { since: performance.now(), messages: [] };
      if (held.messages.length < HELD_MAX) held.messages.push({ kind, payload });
      this.waiting.set(from, held);
      return;
    }
    const link = this.link(from);
    if (kind === 'introduction') return;

    let data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    try {
      data = JSON.parse(payload ?? '{}');
    } catch {
      return;
    }

    if (data.description) {
      if (data.description.type === 'offer') link.opens = false;
      await link.pc.setRemoteDescription(data.description);
      link.answered = true;
      for (const candidate of link.candidates.splice(0)) await link.pc.addIceCandidate(candidate);
      if (data.description.type === 'offer') {
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        this.send(signal(from, JSON.stringify({ description: link.pc.localDescription })));
      }
    } else if (data.candidate) {
      if (link.answered) await link.pc.addIceCandidate(data.candidate);
      else link.candidates.push(data.candidate);
    }
  }

  /** Held messages, in the order they came — one at a time, because an offer has to land before its candidates. */
  private async replay(from: number, held: Held): Promise<void> {
    for (const message of held.messages) await this.received(from, message.kind, message.payload);
  }

  /** What to say in the heads-up display. */
  status(): string {
    if (!this.available) return 'no voice in this browser';
    if (!this.context) return 'click once for sound and microphone';
    const live = [...this.links.values()].filter(link => link.level > 0).length;
    const mic = this.mic ? (this.muted ? 'microphone muted' : 'microphone on') : 'hearing only';
    return `${mic}, hearing ${live}${this.notice ? ` · ${this.notice}` : ''}`;
  }

    /** Whether my microphone is above the speaking threshold: what the figure shows to everybody. */
  talking(): boolean {
    if (this.muted || !this.micAnalyser) return false;
    const samples = new Float32Array(this.micAnalyser.fftSize);
    this.micAnalyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    return Math.sqrt(sum / samples.length) > SPEAKING_LEVEL;
  }

    /**
   * Stop or start the microphone. Presence stays and what I hear is untouched; the track is disabled rather
   * than removed, so being heard again costs no renegotiation. The state is remembered and put onto a
   * microphone granted later, because M may be pressed before the first gesture.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMute();
  }

  /** Put the mute state onto whatever microphone tracks are in hand; a no-op before one is granted. */
  private applyMute(): void {
    if (!this.mic) return;
    for (const track of this.mic.getAudioTracks()) track.enabled = !this.muted;
  }

    /** Whether my microphone is stopped. */
  get isMuted(): boolean {
    return this.muted;
  }

    /** Whether a microphone is in hand — a browser with none still hears, which a status line has to say. */
  get hasMic(): boolean {
    return this.mic !== null;
  }

  /** The microphone in use, by device id. Empty before one has been opened, or when the system chose. */
  get inputDevice(): string {
    return this.inputId;
  }

    /**
   * Open the microphone the system would give us, or the one chosen — in one place, so `start` and `setInput`
   * cannot drift. What the settings screen shows is the device the track reports, not the one hoped for.
   */
  private async openMic(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      this.say('no microphone — hearing only (this browser has no media devices)');
      return;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(this.inputId ? { deviceId: { exact: this.inputId } } : {}),
        },
      });
      this.inputId = this.mic.getAudioTracks()[0]?.getSettings().deviceId ?? this.inputId;
      this.say('');
    } catch (error) {
      this.say(`no microphone — hearing only (${error instanceof Error ? error.message : 'refused'})`);
    }
  }

    /**
   * Choose which microphone to use, and use it now. A choice made before the first gesture is honoured by the
   * gesture; a live voice is replaced rather than renegotiated, and the next state message rebuilds it.
   */
  async setInput(deviceId: string): Promise<void> {
    if (deviceId === this.inputId) return;
    this.inputId = deviceId;
    if (!this.mic) return;
    for (const id of [...this.links.keys()]) this.close(id);
    for (const track of this.mic.getTracks()) track.stop();
    this.mic = null;
    this.micAnalyser = null;
    await this.openMic();
    if (this.mic) this.meterMic();
    // A mute pressed earlier belongs on the new track too: the gesture and the choice arrive in either
    // order, and a stopped microphone that came back on because a device changed would be the worst of both.
    this.applyMute();
  }

  /** The numbers of every live connection: what the harness measures and a person can read out loud. */
  async readout(): Promise<VoiceReadout[]> {
    const out: VoiceReadout[] = [];
    for (const [id, link] of this.links) {
      let sentBytes = 0;
      let receivedBytes = 0;
      let receivedPackets = 0;
      const report = await link.pc.getStats();
      report.forEach(entry => {
        if (entry.type === 'outbound-rtp') sentBytes += (entry as { bytesSent?: number }).bytesSent ?? 0;
        if (entry.type === 'inbound-rtp') {
          receivedBytes += (entry as { bytesReceived?: number }).bytesReceived ?? 0;
          receivedPackets += (entry as { packetsReceived?: number }).packetsReceived ?? 0;
        }
      });
      out.push({
        id,
        level: link.level,
        connection: link.pc.connectionState,
        ice: link.pc.iceConnectionState,
        signaling: link.pc.signalingState,
        sentBytes,
        receivedBytes,
        receivedPackets,
      });
    }
    return out;
  }

  private say(what: string): void {
    this.notice = what;
    this.onNotice(what);
  }

  private link(id: number): Link {
    const existing = this.links.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [] }); // one network: nothing to traverse
    // One chain per voice: filter, panner, gain. The gain is last so nothing downstream can undo the
    // rule's fade to nothing.
    const gain = this.context!.createGain();
    gain.gain.value = 0;
    const pan = this.context!.createStereoPanner();
    pan.pan.value = 0;
    const filter = this.context!.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 13000;
    filter.Q.value = 0.7;
    filter.connect(pan);
    pan.connect(gain);
    gain.connect(this.context!.destination);
    const send = this.context!.createGain();
    send.gain.value = 0.2;
    if (this.hallSend) {
      pan.connect(send);
      send.connect(this.hallSend);
    }

    const link: Link = {
      pc,
      gain,
      pan,
      filter,
      send: this.hallSend ? send : null,
      distance: 0,
      space: null,
      level: 0,
      silenced: this.silenced.has(id),
      silentSince: null,
      opens: (this.me ?? Number.MAX_SAFE_INTEGER) < id,
      offered: false,
      answered: false,
      candidates: [],
      pull: null,
    };

    this.addMic(link);
    if (!this.mic) {
      // No microphone means I still want to hear: without a direction of my own the offer would carry no
      // audio at all, and a floor where half the people are silent is not a floor.
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    pc.onicecandidate = event => {
      if (event.candidate) this.send(signal(id, JSON.stringify({ candidate: event.candidate.toJSON() })));
    };
    pc.ontrack = event => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.context!.createMediaStreamSource(stream).connect(filter);
      // Chromium — WebView2, Edge, Chrome — plays a remote stream that goes into Web Audio alone as silence;
      // it only starts pulling one once a media element holds it. Muted, so the chain stays the only sound.
      const pull = new Audio();
      pull.muted = true;
      pull.srcObject = stream;
      void pull.play().catch(() => {});
      link.pull = pull;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close(id);
    };

    this.links.set(id, link);
    return link;
  }

  private addMic(link: Link): void {
    if (!this.mic || link.pc.getSenders().length > 0) return;
    for (const track of this.mic.getAudioTracks()) link.pc.addTrack(track, this.mic);
  }

  /**
   * An analyser on my own microphone, read back in `talking`. Deliberately not connected onward: a microphone
   * routed back out is a howl.
   */
  private meterMic(): void {
    if (!this.context || !this.mic) return;
    this.micAnalyser = this.context.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.mic).connect(this.micAnalyser);
  }

  /** The one reverb chain: send from every panner, a short dulled tail back into the mix. Built once, on the
   *  same gesture that opens the microphone. */
  private buildHall(): void {
    const context = this.context;
    if (!context || this.hall) return;
    const send = context.createGain();
    const hall = context.createConvolver();
    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3500;
    tone.Q.value = 0.5;
    const back = context.createGain();
    back.gain.value = this.hallLevel;
    send.connect(hall);
    hall.connect(tone);
    tone.connect(back);
    back.connect(context.destination);
    this.hallSend = send;
    this.hall = hall;
    this.hallReturn = back;
  }

  private applyLevel(link: Link): void {
    // Smoothed, so somebody walking past fades instead of clicking. The profile bends the rule's number,
    // never replaces it: `near` makes the middle of the range quieter, `wide` makes it louder.
    const gain = link.silenced ? 0 : Math.pow(link.level, SOUND_PROFILES[this.profile].curve);
    link.gain.gain.setTargetAtTime(gain, this.context!.currentTime, 0.08);
  }

  /** Who I have turned down by hand. Kept here, not on the links only, so a connection opened later is
   *  silenced before it has made a sound. */
  /** What the room I am in is: its floor area and how much it absorbs, both read from the plan. */
  private room: Room = { area: 0, absorption: 0.1 };
  /** The cutoff of a closed office and of an open floor, and what the room works out to right now. */
  private studio = 4500;
  private open = 12000;
  private cutoff = 12000;
  /** How fast the top of the tail dies, as a share of the whole: 0.1 is a carpeted room, 0.7 a bare hall. */
  private hf = 0.5;
  /** One reverb for the room I am in, fed from every voice after its panner: the dry signal keeps its place,
   *  the tail is shared. `null` until the first gesture, like the rest of the chain. */
  private hallSend: GainNode | null = null;
  private hall: ConvolverNode | null = null;
  private hallReturn: GainNode | null = null;
  private hallMax = 0.6;
  private hallLevel = 0.15;
  private hallSeconds = 0;

  /** Absorption, not size: at one ceiling height the floor area cancels out of Sabine's formula, and what is
   *  left is how much the room eats. A carpeted, furnished office takes the top off; a bare hall keeps it. */
  private roomCutoff(): number {
    const absorb = Math.max(0, Math.min(1, (this.room.absorption - 0.06) / 0.5));
    // A small room swallows the top twice over: its surfaces absorb, and sound crosses them more often per
    // second. That is why a phone booth is dead and a hall is not, at the same materials.
    const small = Math.max(0, Math.min(1, 1 - this.room.area / 160));
    const t = Math.max(0, Math.min(1, absorb + 0.35 * small));
    return this.open * Math.pow(this.studio / this.open, t);
  }

  /** Opens a connection before it is needed: the flight takes a moment, and a voice should not arrive after
   *  the person does. Silent until the rule gives it a level. */
  prewarm(ids: number[]): void {
    if (!this.context || !this.ready) return;
    for (const id of ids) {
      if (id === this.me || this.links.has(id)) continue;
      const link = this.link(id);
      link.level = 0;
      this.applyLevel(link);
      if (link.opens && !link.offered) void this.offer(link, id);
    }
  }

  /** What the room is doing to the voices, for the console: the room itself is the caller's to know. */
  roomShape(): { cutoff: number; seconds: number; hf: number } {
    return { cutoff: this.cutoff, seconds: this.hallSeconds, hf: this.hf };
  }

  /** Everything that depends on the room, applied to the voices already open. */
  private applyRoom(): void {
    this.cutoff = this.roomCutoff();
    const t = Math.max(0, Math.min(1, (this.room.absorption - 0.06) / 0.5));
    this.hf = 0.7 - 0.6 * t;
    // Sabine, with the house's three metres and a square room: volume over absorbing surface. The setting is
    // the lid, because no office should become a church.
    const area = Math.max(1, this.room.area);
    const volume = area * 3;
    const surface = 2 * area + 4 * Math.sqrt(area) * 3;
    const seconds = Math.min(this.hallMax, (0.161 * volume) / (Math.max(0.05, this.room.absorption) * surface));
    if (Math.abs(seconds - this.hallSeconds) > 0.04) this.fillHall(seconds);
    for (const link of this.links.values()) {
      if (link.space) this.applySpace(link, link.space.dx, link.space.dy, link.space.facing);
    }
  }

  /** Noise that dies away over the room's reverberation time, the top dying first. Fifteen milliseconds of
   *  silence, then one early reflection: without them a tail is a curtain, not a room. */
  private fillHall(seconds: number): void {
    const context = this.context;
    if (!context || !this.hall || !this.hallReturn) return;
    const rate = context.sampleRate;
    const pre = Math.round(0.015 * rate);
    const tail = Math.max(1, Math.round(seconds * rate));
    const buffer = context.createBuffer(1, pre + tail, rate);
    const data = buffer.getChannelData(0);
    let low = 0;
    let high = 0;
    for (let i = pre; i < pre + tail; i++) {
      const t = (i - pre) / tail;
      const noise = Math.random() * 2 - 1;
      low += 0.25 * (noise - low);
      high += 0.7 * (noise - high);
      const body = Math.exp(-6.9 * t);
      const top = Math.exp(-6.9 * Math.min(1, t / Math.max(0.05, this.hf)));
      data[i] = low * body + high * 0.5 * top;
    }
    const early = pre + Math.round(0.007 * rate);
    if (early < data.length) data[early] += 0.35;
    this.hallSeconds = seconds;
    // A tail swapped under a voice clicks: the return goes down for a moment and comes back.
    const now = context.currentTime;
    this.hallReturn.gain.setTargetAtTime(0, now, 0.01);
    this.hall.buffer = buffer;
    this.hallReturn.gain.setTargetAtTime(this.hallLevel, now + 0.06, 0.03);
  }

  /** The two settings the room is allowed: how long its tail may be, and how much of it reaches the ear. */
  setHall(maxSeconds: number, level: number): void {
    this.hallMax = Math.max(0, maxSeconds);
    this.hallLevel = Math.max(0, Math.min(0.5, level));
    if (this.hallReturn && this.context) {
      this.hallReturn.gain.setTargetAtTime(this.hallLevel, this.context.currentTime, 0.05);
    }
    this.applyRoom();
  }

  /** The two cutoffs the room is allowed: a closed office and an open floor. */
  setRoom(studio: number, open: number): void {
    this.studio = studio;
    this.open = open;
    this.applyRoom();
  }

  private silenced = new Set<number>();

  /** Turn named people down to nothing, for me only: the office is shared, whose voice is wanted is not. */
  setSilenced(ids: Set<number>): void {
    this.silenced = new Set(ids);
    for (const [id, link] of this.links) {
      link.silenced = ids.has(id);
      this.applyLevel(link);
    }
  }

  /** Which profile and which side, applied to every voice already open. */
  setSound(profile: SoundProfile, side: PanSide): void {
    this.profile = profile;
    this.side = side;
    for (const link of this.links.values()) {
      this.applyLevel(link);
      if (link.space) this.applySpace(link, link.space.dx, link.space.dy, link.space.facing);
    }
  }

    /**
   * Where a voice sits and how much air is in front of it. The pan is measured from my own face, not the page;
   * the filter is the distance. A wall is not a filter but the reason there is no voice at all.
   */
  private applySpace(link: Link, dx: number, dy: number, facing: Facing): void {
    link.space = { dx, dy, facing };
    const sound = SOUND_PROFILES[this.profile];
    // The way round, as the rule counted it: a voice behind a corner is further than the straight line.
    const distance = Math.max(0.001, link.distance);
    // Right of my own face — or right of the screen, for a listener who thinks of the map that way; the
    // screen's right turns with a turned view.
    const [fx, fy] = facingVector(facing);
    const across = this.side === 'user' ? dx * Math.cos(this.yaw) + dy * Math.sin(this.yaw) : dx * -fy + dy * fx;
    const side = Math.max(-1, Math.min(1, across / (distance + 1.2))) * sound.pan;
    const air = Math.min(1, distance / EARSHOT_M);
    // The nearer of two dullings: the air between us, and the room I am sitting in. A voice at arm's length in
    // a small office is still soft — that is what a room with carpet and shelves does.
    const cutoff = Math.min(sound.open * Math.pow(sound.closed / sound.open, air), this.cutoff);
    link.pan.pan.setTargetAtTime(side, this.context!.currentTime, 0.15);
    link.filter.frequency.setTargetAtTime(cutoff, this.context!.currentTime, 0.15);
    // A far voice is mostly room: the dry signal falls off with the air, the tail does not. Near voices stay dry.
    link.send?.gain.setTargetAtTime(0.1 + 0.9 * air, this.context!.currentTime, 0.1);
  }

  private async offer(link: Link, id: number): Promise<void> {
    link.offered = true;
    this.send(introduce(id));
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    this.send(signal(id, JSON.stringify({ description: link.pc.localDescription })));
  }

  private close(id: number): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    try {
      link.pc.close();
    } catch {
      // already gone
    }
    for (const node of [link.gain, link.pan, link.filter]) {
      try {
        node.disconnect();
      } catch {
        // already gone
      }
    }
    if (link.pull) link.pull.srcObject = null;
  }
}
