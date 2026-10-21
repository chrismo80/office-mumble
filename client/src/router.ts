/**
 * The router: which place you are in, and what a place may reach. Four places, exactly one open, and a place is
 * not a panel over the map — the address says which is open, an unopened place is not in the document at all,
 * and the two editors are places of their own because an editor is not a feature among others.
 *
 * Pure, no DOM: address to place and back, the one key that leaves, and the two questions `main.ts` asks before
 * every edit — may this place change the building, may it change a figure. One home for the rule, not a habit
 * of the pointer handlers.
 */

/** The four places, by name. The names are the code's; the labels are what a person reads. */
export type View = 'office' | 'build' | 'figure' | 'settings';

export type Place = {
  id: View;
  /** What the rail and the title row call it. */
  label: string;
  /** The mark on the rail, so a collapsed rail is still a way to somewhere. */
  icon: string;
};

/** The places in the order the rail shows them: the office first, because it is where you are. */
export const PLACES: Place[] = [
  { id: 'office', label: 'Office', icon: '▦' },
  { id: 'build', label: 'Build', icon: '⊞' },
  { id: 'figure', label: 'You', icon: '☺' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

/** Where a fresh page opens, and where every key that leaves a place goes. */
export const DEFAULT_VIEW: View = 'office';

const IDS: ReadonlySet<string> = new Set(PLACES.map((place) => place.id));

export function isView(value: string): value is View {
  return IDS.has(value);
}

/**
 * The place an address names. Anything unknown is the office: a typo in a hash must not leave somebody staring at
 * an empty frame.
 */
export function viewOfHash(hash: string): View {
  const name = hash.replace(/^#\/?/, '').trim().toLowerCase();
  return isView(name) ? name : DEFAULT_VIEW;
}

/** The address that names a place, so a reload or a shared link lands in the same place. */
export function hashOfView(view: View): string {
  return `#/${view}`;
}

/**
 * Whether this place may change the building: Bauen alone. The office cannot, not because it refuses but because
 * it holds no tool that sends an edit.
 */
export function mayBuild(view: View): boolean {
  return view === 'build';
}

/**
 * Whether this place may change a figure: Du alone, and only when it hands the figure over — which is why a
 * refused colour leaves the draft alone rather than the server's figure.
 */
export function mayDressFigure(view: View): boolean {
  return view === 'figure';
}

/**
 * Where the one key that leaves goes. `null` means nowhere: the office is where every place falls back to, so Esc
 * there is not a journey.
 */
export function escapeTarget(view: View): View | null {
  return view === DEFAULT_VIEW ? null : DEFAULT_VIEW;
}
