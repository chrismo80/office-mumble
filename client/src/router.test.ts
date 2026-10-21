import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEW, escapeTarget, hashOfView, isView, mayBuild, mayDressFigure, PLACES, viewOfHash } from './router';

describe('the places the client has', () => {
  it('names four, the office first, each with a label and a mark', () => {
    expect(PLACES.map((place) => place.id)).toEqual(['office', 'build', 'figure', 'settings']);
    expect(PLACES.map((place) => place.label)).toEqual(['Office', 'Build', 'You', 'Settings']);
    for (const place of PLACES) {
      expect(place.icon.trim()).not.toBe('');
      expect(place.label.trim()).not.toBe('');
    }
    expect(DEFAULT_VIEW).toBe('office');
  });

  it('knows the four and refuses anything else', () => {
    for (const place of PLACES) expect(isView(place.id)).toBe(true);
    expect(isView('walk')).toBe(false);
    expect(isView('')).toBe(false);
    expect(isView('Office')).toBe(false);
  });
});

describe('an address naming a place', () => {
  it('reads a place out of the hash, with or without the slash', () => {
    expect(viewOfHash('#/build')).toBe('build');
    expect(viewOfHash('#build')).toBe('build');
    expect(viewOfHash('#/figure')).toBe('figure');
    expect(viewOfHash('#/settings')).toBe('settings');
  });

  it('opens the office when the address names nothing it knows', () => {
    // A typo must not leave somebody staring at an empty frame, so the fallback is the one place that is
    // always safe to be in.
    expect(viewOfHash('')).toBe('office');
    expect(viewOfHash('#')).toBe('office');
    expect(viewOfHash('#/nowhere')).toBe('office');
    expect(viewOfHash('#/')).toBe('office');
  });

  it('writes an address that reads back as the same place', () => {
    for (const place of PLACES) expect(viewOfHash(hashOfView(place.id))).toBe(place.id);
  });
});

describe('what a place may reach', () => {
  it('lets one place change the building, and it is the editor', () => {
    expect(mayBuild('build')).toBe(true);
    expect(mayBuild('office')).toBe(false);
    expect(mayBuild('figure')).toBe(false);
    expect(mayBuild('settings')).toBe(false);
  });

  it('lets one place change a figure, and it is the figure editor', () => {
    expect(mayDressFigure('figure')).toBe(true);
    expect(mayDressFigure('office')).toBe(false);
    expect(mayDressFigure('build')).toBe(false);
    expect(mayDressFigure('settings')).toBe(false);
  });

  it('has the office as the only place to fall back to, and no journey out of it', () => {
    expect(escapeTarget('office')).toBeNull();
    expect(escapeTarget('build')).toBe('office');
    expect(escapeTarget('figure')).toBe('office');
    expect(escapeTarget('settings')).toBe('office');
  });
});
