/**
 * Settings: the microphone to choose, what this window can honestly say about the sound and the wire, and
 * the three switches — mute, audible area, the clock — which are also reached from elsewhere.
 */

import type { PanSide, SoundProfile, Voices } from './voice';

/** How the room sounds: the two cutoffs that tell a small office from an open floor, and the tail between them. */
export type RoomSettings = { studio: number; open: number; hallMax: number; hallLevel: number };

export type SettingsHooks = {
  /** The mute switch was pressed. */
  toggleMute: () => void;
  /** The audible-area switch was pressed. */
  toggleAudible: () => void;
  /** The day-and-night switch was pressed: whether the room follows the clock. */
  toggleLight: () => void;
  /** A different sound profile or a different side was chosen. */
  chooseSound: (profile: SoundProfile, side: PanSide) => void;
  /** How far from the middle the view may be left alone before it follows, as a share of the half-window. */
  setDeadZone: (share: number) => void;
  /** The room's sound: cutoffs in hertz, tail in seconds, level as a share. */
  setRoom: (room: RoomSettings) => void;
  /** Take the cell I am standing on as the place I arrive at, or forget the one I have. */
  takeSeat: () => void;
  forgetSeat: () => void;
  /** Whether this place is the one open, so a device plugged in elsewhere is not listed for nobody. */
  isOpen: () => boolean;
  /** In the shell only: the name arrived under, and how to choose another — empty goes back to the system's. */
  name?: { current: () => string; give: (name: string) => void };
  /** The socket in use, so what this place says about encryption is about the wire and not about the page. */
  socket: () => string | null;
};

export class Settings {
  private readonly mute = document.querySelector<HTMLButtonElement>('#settings-mute')!;
  private readonly audible = document.querySelector<HTMLButtonElement>('#settings-audible')!;
  private readonly light = document.querySelector<HTMLButtonElement>('#settings-light')!;
  /** The three curves, as pictures: a profile is a shape, not a word to read. */
  private readonly profiles = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#sound-profile .profile'),
  );
  private readonly side = document.querySelector<HTMLSelectElement>('#sound-side')!;
  private readonly deadZone = document.querySelector<HTMLInputElement>('#settings-deadzone')!;
  private readonly seatPlace = document.querySelector<HTMLElement>('#settings-seat')!;
  private readonly seatSet = document.querySelector<HTMLButtonElement>('#settings-seat-set')!;
  private readonly seatClear = document.querySelector<HTMLButtonElement>('#settings-seat-clear')!;
  private readonly deadZoneValue = document.querySelector<HTMLOutputElement>('#settings-deadzone-value')!;
  private readonly roomStudio = document.querySelector<HTMLInputElement>('#room-studio')!;
  private readonly roomOpen = document.querySelector<HTMLInputElement>('#room-open')!;
  private readonly roomTail = document.querySelector<HTMLInputElement>('#room-tail')!;
  private readonly roomLevel = document.querySelector<HTMLInputElement>('#room-level')!;
  private readonly roomStudioValue = document.querySelector<HTMLOutputElement>('#room-studio-value')!;
  private readonly roomOpenValue = document.querySelector<HTMLOutputElement>('#room-open-value')!;
  private readonly roomTailValue = document.querySelector<HTMLOutputElement>('#room-tail-value')!;
  private readonly roomLevelValue = document.querySelector<HTMLOutputElement>('#room-level-value')!;
  private readonly micSelect = document.querySelector<HTMLSelectElement>('#mic-select')!;
  private readonly micWhy = document.querySelector<HTMLElement>('#mic-why')!;
  private readonly speakerWhy = document.querySelector<HTMLElement>('#speaker-why')!;
  private readonly link = document.querySelector<HTMLElement>('#settings-link')!;
  private readonly tls = document.querySelector<HTMLElement>('#settings-tls')!;
  private readonly cert = document.querySelector<HTMLElement>('#settings-cert')!;
  private readonly nameForm = document.querySelector<HTMLFormElement>('#name-form')!;
  private readonly nameInput = document.querySelector<HTMLInputElement>('#name-input')!;
  private profile: SoundProfile = 'room';

  constructor(private readonly voices: Voices, private readonly hooks: SettingsHooks) {
    const name = hooks.name;
    if (name) {
      this.nameForm.hidden = false;
      this.nameForm.addEventListener('submit', (event) => {
        event.preventDefault();
        name.give(this.nameInput.value);
        this.nameInput.blur();
      });
    }
    this.mute.addEventListener('click', () => hooks.toggleMute());
    this.audible.addEventListener('click', () => hooks.toggleAudible());
    this.light.addEventListener('click', () => hooks.toggleLight());
    for (const button of this.profiles) {
      button.addEventListener('click', () => {
        this.profile = button.dataset.profile as SoundProfile;
        this.showSound(this.profile, this.side.value as PanSide);
        hooks.chooseSound(this.profile, this.side.value as PanSide);
      });
    }
    this.side.addEventListener('change', () => hooks.chooseSound(this.profile, this.side.value as PanSide));
    this.seatSet.addEventListener('click', () => hooks.takeSeat());
    this.seatClear.addEventListener('click', () => hooks.forgetSeat());
    for (const slider of [this.roomStudio, this.roomOpen, this.roomTail, this.roomLevel]) {
      slider.addEventListener('input', () => hooks.setRoom(this.roomFromSliders()));
    }
    this.deadZone.addEventListener('input', () => {
      const share = Number(this.deadZone.value) / 100;
      this.showDeadZone(share);
      hooks.setDeadZone(share);
    });
    this.micSelect.addEventListener('change', () => {
      void this.voices.setInput(this.micSelect.value).then(() => this.refreshDevices());
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (hooks.isOpen()) void this.refreshDevices();
    });
  }

  /** The switches, drawn from the state wherever else they are on screen. */
  showSwitches(muted: boolean, audible: boolean, light: boolean): void {
    this.mute.setAttribute('aria-checked', muted ? 'true' : 'false');
    this.audible.setAttribute('aria-checked', audible ? 'true' : 'false');
    this.light.setAttribute('aria-checked', light ? 'true' : 'false');
  }

  /** The sound profile and the side, drawn from the state like the switches. */
  showSound(profile: SoundProfile, side: PanSide): void {
    this.profile = profile;
    for (const button of this.profiles) {
      button.setAttribute('aria-checked', button.dataset.profile === profile ? 'true' : 'false');
    }
    this.side.value = side;
  }

  /** Where I arrive, or that there is no place yet — the button says what it would do, not what it did. */
  showSeat(where: string | null): void {
    this.seatPlace.textContent = where ?? 'nowhere yet';
    this.seatClear.disabled = where === null;
  }

  /** The camera's dead zone, drawn from the value the client keeps like the other switches. */
  /** What the four sliders say, in the units the voices want: hertz, seconds, a share. */
  private roomFromSliders(): RoomSettings {
    return {
      studio: Number(this.roomStudio.value),
      open: Number(this.roomOpen.value),
      hallMax: Number(this.roomTail.value) / 100,
      hallLevel: Number(this.roomLevel.value) / 100,
    };
  }

  /** The room's settings as they are on this machine, put where the sliders are. */
  showRoom(room: RoomSettings): void {
    this.roomStudio.value = String(room.studio);
    this.roomOpen.value = String(room.open);
    this.roomTail.value = String(Math.round(room.hallMax * 100));
    this.roomLevel.value = String(Math.round(room.hallLevel * 100));
    this.roomStudioValue.textContent = `${(room.studio / 1000).toFixed(1)} kHz`;
    this.roomOpenValue.textContent = `${(room.open / 1000).toFixed(1)} kHz`;
    this.roomTailValue.textContent = `${room.hallMax.toFixed(1)} s`;
    this.roomLevelValue.textContent = `${Math.round(room.hallLevel * 100)}%`;
  }

  showDeadZone(share: number): void {
    const percent = Math.round(share * 100);
    this.deadZone.value = String(percent);
    this.deadZoneValue.textContent = `${percent}%`;
  }

  /** The wire, in the same words the status bar uses, so this place does not grow a second copy of it. */
  showLink(text: string): void {
    this.link.textContent = text;
  }

  /** Everything the settings place says about the wire, told plainly and without a guess. */
  refresh(): void {
    const name = this.hooks.name;
    if (name && document.activeElement !== this.nameInput) this.nameInput.value = name.current();
    const socket = this.hooks.socket();
    this.tls.textContent = socket === null
      ? 'Encryption: not connected yet.'
      : socket.startsWith('wss:')
        ? 'Encryption: TLS — the socket is encrypted.'
        : 'Encryption: no TLS — fine inside the house, not beyond the network.';
    this.cert.textContent = name
      ? 'Certificate: this app is built for one house and trusts exactly its certificate — no other, and'
        + ' without this machine having to do anything for it.'
      : "Certificate: this house issues its own. Whether the system trusts it is the browser's call alone —"
        + ' it connects or it does not. A window cannot read that, and a client that accepted any certificate'
        + ' is not one this project would ship.';
    void this.refreshDevices();
  }

  /**
   * What the browser will tell us, and nothing it will not: a page may list devices but cannot choose the
   * loudspeaker. The microphone is the client's own to choose, so that one is applied.
   */
  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.micWhy.textContent = 'this browser names no devices';
      this.speakerWhy.textContent = 'sound goes to the system default output';
      return;
    }
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      devices = [];
    }
    const inputs = devices.filter(device => device.kind === 'audioinput');
    const outputs = devices.filter(device => device.kind === 'audiooutput');

    const chosen = this.voices.inputDevice;
    this.micSelect.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Automatic (what the system picks)';
    this.micSelect.append(auto);
    inputs.forEach((device, index) => {
      const option = document.createElement('option');
      // A device with no label is one the browser will not name until a microphone has been granted; the
      // number is honest about that rather than inventing a name.
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1} (not yet known)`;
      this.micSelect.append(option);
    });
    this.micSelect.value = inputs.some(device => device.deviceId === chosen) ? chosen : '';
    this.micWhy.textContent = inputs.length === 0
      ? 'no microphone found — you still hear'
      : this.voices.hasMic
        ? 'open; a different choice applies the next time it opens'
        : 'opens on the first click';

    const speakers = outputs.map(device => device.label).filter(Boolean);
    this.speakerWhy.textContent = speakers.length === 0
      ? 'sound goes to the system default output — the window cannot route it'
      : `${speakers.join(', ')} — sound goes to the default output, not to a choice here`;
  }
}
