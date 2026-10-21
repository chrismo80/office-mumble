import { describe, expect, it } from 'vitest';

import { commandsFor, filterCommands, type CommandInput } from './commands';

/** The smallest state a palette can be built from: in the office, nobody else about, no rooms named. */
const base: CommandInput = {
  view: 'office',
  muted: false,
  showAudible: false,
  people: [{ id: 1, name: 'Mira', me: true }],
  rooms: [],
};

const ids = (state: Partial<CommandInput>): string[] => commandsFor({ ...base, ...state }).map((row) => row.id);
const labels = (state: Partial<CommandInput>): string[] => commandsFor({ ...base, ...state }).map((row) => row.label);

describe('the rows a palette can be built from', () => {
  it('offers every act that has no place of its own', () => {
    expect(ids({})).toEqual(
      expect.arrayContaining(['mute', 'my-place', 'audible', 'open-build', 'open-figure', 'open-settings']),
    );
  });

  it('does not offer a place you are already in, rather than offering a row that does nothing', () => {
    expect(ids({ view: 'office' })).not.toContain('open-office');
    expect(ids({ view: 'office' })).toContain('open-build');
    expect(ids({ view: 'build' })).toContain('open-office');
    expect(ids({ view: 'build' })).not.toContain('open-build');
    expect(ids({ view: 'settings' })).not.toContain('open-settings');
  });

  it('names the switch by what it would do', () => {
    expect(labels({ muted: false })).toContain('Mute');
    expect(labels({ muted: true })).toContain('Open the microphone');
    expect(labels({ showAudible: false })).toContain('Show the audible area');
    expect(labels({ showAudible: true })).toContain('Hide the audible area');
  });

  it('shows the shortcut where there is one', () => {
    expect(commandsFor(base).find((row) => row.id === 'mute')?.keys).toBe('M');
    // Leaving to the office is a row only where you are not in the office, because Esc is already the way
    // out of a place and the office is where every place falls back to.
    expect(commandsFor({ ...base, view: 'build' }).find((row) => row.id === 'open-office')?.keys).toBe('⌘[');
    expect(ids({ view: 'build' })).toContain('open-office');
  });

  it('lists every colleague once but never me', () => {
    const rows = ids({
      people: [
        { id: 1, name: 'Mira', me: true },
        { id: 2, name: 'Jonas', me: false },
        { id: 7, name: 'Ada', me: false },
      ],
    });
    expect(rows.filter((id) => id.startsWith('to:'))).toEqual(['to:2', 'to:7']);
    expect(labels({ people: [{ id: 1, name: 'Mira', me: true }] })).not.toContain('To Mira');
  });

  it('carries the rooms the plan names and the floors it has', () => {
    expect(ids({ rooms: [{ text: 'Coffee kitchen', row: 3, col: 4 }] })).toContain('room:3:4');
    expect(labels({ rooms: [{ text: 'Coffee kitchen', row: 3, col: 4 }] })).toContain('Coffee kitchen');
  });

  it('never offers a way to change the building', () => {
    // The palette runs acts and jumps. An editor is a place, and a row that built a wall from the office
    // would be the very thing the review removed.
    const rows = commandsFor({ ...base, rooms: [{ text: 'Corridor', row: 1, col: 1 }] });
    expect(rows.every((row) => !/build:(wall|floor|door|void)/.test(row.id))).toBe(true);
  });
});

describe('searching the rows', () => {
  const rows = commandsFor({
    ...base,
    rooms: [{ text: 'Coffee kitchen', row: 3, col: 4 }],
    people: [
      { id: 1, name: 'Mira', me: true },
      { id: 2, name: 'Jonas', me: false },
    ],
  });

  it('shows everything when nothing is typed', () => {
    expect(filterCommands(rows, '')).toHaveLength(rows.length);
    expect(filterCommands(rows, '   ')).toHaveLength(rows.length);
  });

  it('finds a row by any part of what it says', () => {
    expect(filterCommands(rows, 'Mira').map((row) => row.id)).toEqual([]); // Mira is me: no row to walk to
    expect(filterCommands(rows, 'Jonas').map((row) => row.id)).toEqual(['to:2']);
    expect(filterCommands(rows, 'Coffee').map((row) => row.id)).toEqual(['room:3:4']);
  });

  it('folds a name with umlauts so a keyboard without them still finds it', () => {
    // Rooms and colleagues keep their own spelling, so a keyboard with no `ü` still has to reach `Küche`.
    const withRoom = commandsFor({ ...base, rooms: [{ text: 'Küche', row: 3, col: 4 }] });
    expect(filterCommands(withRoom, 'kuche').map((row) => row.id)).toEqual(['room:3:4']);
    expect(filterCommands(rows, 'audible').map((row) => row.id)).toEqual(['audible']);
  });

  it('leaves nothing rather than everything when nothing matches', () => {
    expect(filterCommands(rows, 'hovercraft')).toEqual([]);
  });
});
