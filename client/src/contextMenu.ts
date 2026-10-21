/** A small menu at a point on the screen: the actions for one person, and a way out.
 *
 *  One menu at a time, closed by choosing, by clicking anywhere else, or by Escape — so a menu can never be
 *  left behind pointing at somebody who has walked away. */

export type MenuItem = {
  label: string;
  /** Why it cannot be chosen, said in the row rather than hidden behind a disabled button with no reason. */
  hint?: string;
  disabled?: boolean;
  onPick?: () => void;
};

let open: HTMLElement | null = null;

export function closeMenu(): void {
  open?.remove();
  open = null;
}

export function menuOpen(): boolean {
  return open !== null;
}

export function showMenu(x: number, y: number, title: string, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'ctx-head';
  head.textContent = title;
  menu.append(head);

  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ctx-item';
    row.setAttribute('role', 'menuitem');
    row.disabled = item.disabled === true;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'ctx-hint';
      hint.textContent = item.hint;
      row.append(hint);
    }
    row.addEventListener('click', () => {
      closeMenu();
      item.onPick?.();
    });
    menu.append(row);
  }

  // Measured before it is placed: a menu opened near the right edge would otherwise hang off the window.
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  open = menu;
}

// The menu belongs to the page, not to the canvas or the rail: a click anywhere else puts it away, and the
// capture phase means it is gone before the click that closed it can also walk somebody across the room.
document.addEventListener(
  'pointerdown',
  event => {
    if (open && !open.contains(event.target as Node)) closeMenu();
  },
  true,
);

document.addEventListener(
  'keydown',
  event => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      closeMenu();
    }
  },
  true,
);
