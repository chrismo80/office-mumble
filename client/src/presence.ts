import type { PersonView } from './wire';

export type PresenceEvent = { text: string; at: number };

/** What has moved since the last state: who arrived, who left, who changed floor. The list is compared with
 *  the one before it, so the server says nothing new — a person's floor is already in the state. */
export class Watcher {
  private seen = new Map<number, { name: string; floor: number }>();
  private baseline = false;
  private events: PresenceEvent[] = [];

  /** Note the people as they are now, and give back what has happened in the last half minute, oldest first. */
  track(people: PersonView[], me: number, now: number): PresenceEvent[] {
    const next = new Map<number, { name: string; floor: number }>();
    for (const person of people) {
      const floor = person.floor ?? 0;
      const before = this.seen.get(person.id);
      if (this.baseline && person.id !== me) {
        if (!before) {
          this.note(`${person.name} arrived`, now);
        } else if (before.floor !== floor) {
          this.note(`${person.name} ${floor > before.floor ? 'went upstairs' : 'came downstairs'}`, now);
        }
      }
      next.set(person.id, { name: person.name, floor });
    }
    if (this.baseline) {
      for (const [id, before] of this.seen) {
        if (id !== me && !next.has(id)) this.note(`${before.name} left`, now);
      }
    }
    this.seen = next;
    // The first state is where everybody already is: a room full of "arrived" on every reload is noise.
    this.baseline = true;
    this.events = this.events.filter(event => now - event.at < 20_000);
    return this.events;
  }

  private note(text: string, at: number): void {
    this.events = [...this.events.slice(-4), { text, at }];
  }
}
