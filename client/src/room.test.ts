import { describe, expect, it } from 'vitest';
import { roomOf } from './room';

const floor = (surface: string, cells: string[][], extra: Record<string, unknown> = {}) =>
  ({ name: 'x', surface, cells, painted: [], objects: [], labels: [], stairs: [], ...extra }) as never;

const four = [['floor', 'floor'], ['floor', 'floor']];

describe('the room a plan describes', () => {
  it('eats more where there is carpet than where there is stone', () => {
    expect(roomOf(floor('carpet', four)).absorption).toBeGreaterThan(roomOf(floor('concrete', four)).absorption);
  });

  it('counts a rug painted over the floor, and the soft things standing on it', () => {
    const bare = roomOf(floor('concrete', four));
    const rug = roomOf(floor('concrete', four, { painted: [{ row: 0, col: 0, surface: 'carpet' }] }));
    const furnished = roomOf(floor('concrete', four, { objects: [{ kind: 'loungeSofaLong', row: 0, col: 0 }] }));

    expect(rug.absorption).toBeGreaterThan(bare.absorption);
    expect(furnished.absorption).toBeGreaterThan(bare.absorption);
  });

  it('has an area in square metres, not in cells', () => {
    expect(roomOf(floor('parquet', four)).area).toBe(1);
  });

  it('takes only the part of the floor a reach covers', () => {
    const whole = roomOf(floor('concrete', four));
    const one = roomOf(floor('concrete', four), new Map([[0, 0]]));

    expect(one.area).toBe(0.25);
    expect(one.area).toBeLessThan(whole.area);
  });
});
