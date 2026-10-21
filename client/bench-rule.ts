// What the acoustic rule costs on this machine: one flood fill, one room, one audibility list.
import { readFileSync } from 'node:fs';
import { areaOf, within } from './src/hearing.ts';
import { roomOf } from './src/room.ts';

const plan = JSON.parse(readFileSync('../fixtures/floor-t1.json', 'utf8'));
const floor = plan.floors[0];
const cells = floor.cells;
const cellM = plan.cellM ?? 0.5;
console.log('Fläche:', cells.length, 'x', cells[0].length, 'Zellen');

const me = { id: 1, x: 2.25, y: 1.75 };
const others = Array.from({ length: 10 }, (_, i) => ({ id: i + 2, x: 3.25 + i * 0.5, y: 2.25 }));

function time(label, runs, fn) {
  fn();
  fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - t0) / runs;
  console.log(label.padEnd(34), (ms * 1000).toFixed(1), 'µs pro Aufruf');
  return ms;
}

time('areaOf (Flood Fill)', 2000, () => areaOf(cells, cellM, me));
time('roomOf (Sabine, Absorption)', 2000, () => {
  const reach = areaOf(cells, cellM, me);
  return roomOf(floor, reach);
});
time('within (10 Personen)', 2000, () => within(cells, cellM, me, others));

const both = time('areaOf + within zusammen', 2000, () => {
  const reach = areaOf(cells, cellM, me);
  return within(cells, cellM, me, others, reach);
});
console.log('Budget eines Ticks: 33.3 ms →', ((both / 33.3) * 100).toFixed(2), '% davon');
