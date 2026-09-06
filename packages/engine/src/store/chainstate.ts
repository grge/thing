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
  chainOf,
  checkLink,
  type Event,
  eventId,
  type Hash,
  type PublicKey,
  verifyEvent,
} from '../core/index.js';
import type { AppendRejection, ChainId, VersionVector, WriterFrontier } from './types.js';

/**
 * One chain, as the store tracks it.
 *
 * A chain is `(writer, point)`: one process's run of writes under one identity.
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
  private readonly chains = new Map<ChainId, ChainState>();

  constructor(private readonly space: PublicKey) {}

  /** Rebuild from a log, in any order. Used when opening an existing space. */
  async load(events: AsyncIterable<Event> | Iterable<Event>): Promise<void> {
    // Group by chain, then walk each in seq order, because a stored log has no
    // guaranteed order and a chain must be validated as a sequence.
    const byChain = new Map<ChainId, Event[]>();
    for await (const e of events as AsyncIterable<Event>) {
      const w = chainOf(e);
      let list = byChain.get(w);
      if (list === undefined) {
        list = [];
        byChain.set(w, list);
      }
      list.push(e);
    }

    for (const [w, list] of byChain) {
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

  chain(id: ChainId): ChainState {
    let c = this.chains.get(id);
    if (c === undefined) {
      c = emptyChain();
      this.chains.set(id, c);
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
    const w = chainOf(e);
    const chain = this.chain(w);

    if (e.seq <= chain.frontier) return { kind: 'duplicate', chain: w, seq: e.seq };
    if (e.seq > chain.frontier + 1) {
      return { kind: 'gap', chain: w, expected: chain.frontier + 1, got: e.seq };
    }

    // A `prev` that does not match is either a fork or a graft. The store
    // refuses both, and that refusal is *not* the resolution: §7.3 decides
    // between branches in the fold, which is the only layer that can, because
    // the log is append-only (§2.1) and a store cannot un-store the loser.
    //
    // So a peer holds whichever branch reached it first, and `forkResolution`
    // decides what folds. Two peers holding different branches converge only
    // once they exchange them — which is what the `FORKED` report is for.
    if (checkLink(this.space, chain.last, e) !== null) {
      return { kind: 'fork', chain: w, seq: e.seq };
    }

    // Last, because it is the expensive one. Nothing enters a store unverified
    // (§2.3): a peer cannot be trusted to have checked.
    if (!(await verifyEvent(this.space, e))) {
      return { kind: 'unverified', chain: w, seq: e.seq };
    }

    return null;
  }

  /** Record that an event has been written. */
  advance(e: Event): void {
    const chain = this.chain(chainOf(e));
    chain.frontier = e.seq;
    chain.tip = eventId(this.space, e);
    chain.last = e;
  }

  /** The version vector (§2.3): frontier and tip per chain. */
  versionVector(): VersionVector {
    const vv = new Map<ChainId, WriterFrontier>();
    for (const [w, c] of this.chains) {
      if (c.frontier >= 0 && c.tip !== null) vv.set(w, { frontier: c.frontier, tip: c.tip });
    }
    return vv;
  }
}

/**
 * Sort events so each chain is in order.
 *
 * An append may arrive with a chain's events shuffled, and every one after the
 * first would then be refused as a gap. Sorting by `(chain, seq)` means a
 * caller can hand over a batch in any order and have it applied.
 */
export function inChainOrder(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => {
    const ac = chainOf(a);
    const bc = chainOf(b);
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.seq - b.seq;
  });
}
