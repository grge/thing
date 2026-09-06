/**
 * Per-writer chains, and the comparison key merge rules resolve by.
 *
 * Within a writer, order is exact: each event carries the hash of that writer's
 * previous one, so a gap or a fork is detectable (ARCHITECTURE.md §2.2).
 * Between writers there is no order and none is needed.
 */
import { compareBytes, hex } from './bytes.js';
import { type Event, type EventBody, eventId } from './event.js';
import type { Hash } from './hash.js';
import type { PublicKey } from './sign.js';

/**
 * The key merge rules compare by (§2.2, §7.3).
 *
 * Three components, and the third is not decoration. `(lamport, writer)` alone
 * is *not* a total order: two events from one writer at one lamport compare
 * equal, which is exactly what a forked chain produces when a key is used on two
 * devices (§7.3). Without a third component the winner falls back to arrival
 * order, and two peers holding the same events disagree — the failure the whole
 * design exists to prevent.
 */
export interface Key {
  readonly lamport: number;
  readonly writer: PublicKey;
  /** The event's own id. Distinct for distinct events, so ties always break. */
  readonly id: Hash;
}

export function keyOf(space: PublicKey, e: EventBody): Key {
  return { lamport: e.lamport, writer: e.writer, id: eventId(space, e) };
}

/** Total order over distinct events. Returns 0 only for the same event. */
export function compareKeys(a: Key, b: Key): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  const byWriter = compareBytes(a.writer, b.writer);
  if (byWriter !== 0) return byWriter;
  return compareBytes(a.id, b.id);
}

/** `⊥`: less than every key. Null keeps the absent case in one place. */
export type MaybeKey = Key | null;

export function greater(a: MaybeKey, b: MaybeKey): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return compareKeys(a, b) > 0;
}

export function maxKey(a: MaybeKey, b: MaybeKey): MaybeKey {
  return greater(b, a) ? b : a;
}

/* ── chain validation ───────────────────────────────────────────────────── */

export type ChainFault =
  | { readonly kind: 'seq-zero-has-prev' }
  | { readonly kind: 'seq-nonzero-lacks-prev' }
  | { readonly kind: 'prev-mismatch'; readonly expected: Hash; readonly got: Hash }
  | { readonly kind: 'seq-not-contiguous'; readonly expected: number; readonly got: number }
  | { readonly kind: 'lamport-not-increasing'; readonly previous: number; readonly got: number };

/**
 * Check that `event` extends `previous` in the same chain.
 *
 * A chain is `(writer, point)` — one process's run of writes under one
 * identity — so `previous` is the last event of *that* chain, not of that
 * writer. `previous` is null when `event` should be the chain's first. Returns null
 * when the link is sound, or the fault when it is not — a return value rather
 * than an exception, because the caller decides what a bad link means: a peer
 * drops the event, a store refuses the append, a diagnostic reports it.
 *
 * **Lamport is checked here too.** §2.2's comparison key is a total order only
 * because a writer's own lamports strictly increase, and nothing else enforces
 * that. A writer that reused a stamp would degrade every resolution to the
 * event-id tiebreak while still appearing to work.
 */
/**
 * Which chain an event belongs to: `writer/point`, both hex.
 *
 * **One string, because a chain is one thing.** The version vector is keyed by
 * it, the store looks one up by it, and `WANT` names one — splitting the pair
 * at each of those and rejoining it at the next is how the two halves drift.
 */
export function chainOf(e: { writer: PublicKey; point: Uint8Array }): string {
  return `${hex(e.writer)}/${hex(e.point)}`;
}

/** The writer half of a chain id, for asking who wrote something. */
export function writerOfChain(chain: string): string {
  const at = chain.indexOf('/');
  return at === -1 ? chain : chain.slice(0, at);
}

export function checkLink(
  space: PublicKey,
  previous: Event | null,
  event: EventBody,
): ChainFault | null {
  if (previous === null) {
    if (event.seq !== 0) {
      return { kind: 'seq-not-contiguous', expected: 0, got: event.seq };
    }
    if (event.prev !== null) return { kind: 'seq-zero-has-prev' };
    return null;
  }

  if (event.seq !== previous.seq + 1) {
    return { kind: 'seq-not-contiguous', expected: previous.seq + 1, got: event.seq };
  }
  if (event.prev === null) return { kind: 'seq-nonzero-lacks-prev' };

  const expected = eventId(space, previous);
  if (compareBytes(event.prev, expected) !== 0) {
    return { kind: 'prev-mismatch', expected, got: event.prev };
  }

  if (event.lamport <= previous.lamport) {
    return { kind: 'lamport-not-increasing', previous: previous.lamport, got: event.lamport };
  }

  return null;
}

/**
 * Check a whole chain for one writer, in sequence order.
 *
 * Returns the first fault and the index it occurred at, or null if the chain is
 * sound. Does not verify signatures — that is `verifyEvent`, and keeping them
 * apart means a diagnostic can report *which* of the two failed.
 */
export function checkChain(
  space: PublicKey,
  events: readonly Event[],
): { readonly at: number; readonly fault: ChainFault } | null {
  let previous: Event | null = null;
  for (let i = 0; i < events.length; i++) {
    const fault = checkLink(space, previous, events[i]!);
    if (fault !== null) return { at: i, fault };
    previous = events[i]!;
  }
  return null;
}
