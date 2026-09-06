/**
 * Minting events: the write path, without storage or transport.
 *
 * A `Writer` holds the state one process needs to extend **one chain** — its
 * append point, the next sequence number, the previous event's hash, and the
 * Lamport clock — and knows nothing about where events go afterwards.
 *
 * **One `Writer` is one append point, and a process makes its own.** Two
 * processes holding the same key each construct their own, so they extend
 * separate chains and never contend for a sequence number (§2.1's `Point`).
 *
 * It exists here rather than in `peer` because the invariants it maintains are
 * the ones `chain.ts` checks, and keeping them in one package means the rules
 * and their enforcement cannot drift apart.
 */
import { chainOf } from './chain.js';
import { type Event, type EventBody, eventId, newPoint, type Point, signEvent, type Uuid } from './event.js';
import type { Hash } from './hash.js';
import type { KeyPair, PublicKey } from './sign.js';

export interface WriterState {
  /** Which chain this state belongs to. */
  readonly point: Point;
  readonly seq: number;
  readonly prev: Hash | null;
  readonly lamport: number;
}

/**
 * Where a process resumes from, given a log it may not have written all of.
 *
 * **A new point, always.** `own` is every event this *identity* has written,
 * across however many processes; resuming one of those chains would mean
 * guessing that its owner has stopped, and being wrong produces the fork this
 * design exists to prevent. Starting a fresh chain costs one version-vector
 * entry and cannot be wrong.
 *
 * What does carry over is the Lamport clock, which must exceed everything this
 * identity has already stamped or a later write could lose to an earlier one
 * (§2.2).
 */
export function resumeFrom(_space: PublicKey, own: readonly Event[]): WriterState {
  let lamport = 0;
  for (const e of own) if (e.lamport > lamport) lamport = e.lamport;
  return { point: newPoint(), seq: 0, prev: null, lamport };
}

export class Writer {
  private readonly point: Point;
  private seq: number;
  private prev: Hash | null;
  private lamport: number;

  constructor(
    private readonly space: PublicKey,
    private readonly key: KeyPair,
    state: WriterState = { point: newPoint(), seq: 0, prev: null, lamport: 0 },
  ) {
    this.point = state.point;
    this.seq = state.seq;
    this.prev = state.prev;
    this.lamport = state.lamport;
  }

  /** This writer's chain id, for asking a store about its own events. */
  get chain(): string {
    return chainOf({ writer: this.key.publicKey, point: this.point });
  }

  get state(): WriterState {
    return { point: this.point, seq: this.seq, prev: this.prev, lamport: this.lamport };
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
      point: this.point,
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
