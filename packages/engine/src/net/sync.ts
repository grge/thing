/**
 * Reconciliation: deciding what to send and what has diverged.
 *
 * Pure — takes version vectors, returns what to do about them. No I/O and no
 * transport, so every case here is testable without a network, which is where
 * the interesting ones live.
 */
import type { WireFrontier, WireVersionVector } from './protocol.js';

/** One chain needs events sent, from `from` inclusive. */
export interface SendRange {
  /** `writer/point` — see `chainOf`. */
  readonly chain: string;
  readonly from: number;
}

/**
 * One chain has diverged (§2.3).
 *
 * With per-process append points this is no longer what two of your own
 * processes do — they write separate chains. A divergence now means one chain
 * has two histories, which honest software does not produce: either a key is
 * being used to equivocate deliberately, or a store has been corrupted or
 * rolled back. §7.3 still resolves it deterministically.
 */
export interface Divergence {
  /** `writer/point` — see `chainOf`. */
  readonly chain: string;
  readonly frontier: number;
  readonly mine: string;
  readonly theirs: string;
}

export interface Reconciliation {
  /** Ranges of my chains the other peer lacks. */
  readonly send: readonly SendRange[];
  /** Ranges I lack and should ask for. */
  readonly want: readonly SendRange[];
  /**
   * Chains that have forked.
   *
   * Detected, not repaired: fetching the competing branch needs a request this
   * protocol does not have (§2.3). What matters is that it is reported rather
   * than silently failing, and that it does not stop the writers that are fine.
   */
  readonly forked: readonly Divergence[];
}

/**
 * Compare what I hold against what a peer reported.
 *
 * The three outcomes per chain:
 *
 * - **They are behind me.** Send them what follows their frontier.
 * - **I am behind them.** Ask for what follows mine.
 * - **We disagree about history.** Their tip at a frontier we both reached is
 *   not mine, so one of us is on a branch the other has never seen. That is a
 *   fork, and it is reported.
 *
 * The fork check is what the tip is for. Frontiers alone would show these peers
 * agreeing at the lower number and quietly exchanging events that can never
 * apply.
 */
export function reconcile(mine: WireVersionVector, theirs: WireVersionVector): Reconciliation {
  const send: SendRange[] = [];
  const want: SendRange[] = [];
  const forked: Divergence[] = [];

  const chains = new Set([...Object.keys(mine), ...Object.keys(theirs)]);

  for (const chain of chains) {
    const a = mine[chain];
    const b = theirs[chain];

    if (a === undefined) {
      // They have a chain I have never seen. Ask from the beginning.
      if (b !== undefined) want.push({ chain, from: 0 });
      continue;
    }
    if (b === undefined) {
      send.push({ chain, from: 0 });
      continue;
    }

    if (a.frontier === b.frontier) {
      // Same distance along. Same history, or a fork.
      if (a.tip !== b.tip) {
        forked.push({ chain, frontier: a.frontier, mine: a.tip, theirs: b.tip });
      }
      continue;
    }

    // Different distances. Whether this is a fork cannot be told from the
    // vectors alone — the shorter peer's tip is at a position the longer one
    // does not report — so the events themselves settle it: the store rejects
    // a mismatched `prev`, and that surfaces as a rejection rather than here.
    if (a.frontier > b.frontier) send.push({ chain, from: b.frontier + 1 });
    else want.push({ chain, from: a.frontier + 1 });
  }

  return { send: sorted(send), want: sorted(want), forked: [...forked].sort(byChain) };
}

function sorted(ranges: SendRange[]): SendRange[] {
  return [...ranges].sort(byChain);
}

function byChain<T extends { chain: string }>(a: T, b: T): number {
  return a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0;
}

/** True if the two peers hold the same thing and nothing needs to move. */
export function inSync(r: Reconciliation): boolean {
  return r.send.length === 0 && r.want.length === 0;
}

/**
 * Holds events whose predecessor has not arrived.
 *
 * §2.5: events after a gap are held aside, never applied, so the fold never
 * sees a chain's history with a hole in it. This is where that buffering
 * lives — storage refuses a gap outright, because deciding *what to do* about
 * one is a network concern.
 */
export class PendingEvents<T> {
  private readonly held = new Map<string, Map<number, T>>();

  /**
   * Hold an event that cannot yet be applied.
   *
   * `chain` is passed separately rather than derived from the event, because
   * it is bytes on the event and a string here — keeping the conversion at the
   * caller means it happens once rather than per lookup.
   */
  hold(chain: string, seq: number, event: T): void {
    let byseq = this.held.get(chain);
    if (byseq === undefined) {
      byseq = new Map();
      this.held.set(chain, byseq);
    }
    byseq.set(seq, event);
  }

  /**
   * Take everything now applicable for a chain, given its frontier.
   *
   * Returns a contiguous run starting at `frontier + 1`, so the caller can
   * append it in one go, and removes what it returns.
   */
  drain(chain: string, frontier: number): T[] {
    const byseq = this.held.get(chain);
    if (byseq === undefined) return [];

    const out: T[] = [];
    let next = frontier + 1;
    for (;;) {
      const e = byseq.get(next);
      if (e === undefined) break;
      out.push(e);
      byseq.delete(next);
      next += 1;
    }
    if (byseq.size === 0) this.held.delete(chain);
    return out;
  }

  /**
   * What to ask for: the span between a chain's frontier and its lowest held
   * event. Exactly the gap, so a request names no more than it needs.
   */
  gaps(frontiers: ReadonlyMap<string, number>): SendRange[] {
    const out: SendRange[] = [];
    for (const [chain, byseq] of this.held) {
      const have = frontiers.get(chain) ?? -1;
      let lowest = Number.MAX_SAFE_INTEGER;
      for (const seq of byseq.keys()) if (seq < lowest) lowest = seq;
      if (lowest > have + 1) out.push({ chain, from: have + 1 });
    }
    return sorted(out);
  }

  get size(): number {
    let n = 0;
    for (const byseq of this.held.values()) n += byseq.size;
    return n;
  }
}

/** Frontiers as a plain map, for `gaps`. */
export function frontiersOf(vv: WireVersionVector): Map<string, number> {
  const out = new Map<string, number>();
  for (const [chain, f] of Object.entries(vv)) out.set(chain, f.frontier);
  return out;
}

export type { WireFrontier };
