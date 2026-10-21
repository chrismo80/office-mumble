import { describe, expect, it } from 'vitest';

import {
  colour,
  DEFAULT_PALETTE,
  defaultStyle,
  facingFrom,
  facingVector,
  paletteOf,
  PART_STYLES,
  partsOf,
  withColour,
  withPart,
} from './figure';

describe('the style a client starts in', () => {
  it('wears the bean in the app and stays flat in a browser', () => {
    expect(defaultStyle(true)).toBe('bean');
    expect(defaultStyle(false)).toBe('flat');
  });
});

describe('the way a figure faces', () => {
  it('reads a step as the cardinal direction it mostly goes', () => {
    expect(facingFrom(1, 0, 'south')).toBe('east');
    expect(facingFrom(-1, 0, 'north')).toBe('west');
    expect(facingFrom(0, 1, 'north')).toBe('south');
    expect(facingFrom(0, -1, 'south')).toBe('north');
    // A diagonal is read by its longer axis, and a tie is read as horizontal.
    expect(facingFrom(0.9, 0.1, 'south')).toBe('east');
    expect(facingFrom(0.1, -0.9, 'south')).toBe('north');
    expect(facingFrom(1, 1, 'south')).toBe('east');
  });

  it('keeps the way somebody already faced when they stand still', () => {
    expect(facingFrom(0, 0, 'west')).toBe('west');
    expect(facingFrom(0, 1e-12, 'north')).toBe('north');
  });

  it('points each facing the way a floor with rows growing downward does', () => {
    expect(facingVector('north')).toEqual([0, -1]);
    expect(facingVector('south')).toEqual([0, 1]);
    expect(facingVector('east')).toEqual([1, 0]);
    expect(facingVector('west')).toEqual([-1, 0]);
  });
});

describe('the colours a figure wears', () => {
  it('takes the figure that arrived, whole', () => {
    expect(
      paletteOf({ palette: { skin: '#112233', hair: '#445566', shirt: '#778899', trousers: '#aabbcc' } }),
    ).toEqual({ skin: '#112233', hair: '#445566', shirt: '#778899', trousers: '#aabbcc' });
  });

  it('draws somebody in the defaults when they arrived with no figure at all', () => {
    expect(paletteOf(undefined)).toEqual(DEFAULT_PALETTE);
    expect(paletteOf({})).toEqual(DEFAULT_PALETTE);
  });

  it('replaces a colour it cannot paint instead of losing the person', () => {
    expect(colour('not-a-colour', '#abcdef')).toBe('#abcdef');
    expect(colour(undefined, '#abcdef')).toBe('#abcdef');
    expect(colour(null, '#abcdef')).toBe('#abcdef');
    expect(colour('#ABCDFF', '#000000')).toBe('#ABCDFF');
    expect(colour('#abc', '#000000')).toBe('#000000'); // a short hex is not a colour
  });
});

describe('the styles a figure is drawn in', () => {
  it('names a small vocabulary for each part and draws the first of each by default', () => {
    expect(Object.keys(PART_STYLES).sort()).toEqual(['arms', 'body', 'head']);
    for (const styles of Object.values(PART_STYLES)) expect(styles.length).toBeGreaterThan(1);
    // Nothing chosen draws the same three styles the server means by an absent part.
    expect(partsOf(undefined)).toEqual({ head: 'round', body: 'plain', arms: 'sides' });
    expect(partsOf({})).toEqual({ head: 'round', body: 'plain', arms: 'sides' });
  });

  it('keeps a style the drawing knows and falls back for one it does not', () => {
    expect(partsOf({ parts: { head: 'bald', body: 'broad', arms: 'folded' } })).toEqual({
      head: 'bald',
      body: 'broad',
      arms: 'folded',
    });
    // A name nothing draws falls back to the default so somebody is never undrawable; the server refuses
    // such a name and never lets one out, so this is only a guard against an older or a wrong message.
    expect(partsOf({ parts: { head: 'crown' } }).head).toBe('round');
  });
});

describe('changing a figure in the editor', () => {
  it('sets a colour, keeps the rest, and refuses one a canvas cannot paint', () => {
    const figure = { palette: { skin: '#111111', hair: '#222222', shirt: '#333333', trousers: '#444444' } };
    const changed = withColour(figure, 'shirt', '#abcdef');
    expect(changed?.palette?.shirt).toBe('#abcdef');
    expect(changed?.palette?.skin).toBe('#111111');
    // Refused rather than repaired: none of these becomes the nearest colour that would work.
    expect(withColour(figure, 'shirt', 'abc')).toBeNull();
    expect(withColour(figure, 'shirt', '#abc')).toBeNull();
    expect(withColour(figure, 'shirt', 'rebeccapurple')).toBeNull();
    expect(withColour(figure, 'shirt', '')).toBeNull();
  });

  it('sets a part to a style the drawing knows and refuses a name it does not', () => {
    const figure = { parts: { head: 'round' } };
    expect(withPart(figure, 'head', 'bald')).toEqual({ parts: { head: 'bald' } });
    expect(withPart(figure, 'arms', 'open')).toEqual({ parts: { head: 'round', arms: 'open' } });
    expect(withPart(figure, 'body', 'hovercraft')).toBeNull();
    expect(withPart(figure, 'head', 'HEAD-ROUND')).toBeNull();
  });
});
