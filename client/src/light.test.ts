import { describe, expect, it } from 'vitest';
import plan from '../../fixtures/floor-t1.json';
import { LAMP_REACH } from './light';

describe('the light in the evening', () => {
  it('comes from every lamp in the plan, and from nothing else', () => {
    const lamps = plan.floors.flatMap(floor => (floor.objects ?? []).filter(object => object.kind.startsWith('lamp')));
    expect(lamps.length).toBeGreaterThan(0);
    for (const lamp of lamps) {
      expect(LAMP_REACH[lamp.kind], `${lamp.kind} has no reach, so it would not light anything`).toBeDefined();
    }
  });
});
