/**
 * The shell: the rail, the title row, the presence rail, the status bar and the palette. It owns the furniture
 * and nothing else — told what to show, reporting what was asked for, which keeps "an editor is a place of its
 * own" a property of the layout.
 */

import { filterCommands, type Command } from './commands';
import { DEFAULT_VIEW, escapeTarget, hashOfView, PLACES, viewOfHash, type View } from './router';

export type PersonRow = {
  id: number;
  name: string;
  /** The colour the avatar wears: the figure's own shirt, so the rail and the map agree. */
  colour: string;
  talking: boolean;
  muted: boolean;
  me: boolean;
  /** Turned down by me, here. Not the same as their microphone: that is their own doing, this is mine. */
  silenced?: boolean;
  /** Where they are to me: heard, on my floor but out of reach, or a floor up or down. The rail draws it as one
   *  small mark, so the list itself can stay put while people come and go in and out of earshot. */
  where: 'earshot' | 'floor' | 'above' | 'below';
  /** The name of the floor they are on, when it is not mine. */
  floorName?: string;
};

export type PresenceData = {
  /** Everybody in the building, in one list and one order. Where each of them is to me is in the row, not in
   *  which block it sits in: a rail that re-sorts itself every tick is a rail nobody can read. */
  people: PersonRow[];
};

/** The test avatars that exist here and the recordings one may be given, for the sidebar's own block. */
export type AvatarsData = {
  /** The one demo figure this server offers, by name. */
  name: string;
  /** The recording it speaks, or `null` when this server has none to give — then there is nothing to make. */
  voice: string | null;
  /** Whether at least one of them is on the floor right now. */
  here: boolean;
  /** How many are on the floor: every press adds another, at the next free stop of its round. */
  count: number;
};

export type StatusData = {
  /** The connection, in words, with where it goes. */
  link: string;
  /** Whether the wire is up, which is what the rail's dot is about — never the microphone. */
  linkOk: boolean;
  mic: string;
  /** The microphone in two or three words, for the rail where there is no room for the sentence. */
  micShort: string;
  /** The microphone: `true` on, `false` stopped, `null` when there is nothing to say it about. */
  micOn: boolean | null;
  hud: string;
  hint: string;
  refuse: string;
};

export type ShellHooks = {
  /** The place changed. The host moves the map to whichever stage the new place shows. */
  onView: (view: View) => void;
  /** A palette row was chosen, by id. */
  onCommand: (id: string) => void;
  /** The rows the palette should offer right now. */
  commands: () => Command[];
  /** The one demo figure was asked for, or sent home: `on` says which. Its name and the recording it speaks
   *  are the server's settings, so this side never names them. */
  onDemoGuest: (on: boolean) => void;
  /** Somebody asked for the actions on a person — a right-click on their row, or the row's own menu button.
   *  Where it opens is the click's business, not this side's. */
  onPersonMenu: (person: PersonRow, x: number, y: number) => void;
};

export type Shell = {
  view: () => View;
  place: (view: View) => void;
  leave: () => void;
  railCollapsed: () => boolean;
  toggleRail: () => void;
  setFloorName: (name: string) => void;
  setWhereTail: (tail: string) => void;
  setStatus: (data: StatusData) => void;
  setPresence: (data: PresenceData) => void;
  setAvatars: (data: AvatarsData) => void;
  setBuildBadge: (who: string | null) => void;
  /** Somebody asks me to come over: who it is, and the two answers. `null` takes the ask away. */
  setSummon: (data: { from: string } | null, onGo: () => void, onNo: () => void) => void;
  /** What has just happened on the floor, oldest first: arrivals, departures, a change of floor. */
  setEvents: (lines: string[]) => void;
  /** The Build place carries its own way out, so the way out is where the work is. */
  showLeaveControl: (show: boolean) => void;
  paletteOpen: () => boolean;
  openPalette: () => void;
  closePalette: () => void;
};

const $ = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`the shell needs ${selector}`);
  return found;
};

/** Written down once, read by the rail: whether the rail is folded away is a person's choice, kept. */
const COLLAPSED_KEY = 'office-mumble.rail.collapsed';

export function createShell(hooks: ShellHooks): Shell {
  const rail = $<HTMLElement>('#rail');
  const railToggle = $<HTMLButtonElement>('#rail-toggle');
  const railNav = $<HTMLElement>('#rail-nav');
  const brandFloor = $<HTMLElement>('#brand-floor');
  const where = $<HTMLElement>('#where');
  const whereTail = document.createElement('span');
  const views = $<HTMLElement>('#views');
  const presence = $<HTMLElement>('#presence');
  const buildBadge = $<HTMLElement>('#build-badge');
  const railState = $<HTMLElement>('#rail-state');
  const railDot = $<HTMLElement>('#rail-dot');
  const railMic = $<HTMLElement>('#rail-mic');
  const railMicPill = $<HTMLElement>('#rail-mic-pill');
  const searchOpen = $<HTMLButtonElement>('#search-open');
  const statusLink = $<HTMLElement>('#status-link');
  const statusMic = $<HTMLElement>('#status-mic');
  const statusMicBtn = $<HTMLButtonElement>('#status-mic-btn');
  const hud = $<HTMLElement>('#hud');
  const statusHint = $<HTMLElement>('#status-hint');
  const statusRefuse = $<HTMLElement>('#status-refuse');
  const scrim = $<HTMLElement>('#palette');
  const paletteInput = $<HTMLInputElement>('#palette-input');
  const paletteList = $<HTMLUListElement>('#palette-list');
  const paletteNone = $<HTMLElement>('#palette-none');

  const navItems = new Map<View, HTMLButtonElement>();
  for (const place of PLACES) {
    const button = railNav.querySelector<HTMLButtonElement>(`[data-view="${place.id}"]`);
    if (!button) throw new Error(`the rail is missing the place ${place.id}`);
    button.addEventListener('click', () => place_(place.id));
    navItems.set(place.id, button);
  }

  // The way out of Build, in the title row where the work is: the same journey Esc makes, offered to a
  // hand that would rather not learn a key.
  const leaveControl = document.createElement('button');
  leaveControl.type = 'button';
  leaveControl.className = 'action';
  leaveControl.id = 'leave-view';
  leaveControl.innerHTML = 'Done <kbd>Esc</kbd>';
  leaveControl.hidden = true;
  leaveControl.addEventListener('click', () => place_(DEFAULT_VIEW));
  const searchWrapper = searchOpen.parentElement;
  searchWrapper?.insertBefore(leaveControl, searchOpen);

  let current: View = viewOfHash(location.hash);

  // ── the rail ───────────────────────────────────────────────────────────────

  function setCollapsed(collapsed: boolean): void {
    rail.classList.toggle('collapsed', collapsed);
    railToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const label = collapsed ? 'Navigation ausklappen' : 'Navigation einklappen';
    railToggle.setAttribute('aria-label', label);
    railToggle.title = label;
    railToggle.textContent = collapsed ? '»' : '«';
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // No storage (a private window, a locked-down webview): the rail collapses for this visit only.
    }
  }

  railToggle.addEventListener('click', () => setCollapsed(!rail.classList.contains('collapsed')));
  let remembered = false;
  try {
    remembered = localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    remembered = false;
  }
  setCollapsed(remembered);

  // ── the places ─────────────────────────────────────────────────────────────

  function apply(next: View, notify = true): void {
    for (const place of PLACES) {
      const section = views.querySelector<HTMLElement>(`[data-view="${place.id}"]`);
      if (section) section.hidden = place.id !== next;
      const item = navItems.get(place.id);
      if (item) {
        if (place.id === next) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
    }
    presence.hidden = next !== 'office';
    leaveControl.hidden = next !== 'build';
    const place = PLACES.find((entry) => entry.id === next);
    where.textContent = '';
    const strong = document.createElement('b');
    strong.textContent = place?.label ?? '';
    // A space between the place's name and whatever the place adds about itself: the two are inline and a
    // flex gap would not reach them.
    where.append(strong, document.createTextNode(' '), whereTail);
    document.title = `${place?.label ?? 'Office'} · Office Mumble`;
    if (hashOfView(next) !== location.hash) {
      // The address says where you are, so a reload or a shared link lands in the same place.
      history.replaceState(null, '', hashOfView(next));
    }
    if (notify) hooks.onView(next);
  }
  function place_(next: View): void {
    if (next === current) return;
    current = next;
    apply(next);
  }

  // A reload in the office is a no-op for the address; a reload anywhere else lands where it said.
  window.addEventListener('hashchange', () => {
    const wanted = viewOfHash(location.hash);
    if (wanted !== current) place_(wanted);
  });

  // ── the presence rail ──────────────────────────────────────────────────────

  let presenceSignature = '';

  function personRow(person: PersonRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'person';
    const avatar = document.createElement('div');
    avatar.className = `avatar${person.talking ? ' talking' : ''}${person.me ? ' me' : ''}`;
    avatar.style.background = person.colour;
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = person.name;
    row.append(avatar, name);
    // A filled dot is a voice I hear, an open one is somebody on my floor I cannot hear, an arrow is another
    // floor. It sits by the name, so it is read with it rather than hunted for at the end of the line.
    const where = document.createElement('span');
    where.className = `where ${person.where}`;
    where.textContent =
      person.where === 'earshot' ? '●' : person.where === 'floor' ? '○' : person.where === 'above' ? '↑' : '↓';
    where.title =
      person.where === 'earshot'
        ? 'in earshot'
        : person.where === 'floor'
          ? 'on this floor, out of earshot'
          : `on ${person.floorName ?? 'another floor'}`;
    row.append(where);
    if (person.muted || person.silenced) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = person.silenced ? '⊘' : '🔇';
      tag.title = person.silenced ? 'turned down for me' : 'microphone off';
      row.append(tag);
    } else if (person.talking) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '♪';
      tag.title = 'speaking now';
      row.append(tag);
    }
    // My own row has no actions: walking to myself is not a thing, and muting myself is the microphone.
    if (!person.me) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        hooks.onPersonMenu(person, event.clientX, event.clientY);
      });
      // A button as well as the right-click: on a touch screen and by keyboard there is no right-click, and a
      // menu that can only be reached one way is a menu half the office cannot open.
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'person-more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', `Actions for ${person.name}`);
      more.title = `Actions for ${person.name}`;
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        const box = more.getBoundingClientRect();
        hooks.onPersonMenu(person, box.left, box.bottom + 6);
      });
      row.append(more);
    }
    return row;
  }

  function section(title: string, empty: string, rows: HTMLElement[]): HTMLElement {
    const box = document.createElement('div');
    const head = document.createElement('span');
    head.className = 'sect';
    head.textContent = title;
    box.append(head);
    if (rows.length === 0) {
      const nothing = document.createElement('div');
      nothing.className = 'empty';
      nothing.textContent = empty;
      box.append(nothing);
    } else {
      for (const row of rows) box.append(row);
    }
    return box;
  }

  function setPresence(data: PresenceData): void {
    const signature = JSON.stringify(data);
    if (signature === presenceSignature) return;
    presenceSignature = signature;
    presence.textContent = '';
    // One list, everybody in the building, always in the same order. Who is near and who is far is a mark on
    // the row — the rail does not move people around, so a glance stays worth something.
    presence.append(section(`In the building · ${data.people.length}`, 'nobody here yet', data.people.map(personRow)));
    // The test figures and the events get their own blocks: they are not people, and `textContent = ''`
    // took them out, so they are put back every time.
    presence.append(figures, events);
  }

  // ── what just happened ────────────────────────────────────────────────────

  let eventsSignature = '';
  const events = document.createElement('div');
  events.className = 'events';

  /** A few lines, oldest first: no history, no scrolling — what has moved in the last half minute. */
  function setEvents(lines: string[]): void {
    const signature = lines.join('|');
    if (signature === eventsSignature) return;
    eventsSignature = signature;
    events.textContent = '';
    if (lines.length > 0) {
      const head = document.createElement('span');
      head.className = 'sect';
      head.textContent = 'Just now';
      events.append(head);
    }
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'event';
      row.textContent = line;
      events.append(row);
    }
  }

  // ── the test figures ──────────────────────────────────────────────────────

  let figuresSignature = '';
  const figures = document.createElement('div');
  figures.className = 'figures';

/**
 * The demo figure: a name and a button that goes on and off, nothing to choose first. Which recording it speaks
 * is the server's setting, so this side only asks or sends home — and a server with none says so.
 */
  function setAvatars(data: AvatarsData): void {
    const signature = JSON.stringify(data);
    if (signature === figuresSignature) return;
    figuresSignature = signature;
    figures.textContent = '';

    const head = document.createElement('span');
    head.className = 'sect';
    head.textContent = 'Test figures';
    figures.append(head);

    if (data.voice === null) {
      const none = document.createElement('div');
      none.className = 'empty';
      none.textContent = 'no demo recording on this server';
      none.title = 'OFFICE_MUMBLE_DEMO_VOICE nennt eine Aufnahme im Ordner des Servers';
      figures.append(none);
      return;
    }

    const row = document.createElement('div');
    row.className = 'person';
    const label = document.createElement('span');
    label.className = 'nm';
    label.textContent = data.count > 1 ? `${data.name} × ${data.count}` : data.name;
    label.title = `speaks ${data.voice}`;
    // Add is not a toggle any more: each press puts another figure on the floor, at the next free stop of
    // the round, so a whole building can be heard at once.
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'figure-make';
    add.textContent = 'add';
    add.title = `put another ${data.name} on the floor`;
    add.setAttribute('aria-label', add.title);
    add.addEventListener('click', () => hooks.onDemoGuest(true));
    row.append(label, add);
    if (data.count > 0) {
      const home = document.createElement('button');
      home.type = 'button';
      home.className = 'figure-home';
      home.textContent = 'all home';
      home.title = 'send every demo figure home';
      home.setAttribute('aria-label', home.title);
      home.addEventListener('click', () => hooks.onDemoGuest(false));
      row.append(home);
    }
    figures.append(row);
  }

  // ── somebody asks me to come over ─────────────────────────────────────────

  const summon = document.querySelector<HTMLElement>('#summon')!;
  const summonWhat = document.querySelector<HTMLElement>('#summon-what')!;
  let summonGo: (() => void) | null = null;
  let summonNo: (() => void) | null = null;
  document.querySelector('#summon-go')!.addEventListener('click', () => {
    summon.hidden = true;
    summonGo?.();
  });
  document.querySelector('#summon-no')!.addEventListener('click', () => {
    summon.hidden = true;
    summonNo?.();
  });

  /** The name is the whole point: "come over" without a face is a command, with one it is an invitation. */
  function setSummon(data: { from: string } | null, onGo: () => void, onNo: () => void): void {
    if (!data) {
      summon.hidden = true;
      return;
    }
    summonWhat.textContent = `${data.from} asks you to come over`;
    summonGo = onGo;
    summonNo = onNo;
    summon.hidden = false;
  }

  // ── the status bar ─────────────────────────────────────────────────────────

  let statusSignature = '';

  function setStatus(data: StatusData): void {
    const signature = JSON.stringify(data);
    if (signature === statusSignature) return;
    statusSignature = signature;
    statusLink.textContent = data.link;
    statusMic.textContent = data.mic;
    statusMicBtn.classList.toggle('on', data.micOn === true);
    statusMicBtn.classList.toggle('off', data.micOn === false);
    statusMicBtn.setAttribute('aria-pressed', data.micOn === false ? 'true' : 'false');
    hud.textContent = data.hud;
    statusHint.textContent = data.hint;
    // A refusal stays until the next one replaces it: transient chrome is what made the old one easy to miss.
    statusRefuse.textContent = data.refuse;
    railState.textContent = data.link;
    // The dot is the wire and the pill is the microphone: two facts, told apart, so a stopped microphone
    // never reads as a broken connection.
    railDot.classList.toggle('off', !data.linkOk);
    railMic.textContent = data.micShort;
    railMicPill.classList.toggle('muted', data.micOn === false);
  }

  // ── the command palette ────────────────────────────────────────────────────

  let paletteIsOpen = false;
  let rows: Command[] = [];
  let active = 0;
  /** What had focus before the dialog opened, so it can be given back when it closes. */
  let returnFocus: HTMLElement | null = null;

  function renderRows(): void {
    const query = paletteInput.value;
    rows = filterCommands(hooks.commands(), query);
    if (active >= rows.length) active = Math.max(0, rows.length - 1);
    paletteList.textContent = '';
    rows.forEach((row, index) => {
      const item = document.createElement('li');
      item.id = `palette-row-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === active ? 'true' : 'false');
      const group = document.createElement('span');
      group.className = 'grp';
      group.textContent = row.group;
      const label = document.createElement('span');
      label.textContent = row.label;
      item.append(group, label);
      if (row.detail) {
        const detail = document.createElement('span');
        detail.className = 'tag';
        detail.style.color = 'var(--ink-faint)';
        detail.textContent = row.detail;
        item.append(detail);
      }
      if (row.keys) {
        const keys = document.createElement('span');
        keys.className = 'keys';
        const kbd = document.createElement('kbd');
        kbd.textContent = row.keys;
        keys.append(kbd);
        item.append(keys);
      }
      item.addEventListener('mousemove', () => {
        if (active === index) return;
        active = index;
        paintActive();
      });
      item.addEventListener('click', () => run(index));
      paletteList.append(item);
    });
    paletteNone.hidden = rows.length > 0;
    paintActive();
  }

  function paintActive(): void {
    Array.from(paletteList.children).forEach((child, index) => {
      const selected = index === active;
      child.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) child.scrollIntoView({ block: 'nearest' });
    });
    if (rows[active]) paletteInput.setAttribute('aria-activedescendant', `palette-row-${active}`);
    else paletteInput.removeAttribute('aria-activedescendant');
  }

  function run(index: number): void {
    const row = rows[index];
    if (!row) return;
    closePalette();
    hooks.onCommand(row.id);
  }

  function openPalette(): void {
    if (paletteIsOpen) return;
    paletteIsOpen = true;
    returnFocus = (document.activeElement as HTMLElement) ?? null;
    scrim.hidden = false;
    paletteInput.value = '';
    active = 0;
    renderRows();
    paletteInput.focus();
  }

  function closePalette(): void {
    if (!paletteIsOpen) return;
    paletteIsOpen = false;
    scrim.hidden = true;
    rows = [];
    // Focus goes back where it came from, so a keyboard never lands nowhere after a dialog.
    const back = returnFocus && document.contains(returnFocus) ? returnFocus : searchOpen;
    returnFocus = null;
    back.focus();
  }

  paletteInput.addEventListener('input', () => {
    active = 0;
    renderRows();
  });
  paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = rows.length === 0 ? 0 : (active + 1) % rows.length;
      paintActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = rows.length === 0 ? 0 : (active - 1 + rows.length) % rows.length;
      paintActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    } else if (event.key === 'Tab') {
      // One focusable thing inside a modal dialog: Tab stays on it rather than wandering behind the scrim.
      event.preventDefault();
    }
  });
  scrim.addEventListener('pointerdown', (event) => {
    if (event.target === scrim) closePalette();
  });
  searchOpen.addEventListener('click', openPalette);

      // Applied outright rather than through `place_`: at boot the address already names it, and the guard
      // against re-entering would skip the first application. The host announces it itself on return.
  apply(current, false);

  return {
    view: () => current,
    place: place_,
    leave: () => {
      const target = escapeTarget(current);
      if (target) place_(target);
    },
    railCollapsed: () => rail.classList.contains('collapsed'),
    toggleRail: () => setCollapsed(!rail.classList.contains('collapsed')),
    setFloorName: (name: string) => {
      brandFloor.textContent = name;
    },
    setWhereTail: (tail: string) => {
      whereTail.textContent = tail;
    },
    setStatus,
    setPresence,
    setAvatars,
    setBuildBadge: (who: string | null) => {
      buildBadge.hidden = who === null;
      buildBadge.textContent = who ?? '';
      // The badge is the rail's own mark of who is building, and its `title` says it in full for a rail
      // that is collapsed and for anybody who cannot see the pill.
      buildBadge.title = who ? `${who} is building` : '';
    },
    setSummon,
    setEvents,
    showLeaveControl: (show: boolean) => {
      leaveControl.hidden = !show;
    },
    paletteOpen: () => paletteIsOpen,
    openPalette,
    closePalette,
  };
}
