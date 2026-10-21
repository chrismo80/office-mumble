import { describe, expect, it } from 'vitest';
import { Watcher } from './presence';

const person = (id: number, name: string, floor: number) => ({ id, name, floor }) as never;

describe('what has moved on the floor', () => {
  it('says nothing about the people who were already there', () => {
    const watch = new Watcher();
    expect(watch.track([person(1, 'Ada', 0), person(2, 'Bob', 0)], 9, 1000)).toEqual([]);
  });

  it('says who arrived and who left', () => {
    const watch = new Watcher();
    watch.track([person(1, 'Ada', 0)], 9, 1000);
    const arrived = watch.track([person(1, 'Ada', 0), person(2, 'Bob', 0)], 9, 1100);
    expect(arrived.at(-1)?.text).toBe('Bob arrived');

    const gone = watch.track([person(2, 'Bob', 0)], 9, 1200);
    expect(gone.at(-1)?.text).toBe('Ada left');
  });

  it('says which way a change of floor went, and forgets it after half a minute', () => {
    const watch = new Watcher();
    watch.track([person(1, 'Ada', 0)], 9, 1000);
    const up = watch.track([person(1, 'Ada', 1)], 9, 1100);
    expect(up.at(-1)?.text).toBe('Ada went upstairs');

    const down = watch.track([person(1, 'Ada', 0)], 9, 1200);
    expect(down.at(-1)?.text).toBe('Ada came downstairs');

    // Twenty seconds after the last word, the list is empty again: this is a glance, not a log.
    const later = watch.track([person(1, 'Ada', 0)], 9, 1200 + 20_001);
    expect(later).toEqual([]);
  });

  it('does not announce me to myself', () => {
    const watch = new Watcher();
    watch.track([], 9, 1000);
    const first = watch.track([person(9, 'Mira', 0)], 9, 1100);
    expect(first).toEqual([]);
  });
});
