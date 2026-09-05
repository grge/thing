/**
 * Minting events: the write path, without storage or transport.
 *
 * A `Writer` holds the state a writer needs to extend its own chain — the next
 * sequence number, the previous event's hash, and the Lamport clock — and knows
 * nothing about where events go afterwards.
 *
 * It exists here rather than in `peer` because the invariants it maintains are
 * the ones `chain.ts` checks, and keeping them in one package means the rules
 * and their enforcement cannot drift apart.
 */
import { type Event, type EventBody, eventId, signEvent, type Uuid } from './event.js';
import type { Hash } from './hash.js';
import type { KeyPair, PublicKey } from './sign.js';

export interface WriterState {
  readonly seq: number;
  readonly prev: Hash | null;
  readonly lamport: number;
}

/** Where a writer resumes from, given the events it has already written. */
export function resumeFrom(space: PublicKey, own: readonly Event[]): WriterState {
  if (own.length === 0) return { seq: 0, prev: null, lamport: 0 };
  const last = own[own.length - 1]!;
  return { seq: last.seq + 1, prev: eventId(space, last), lamport: last.lamport };
}

export class Writer {
  private seq: number;
  private prev: Hash | null;
  private lamport: number;

  constructor(
    private readonly space: PublicKey,
    private readonly key: KeyPair,
    state: WriterState = { seq: 0, prev: null, lamport: 0 },
  ) {
    this.seq = state.seq;
    this.prev = state.prev;
    this.lamport = state.lamport;
  }

  get state(): WriterState {
    return { seq: this.seq, prev: this.prev, lamport: this.lamport };
  }

  /**
   * Raise the clock on seeing someone else's events (§2.2).
   *
   * A writer's own stamps must strictly increase, and they must also exceed
   * anything it has observed, or a later write could lose to an earlier one it
   * already knew about.
   */
  observe(events: Iterable<EventBody>): void {
    for (const e of events) {
      if (e.lamport > this.lamport) this.lamport = e.lamport;
    }
  }

  /**
   * Mint and sign one event.
   *
   * `wall` is passed in rather than read from a clock, because this package has
   * no I/O and because a test that cannot control time cannot assert on
   * identity — two events differing only in `wall` are different events.
   */
  async write(target: Uuid, attr: string, value: Uint8Array, wall: number): Promise<Event> {
    this.lamport += 1;
    const body: EventBody = {
      writer: this.key.publicKey,
      seq: this.seq,
      prev: this.prev,
      lamport: this.lamport,
      target,
      attr,
      value,
      wall,
    };

    const event = await signEvent(this.space, body, this.key);
    this.seq += 1;
    this.prev = eventId(this.space, body);
    return event;
  }
}
