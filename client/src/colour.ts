/**
 * One shade of a colour, used by everything that draws: furniture, figures, floors and light.
 *
 * Negative darkens, positive lightens. Hex and `rgb()`/`rgba()` both come in, because a shade of a shade is
 * asked for in a few places and the result is already `rgb()`.
 */
export function shade(colour: string, amount: number): string {
  const listed = colour.startsWith('rgb') ? colour.match(/[\d.]+/g)!.map(Number) : null;
  const n = listed ? 0 : Number.parseInt(colour.slice(1), 16);
  const [r, g, b] = listed ? listed.slice(0, 3) : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mix = (c: number): number => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  return listed && listed.length > 3
    ? `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${listed[3]})`
    : `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
