import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { within } from './hearing';
import { GRACE_MS, Voices } from './voice';

/** A microphone track whose `enabled` is what a stopped microphone must be: false is silence. */
type FakeTrack = { kind: string; enabled: boolean };

/** A microphone stream: a browser hands back one of these, and it is the tracks on it that matter. */
type FakeStream = { getAudioTracks: () => FakeTrack[] };

/**
 * The smallest Web Audio the voice class touches, so a test watches the track it is handed rather than a
 * browser's. Nothing here plays or negotiates; only the way `setMuted` reaches a track is under test.
 */
class FakeAudioContext {
  /** The pan and filter of every voice built, so a test can read where a voice was put and how dull. */
  static pans: Array<{ pan: { value: number } }> = [];
  static filters: Array<{ frequency: { value: number } }> = [];
  static gains: Array<{ gain: { value: number } }> = [];
  static impulses: Array<{ length: number }> = [];
  readonly destination = {};
  readonly currentTime = 0;
  readonly sampleRate = 48000;
  resume = async (): Promise<void> => {};
  createConvolver() {
    return { buffer: null, connect() {}, disconnect() {} };
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    const buffer = { length, getChannelData: () => data };
    FakeAudioContext.impulses.push(buffer);
    return buffer;
  }
  createGain() {
    const node = { gain: { value: 0, setTargetAtTime(v: number) { this.value = v; } }, connect() {}, disconnect() {} };
    FakeAudioContext.gains.push(node);
    return node;
  }
  createStereoPanner() {
    const node = { pan: { value: 0, setTargetAtTime(v: number) { this.value = v; } }, connect() {}, disconnect() {} };
    FakeAudioContext.pans.push(node);
    return node;
  }
  createBiquadFilter() {
    const node = {
      type: 'lowpass',
      frequency: { value: 0, setTargetAtTime(v: number) { this.value = v; } },
      Q: { value: 0 },
      connect() {},
      disconnect() {},
    };
    FakeAudioContext.filters.push(node);
    return node;
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
}

describe('a mute and a microphone arriving in either order', () => {
  let track: FakeTrack;

  beforeEach(() => {
    track = { kind: 'audio', enabled: true };
    const stream: FakeStream = { getAudioTracks: () => [track] };
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // The class only asks whether WebRTC exists; no peer connection is built in these tests.
    vi.stubGlobal('RTCPeerConnection', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('silences a microphone that is granted after the mute was pressed', async () => {
    // M before the first gesture: the state is recorded with no microphone to put it on.
    const voices = new Voices(() => {}, () => {});
    voices.setMuted(true);
    expect(voices.isMuted).toBe(true);

    // The gesture arrives and grants one. The track must come back already stopped, or the peer
    // connections would carry a microphone the person believes is off — the whole point of the mute.
    await voices.start();
    expect(track.enabled).toBe(false);
    expect(voices.isMuted).toBe(true);
    expect(voices.talking()).toBe(false);
  });

  it('holds a mute pressed while the microphone request is still in flight', async () => {
    // The keyboard does not wait for the permission dialog: M may land while `getUserMedia` is pending.
    let grant: ((stream: FakeStream) => void) | undefined;
    const stream: FakeStream = { getAudioTracks: () => [track] };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise<FakeStream>((resolve) => (grant = resolve)) },
    });

    const voices = new Voices(() => {}, () => {});
    const starting = voices.start();
    // Let `start` run as far as asking for the microphone, which is now parked awaiting the answer.
    await Promise.resolve();
    await Promise.resolve();
    expect(grant).toBeDefined();

    voices.setMuted(true);
    grant!(stream);
    await starting;

    expect(track.enabled).toBe(false);
    expect(voices.isMuted).toBe(true);
  });

  it('turns the track back on when the microphone is started again', async () => {
    const voices = new Voices(() => {}, () => {});
    await voices.start();
    expect(track.enabled).toBe(true);

    voices.setMuted(true);
    expect(track.enabled).toBe(false);
    voices.setMuted(false);
    expect(track.enabled).toBe(true);
    expect(voices.isMuted).toBe(false);
  });
});

/**
 * Just enough of a peer connection to see whether an offer is taken up: it records the description it is
 * handed and answers with one of its own. Nothing is negotiated and nothing is sent anywhere.
 */
class FakePeerConnection {
  static made = 0;
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string } | null = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = 'new';
  constructor() {
    FakePeerConnection.made++;
  }
  getSenders() {
    return [];
  }
  addTrack() {}
  addTransceiver() {}
  async setRemoteDescription(description: { type: string }) {
    this.remote = description;
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0' };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0' };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }
  async addIceCandidate() {}
  close() {}
}

describe('an offer from somebody my own rule does not hear', () => {
  const CELL_M = 0.5;
  /** One corridor, thirty metres long: room to stand far out of earshot and still in one area. */
  const corridor = [Array<string>(60).fill('floor')];
  /** The same corridor with a wall across it, between the two people. */
  const walled = [corridor[0].map((cell, col) => (col === 10 ? 'wall' : cell))];
  const me = { id: 2, x: 0.25, y: 0.25 };
  const near = { id: 1, x: 2.25, y: 0.25 };
  const far = { id: 1, x: 15.25, y: 0.25 };
  const offer = JSON.stringify({ description: { type: 'offer', sdp: 'v=0' } });

  let sent: string[];
  /** The answers sent: a signal whose payload carries a description of type `answer`. */
  const answers = () =>
    sent
      .map(text => JSON.parse(text) as { type: string; payload?: string })
      .filter(message => message.type === 'signal' && JSON.parse(message.payload ?? '{}').description?.type === 'answer');
  /** Let the promises an update starts but does not wait for run to their end. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  async function listening(): Promise<Voices> {
    const voices = new Voices(text => sent.push(text), () => {});
    voices.joined(me.id);
    await voices.start();
    return voices;
  }

  beforeEach(() => {
    sent = [];
    FakePeerConnection.made = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('MediaStream', class {});
    // No microphone: the connection still hears, and nothing here depends on a track.
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => Promise.reject(new Error('none')) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not answered, and no connection is built for it', async () => {
    const voices = await listening();
    voices.update(within(corridor, CELL_M, me, [me, far]), [me, far], me, { area: 25, absorption: 0.55 }, 0);

    await voices.received(far.id, 'introduction');
    await voices.received(far.id, 'signal', offer);

    expect(answers()).toEqual([]);
    expect(FakePeerConnection.made).toBe(0);
  });

  it('is answered once the rule hears them, because their state and mine may be a tick apart', async () => {
    const voices = await listening();
    voices.update(within(corridor, CELL_M, me, [me, far]), [me, far], me, { area: 25, absorption: 0.55 }, 0);
    await voices.received(far.id, 'signal', offer);
    expect(answers()).toEqual([]);

    voices.update(within(corridor, CELL_M, me, [me, near]), [me, near], me, { area: 25, absorption: 0.55 }, 100);
    await settle();

    expect(answers()).toHaveLength(1);
  });

  it('is dropped when the rule still does not hear them after the grace', async () => {
    const voices = await listening();
    voices.update(within(corridor, CELL_M, me, [me, far]), [me, far], me, { area: 25, absorption: 0.55 }, 0);
    await voices.received(far.id, 'signal', offer);

    voices.update(within(corridor, CELL_M, me, [me, far]), [me, far], me, { area: 25, absorption: 0.55 }, performance.now() + GRACE_MS + 1);
    voices.update(within(corridor, CELL_M, me, [me, near]), [me, near], me, { area: 25, absorption: 0.55 }, performance.now() + GRACE_MS + 100);
    await settle();

    expect(answers()).toEqual([]);
  });

  it('is dropped at once when a wall stands between us, whatever the distance', async () => {
    const voices = await listening();
    voices.update(within(walled, CELL_M, me, [me, { id: 1, x: 5.75, y: 0.25 }]), [me, { id: 1, x: 5.75, y: 0.25 }], me, { area: 25, absorption: 0.55 }, 0);
    await voices.received(far.id, 'signal', offer);

    voices.update(within(walled, CELL_M, me, [me, { id: 1, x: 5.75, y: 0.25 }]), [me, { id: 1, x: 5.75, y: 0.25 }], me, { area: 25, absorption: 0.55 }, 100);
    voices.update(within(corridor, CELL_M, me, [me, near]), [me, near], me, { area: 25, absorption: 0.55 }, 200);
    await settle();

    expect(answers()).toEqual([]);
  });

  it('is answered at once from somebody the rule already hears', async () => {
    const voices = await listening();
    voices.update(within(corridor, CELL_M, me, [me, near]), [me, near], me, { area: 25, absorption: 0.55 }, 0);

    await voices.received(near.id, 'signal', offer);

    expect(answers()).toHaveLength(1);
  });
});

/**
 * The sound is placed, not just faded: a voice comes from the side the person stands on, and the air
 * between us takes the top off it. The rule decides *whether* a voice arrives; these two decide how.
 */
describe('where a voice sits', () => {
  const CELL_M = 0.5;
  /** One open room, forty cells wide and ten deep, so everybody is in one area. */
  const room = Array.from({ length: 10 }, () => Array<string>(40).fill('floor'));
  const me = { id: 2, x: 10, y: 0.25 };

  async function listening(): Promise<Voices> {
    const voices = new Voices(() => {}, () => {});
    voices.joined(me.id);
    await voices.start();
    return voices;
  }

  beforeEach(() => {
    FakeAudioContext.pans = [];
    FakeAudioContext.filters = [];
    FakeAudioContext.gains = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => Promise.reject(new Error('none')) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts somebody on my left to my left, and somebody on my right to my right', async () => {
    const voices = await listening();

    voices.update(within(room, CELL_M, me, [me, { id: 1, x: 8.5, y: 0.25 }]), [me, { id: 1, x: 8.5, y: 0.25 }], me, { area: 25, absorption: 0.55 }, 0);
    voices.update(within(room, CELL_M, me, [me, { id: 3, x: 11.5, y: 0.25 }]), [me, { id: 3, x: 11.5, y: 0.25 }], me, { area: 25, absorption: 0.55 }, 0);

    const pans = FakeAudioContext.pans.map(node => node.pan.value);
    expect(pans.some(value => value < 0)).toBe(true);
    expect(pans.some(value => value > 0)).toBe(true);
  });

  it('leaves the pan alone when somebody stands straight ahead', async () => {
    const voices = await listening();
    voices.update(within(room, CELL_M, me, [me, { id: 1, x: 10, y: 2.25 }]), [me, { id: 1, x: 10, y: 2.25 }], me, { area: 25, absorption: 0.55 }, 0);

    expect(FakeAudioContext.pans[0].pan.value).toBeCloseTo(0, 6);
  });

  it('turns the pan with my own face, not with the page', async () => {
    // Looking south, the east side of the room is on my left; a pan fixed to the page would put it right.
    const east = { id: 1, x: 11.5, y: 0.25 };

    const north = await listening();
    north.update(within(room, CELL_M, me, [me, east]), [me, east], { ...me, facing: 'north' }, { area: 300, absorption: 0.1 }, 0);

    const south = await listening();
    south.update(within(room, CELL_M, me, [me, east]), [me, east], { ...me, facing: 'south' }, { area: 300, absorption: 0.1 }, 0);

    expect(FakeAudioContext.pans[0].pan.value).toBeGreaterThan(0);
    expect(FakeAudioContext.pans[1].pan.value).toBeLessThan(0);
  });

  it('bends the level with the profile, without changing who is audible', async () => {
    const voices = await listening();
    // Four metres: inside earshot, well outside arm's length.
    voices.update(within(room, CELL_M, me, [me, { id: 1, x: 14, y: 0.25 }]), [me, { id: 1, x: 14, y: 0.25 }], me, { area: 25, absorption: 0.55 }, 0);

    // The last two gains are the voice's own and its send; the reverb's nodes come first.
    const asRoom = FakeAudioContext.gains.at(-2)!.gain.value;
    voices.setSound('near', 'avatar');
    const asNear = FakeAudioContext.gains.at(-2)!.gain.value;
    voices.setSound('wide', 'avatar');
    const asWide = FakeAudioContext.gains.at(-2)!.gain.value;

    expect(asNear).toBeLessThan(asRoom);
    expect(asWide).toBeGreaterThan(asRoom);
  });

  it('can put the room on the screen side instead of the figure side', async () => {
    const voices = await listening();
    voices.setSound('room', 'user');
    // Facing south, the east side is on my left — but on the screen it is still on the right.
    voices.update(within(room, CELL_M, me, [me, { id: 1, x: 11.5, y: 0.25 }]), [me, { id: 1, x: 11.5, y: 0.25 }], { ...me, facing: 'south' }, { area: 300, absorption: 0.1 }, 0);

    expect(FakeAudioContext.pans[0].pan.value).toBeGreaterThan(0);

    // A view turned to look south puts the east side on the left of the screen, and the voice with it.
    voices.update(within(room, CELL_M, me, [me, { id: 1, x: 11.5, y: 0.25 }]), [me, { id: 1, x: 11.5, y: 0.25 }], { ...me, facing: 'south', yaw: Math.PI }, { area: 300, absorption: 0.1 }, 0);

    expect(FakeAudioContext.pans[0].pan.value, 'the screen side must turn with a turned view').toBeLessThan(0);
  });

  it('takes the top off a distant voice and leaves a near one open', async () => {
    const voices = await listening();

    voices.update(within(room, CELL_M, me, [me, { id: 1, x: 10.5, y: 0.25 }]), [me, { id: 1, x: 10.5, y: 0.25 }], me, { area: 300, absorption: 0.1 }, 0);   // half a metre away
    voices.update(within(room, CELL_M, me, [me, { id: 3, x: 17, y: 0.25 }]), [me, { id: 3, x: 17, y: 0.25 }], me, { area: 300, absorption: 0.1 }, 100);   // seven metres away

    // The last two filters are the voices'; the reverb's tone filter is built before them.
    const [near, far] = FakeAudioContext.filters.slice(-2).map(node => node.frequency.value);
    expect(near).toBeGreaterThan(far);
    // The far voice is not merely quiet: it has lost most of its top.
    expect(far).toBeLessThan(4000);
    expect(near).toBeGreaterThan(8000);
  });

  it('dulls even a near voice in a small closed room', async () => {
    const voices = await listening();
    const near = { id: 1, x: 10.5, y: 0.25 };
    voices.update(within(room, CELL_M, me, [me, near]), [me, near], me, { area: 25, absorption: 0.55 }, 0);

    // A hundred cells is a 5 x 5 m office: the room, not the distance, is what takes the top off.
    expect(FakeAudioContext.filters[0].frequency.value).toBeLessThan(5000);
  });

  it('gives a big room a longer tail than a small one, and never more than the setting', async () => {
    const voices = await listening();
    const near = { id: 1, x: 10.5, y: 0.25 };
    voices.setHall(0.6, 0.2);
    voices.update(within(room, CELL_M, me, [me, near]), [me, near], me, { area: 300, absorption: 0.1 }, 0);
    const big = FakeAudioContext.impulses.at(-1)!.length / 48000;
    voices.update(within(room, CELL_M, me, [me, near]), [me, near], me, { area: 25, absorption: 0.55 }, 0);
    const small = FakeAudioContext.impulses.at(-1)!.length / 48000;

    expect(big).toBeGreaterThan(small);
    // The setting is the tail; fifteen milliseconds of silence in front of it are the room's, not the tail's.
    expect(big).toBeLessThanOrEqual(0.63);
    expect(small).toBeGreaterThan(0);
  });
});
