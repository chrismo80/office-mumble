/**
 * Du: the figure editor. A row of styles for each part, four colour wells, and a live miniature of myself.
 *
 * It writes to a draft and nowhere else. The server hears about my figure once, when I hand it over, so
 * Abbrechen leaves the figure everybody else is drawing exactly where it was.
 */

import {
  DEFAULT_PALETTE,
  drawFigure,
  FIGURE_HEIGHT_R,
  paletteOf,
  PART_STYLES,
  partsOf,
  withColour,
  withPart,
  type PaletteKey,
  type PartKey,
} from './figure';
import type { Figure } from './wire';

export type FigureEditorHooks = {
  /** Abbrechen: leave the place, the draft forgotten. */
  cancel: () => void;
  /** Hand over: the draft, handed over. Whether it may be is the host's to ask. */
  apply: (figure: Figure) => void;
  /** Something the editor itself refused, in words. */
  refuse: (reason: string) => void;
};

export class FigureEditor {
  /** The working copy. It is mine alone until hand-over, which is what makes Cancel able to leave the
   *  server's figure untouched rather than merely look as though it did. */
  draft: Figure = {};

  private readonly preview = document.querySelector<HTMLCanvasElement>('#figure-preview')!;
  private readonly nameLine = document.querySelector<HTMLElement>('#figure-name')!;
  private readonly colourRow = document.querySelector<HTMLDivElement>('#figure-colours')!;
  /** The rows the style buttons go in, one per part. */
  private readonly partRows: Record<PartKey, HTMLDivElement> = {
    head: document.querySelector<HTMLDivElement>('#figure-head')!,
    body: document.querySelector<HTMLDivElement>('#figure-body')!,
    arms: document.querySelector<HTMLDivElement>('#figure-arms')!,
  };

  constructor(private readonly hooks: FigureEditorHooks) {}

  /** Put the buttons and the colour wells in, and wire Cancel and Hand over. */
  fill(): void {
    for (const part of Object.keys(PART_STYLES) as PartKey[]) {
      for (const style of PART_STYLES[part]) {
        const button = document.createElement('button');
        button.className = 'chip';
        button.textContent = style;
        button.dataset.part = part;
        button.dataset.style = style;
        button.addEventListener('click', () => {
          // A style off the list is refused here the way the server refuses it, rather than drawn as
          // something else; the buttons only ever offer styles off the list, so this never fires.
          const next = withPart(this.draft, part, style);
          if (next) {
            this.draft = next;
            this.render();
          }
        });
        this.partRows[part].append(button);
      }
    }
    for (const key of Object.keys(DEFAULT_PALETTE) as PaletteKey[]) {
      const well = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'color';
      input.dataset.colour = key;
      input.title = key;
      input.value = DEFAULT_PALETTE[key];
      input.setAttribute('aria-label', key);
      input.addEventListener('input', () => {
        const next = withColour(this.draft, key, input.value);
        if (next) {
          this.draft = next;
          this.drawPreview();
        } else {
          // A colour the canvas cannot paint is refused and nothing is written: a figure the server would
          // refuse is not worth handing over, and quietly replacing it would be repairing.
          this.hooks.refuse(`${input.value} is not a #rrggbb colour`);
        }
      });
      well.append(input, document.createTextNode(key));
      this.colourRow.append(well);
    }
    document.querySelector<HTMLButtonElement>('#figure-cancel')!.addEventListener('click', () => this.hooks.cancel());
    document.querySelector<HTMLButtonElement>('#figure-apply')!.addEventListener('click', () => this.hooks.apply({ ...this.draft }));
    this.render();
  }

  /** Open the editor on a copy of the figure in force: what happens here happens to nobody until hand-over. */
  enter(figure: Figure | null, name: string): void {
    this.draft = { ...(figure ?? {}) };
    this.showName(name);
    this.render();
  }

  showName(name: string): void {
    this.nameLine.textContent = name || 'ohne Namen';
  }

  /** Draw the editor from the draft: which style is on, the colours in the wells. */
  private render(): void {
    const parts = partsOf(this.draft);
    for (const part of Object.keys(PART_STYLES) as PartKey[]) {
      for (const button of Array.from(this.partRows[part].querySelectorAll<HTMLButtonElement>('button'))) {
        button.classList.toggle('on', button.dataset.style === parts[part]);
      }
    }
    const palette = paletteOf(this.draft);
    for (const input of Array.from(this.colourRow.querySelectorAll<HTMLInputElement>('input[data-colour]'))) {
      const key = input.dataset.colour as PaletteKey;
      if (input.value.toLowerCase() !== palette[key].toLowerCase()) input.value = palette[key];
    }
    this.drawPreview();
  }

  /** The little figure of myself in the editor, drawn the same way the office draws me — from the draft, so
   *  what the preview shows is what hand-over would send and nothing else. */
  private drawPreview(): void {
    const context = this.preview.getContext('2d');
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 150;
    const h = 184;
    this.preview.width = Math.round(w * dpr);
    this.preview.height = Math.round(h * dpr);
    this.preview.style.width = `${w}px`;
    this.preview.style.height = `${h}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, w, h);
    // Facing north, so the head is at the top: a portrait of the figure rather than a map symbol.
    // Standing on the bottom of the preview, facing whoever is looking at it.
    // As large as the preview holds: head to feet, with room for the ring under them.
    drawFigure(context, w / 2, h - 22, (h - 34) / FIGURE_HEIGHT_R, 'south', paletteOf(this.draft), partsOf(this.draft), true);
  }
}
