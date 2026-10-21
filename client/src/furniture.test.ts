import { describe, expect, it } from 'vitest';

import { CATALOGUE, nameOf, PIECES, searchCatalogue } from './furniture';

describe('the catalogue', () => {
  it('shows every modelled piece exactly once, and nothing that was not modelled', () => {
    const shown = CATALOGUE.flatMap(shelf => shelf.pieces.map(piece => piece.kind));
    expect(new Set(shown).size, 'a piece must not stand on two shelves').toBe(shown.length);
    expect([...shown].sort(), 'the catalogue and the models must name the same pieces').toEqual(Object.keys(PIECES).sort());
    for (const shelf of CATALOGUE) {
      expect(shelf.name.trim(), 'a shelf must have a heading').not.toBe('');
      for (const piece of shelf.pieces) expect(piece.name.trim(), `${piece.kind} must have a name`).not.toBe('');
    }
  });

  it('finds a piece by the name a person calls it, and by its model name', () => {
    const kinds = (query: string) => searchCatalogue(query).flatMap(shelf => shelf.pieces.map(piece => piece.kind));
    expect(kinds('corner sofa')).toEqual(['loungeSofaCorner']);
    expect(kinds('sofa'), 'the model name counts too').toEqual(['loungeSofaLong', 'loungeSofaCorner', 'loungeSofaOttoman']);
    expect(kinds('FRIDGE')).toEqual(['kitchenFridge', 'kitchenFridgeSmall']);
    expect(kinds('kitchen')).toHaveLength(10);
    expect(searchCatalogue('nothing of the sort')).toEqual([]);
    expect(searchCatalogue('  ')).toBe(CATALOGUE);
    expect(nameOf('desk')).toBe('Desk');
    expect(nameOf('somethingUnmodelled')).toBe('somethingUnmodelled');
  });
});
