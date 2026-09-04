/**
 * The part of a store that is not platform-specific.
 *
 * Deciding whether an event may be appended — is it a duplicate, does it follow
 * the chain, does it verify — is identical whether the bytes end up in IndexedDB
 * or in a file. Putting it here means both backends share one implementation of
 * the rules, so they cannot drift apart, and the conformance suite is checking
 * persistence rather than re-checking logic.
 */
import {
  checkLink,
  type Event,
  eventId,
  type Hash,
  hex,
  type PublicKey,
  verifyEvent,
} from '@thing/core';
import type { AppendRejection, VersionVector, WriterFrontier, WriterId } from './types.js';

/**
 * One writer's chain, as the store tracks it.
 *
 * Only the contiguous prefix is tracked. An event beyond a gap is not held here
 * at all — the store refuses it and the caller fills the gap (§2.5). Buffering
 * out-of-order arrivals is `net`'s job, not storage's.
 */
export interface ChainState {
  /** Highest contiguous seq held, or -1 for a writer with nothing. */
  frontier: number;
  /** Id of the event at the frontier. */
  tip: Hash | null;
  /** The event at the frontier, needed to check what follows it. */
  last: Event | null;
}

export function emptyChain(): ChainState {
  return { frontier: -1, tip: null, last: null };
}

/**
 * Tracks every writer's chain in a space, and decides what may be appended.
 *
 * Held in memory and rebuilt on open. That is affordable because it is one small
 * record per writer, not per event — a space with a million events from three
 * writers has three entries here.
 */
export class ChainSet {
  private readonly chains = new Map<WriterId, ChainState>();

  constructor(private readonly space: PublicKey) {}

  /** Rebuild from a log, in any order. Used when opening an existing space. */
  async load(events: AsyncIterable<Event> | Iterable<Event>): Promise<void> {
    // Group by writer, then walk each chain in seq order, because a stored log
    // has no guaranteed order and a chain must be validated as a sequence.
    const byWriter = new Map<WriterId, Event[]>();
    for await (const e of events as AsyncIterable<Event>) {
      const w = hex(e.writer);
      let list = byWriter.get(w);
      if (list === undefined) {
        list = [];
        byWriter.set(w, list);
      }
      list.push(e);
    }

    for (const [w, list] of byWriter) {
      list.sort((a, b) => a.seq - b.seq);
      const chain = emptyChain();
      for (const e of list) {
        if (e.seq !== chain.frontier + 1) break;
        chain.frontier = e.seq;
        chain.tip = eventId(this.space, e);
        chain.last = e;
      }
      this.chains.set(w, chain);
    }
  }

  chain(writer: WriterId): ChainState {
    let c = this.chains.get(writer);
    if (c === undefined) {
      c = emptyChain();
      this.chains.set(writer, c);
    }
    return c;
  }

  /**
   * May this event be appended?
   *
   * Returns null if it may, or why not. Checks in order of cost: cheap
   * structural checks before the signature, so a duplicate does not pay for
   * verification.
   */
  async admit(e: Event): Promise<AppendRejection | null> {
    const w = hex(e.writer);
    const chain = this.chain(w);

    if (e.seq <= chain.frontier) return { kind: 'duplicate', writer: w, seq: e.seq };
    if (e.seq > chain.frontier + 1) {
      return { kind: 'gap', writer: w, expected: chain.frontier + 1, got: e.seq };
    }

    // A `prev` that does not match is either a fork or a graft; both are the
    // same refusal here, and §7.3 decides between branches at a higher layer.
    if (checkLink(this.space, chain.last, e) !== null) {
      return { kind: 'fork', writer: w, seq: e.seq };
    }

    // Last, because it is the expensive one. Nothing enters a store unverified
    // (§2.3): a peer cannot be trusted to have checked.
    if (!(await verifyEvent(this.space, e))) {
      return { kind: 'unverified', writer: w, seq: e.seq };
    }

    return null;
  }

  /** Record that an event has been written. */
  advance(e: Event): void {
    const chain = this.chain(hex(e.writer));
    chain.frontier = e.seq;
    chain.tip = eventId(this.space, e);
    chain.last = e;
  }

  /** The version vector (§2.3): frontier and tip per writer. */
  versionVector(): VersionVector {
    const vv = new Map<WriterId, WriterFrontier>();
    for (const [w, c] of this.chains) {
      if (c.frontier >= 0 && c.tip !== null) vv.set(w, { frontier: c.frontier, tip: c.tip });
    }
    return vv;
  }
}

/**
 * Sort events so each writer's chain is in order.
 *
 * An append may arrive with a writer's events shuffled, and every one after the
 * first would then be refused as a gap. Sorting by `(writer, seq)` means a
 * caller can hand over a batch in any order and have it applied.
 */
export function inChainOrder(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => {
    const aw = hex(a.writer);
    const bw = hex(b.writer);
    if (aw !== bw) return aw < bw ? -1 : 1;
    return a.seq - b.seq;
  });
}
