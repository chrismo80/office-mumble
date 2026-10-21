/**
 * The palette's rows: what can be done from anywhere and what can be jumped to, as data built by a pure
 * function so the list is testable without a browser. Not a menu of everything (a rail is for places) and not
 * a place to hide a tool: nothing here edits the plan.
 */

import type { View } from './router';

/** A row. `id` is what `main.ts` runs; everything else is what a person reads. */
export type Command = {
  id: string;
  /** The heading the row is filed under. */
  group: string;
  label: string;
  /** The keyboard shortcut, shown on the right where one exists. */
  keys?: string;
  /** Where it goes, for a jump: enough to tell two colleagues or two rooms apart. */
  detail?: string;
};

/** What the rows are built from: only what the client already knows. */
export type CommandInput = {
  view: View;
  muted: boolean;
  showAudible: boolean;
  /** Whether the room follows the clock — said here so the row can offer the opposite. */
  showLight?: boolean;
  people: Array<{ id: number; name: string; me: boolean }>;
  rooms: Array<{ text: string; row: number; col: number }>;
};

/**
 * Every row, in the order they are shown. Actions first — the things that have no place of their own —
 * then the places to jump to. A row that would do nothing is left out rather than shown dead: opening the
 * place you are already in is not an action.
 */
export function commandsFor(state: CommandInput): Command[] {
  const rows: Command[] = [];

  if (state.view !== 'office') rows.push({ id: 'open-office', group: 'Action', label: 'Go to the office', keys: '⌘[' });
  rows.push({ id: 'mute', group: 'Action', label: state.muted ? 'Open the microphone' : 'Mute', keys: 'M' });
  rows.push({ id: 'my-place', group: 'Action', label: 'To my place', detail: 'where you arrived' });
  if (state.view !== 'build') rows.push({ id: 'open-build', group: 'Action', label: 'Open Build' });
  if (state.view !== 'figure') rows.push({ id: 'open-figure', group: 'Action', label: 'Open You' });
  if (state.view !== 'settings') rows.push({ id: 'open-settings', group: 'Action', label: 'Settings' });
  rows.push({
    id: 'audible',
    group: 'Action',
    label: state.showAudible ? 'Hide the audible area' : 'Show the audible area',
  });
  rows.push({
    id: 'fit',
    group: 'Action',
    label: 'Show the whole floor',
    keys: '0',
  });
  rows.push({
    id: 'light',
    group: 'Action',
    label: state.showLight === false ? 'Follow the daylight' : 'Always daylight',
    detail: state.showLight === false ? 'the room reads the clock' : 'leave the clock out of the picture',
  });

  for (const person of state.people) {
    if (person.me) continue;
    rows.push({ id: `to:${person.id}`, group: 'Here', label: `To ${person.name}` });
  }
  for (const room of state.rooms) {
    rows.push({
      id: `room:${room.row}:${room.col}`,
      group: 'Rooms',
      label: room.text,
      detail: `${room.row} · ${room.col}`,
    });
  }
  return rows;
}

/** Diacritics folded away, so `cafe` finds `Café` and `uber` finds `Über`. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * The rows a query leaves, in the order they were given. An empty query is every row — a palette that
 * shows nothing until you type hides what can be typed for.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const needle = fold(query.trim());
  if (needle === '') return commands;
  return commands.filter((command) => fold(`${command.label} ${command.group} ${command.detail ?? ''}`).includes(needle));
}
