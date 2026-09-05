/**
 * Reconciliation: deciding what to send and what has diverged.
 *
 * Pure — takes version vectors, returns what to do about them. No I/O and no
 * transport, so every case here is testable without a network, which is where
 * the interesting ones live.
 */
import type { WireFrontier, WireVersionVector } from './protocol.js';

/** One writer's chain needs events sent, from `from` inclusive. */
export interface SendRange {
  readonly writer: string;
  readonly from: number;
}

/** One writer's chain has diverged (§2.3). */
export interface Divergence {
  readonly writer: string;
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
 * The three outcomes per writer:
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

  const writers = new Set([...Object.keys(mine), ...Object.keys(theirs)]);

  for (const writer of writers) {
    const a = mine[writer];
    const b = theirs[writer];

    if (a === undefined) {
      // They have a writer I have never seen. Ask from the beginning.
      if (b !== undefined) want.push({ writer, from: 0 });
      continue;
    }
    if (b === undefined) {
      send.push({ writer, from: 0 });
      continue;
    }

    if (a.frontier === b.frontier) {
      // Same distance along. Same history, or a fork.
      if (a.tip !== b.tip) {
        forked.push({ writer, frontier: a.frontier, mine: a.tip, theirs: b.tip });
      }
      continue;
    }

    // Different distances. Whether this is a fork cannot be told from the
    // vectors alone — the shorter peer's tip is at a position the longer one
    // does not report — so the events themselves settle it: the store rejects
    // a mismatched `prev`, and that surfaces as a rejection rather than here.
    if (a.frontier > b.frontier) send.push({ writer, from: b.frontier + 1 });
    else want.push({ writer, from: a.frontier + 1 });
  }

  return { send: sorted(send), want: sorted(want), forked: [...forked].sort(byWriter) };
}

function sorted(ranges: SendRange[]): SendRange[] {
  return [...ranges].sort(byWriter);
}

function byWriter<T extends { writer: string }>(a: T, b: T): number {
  return a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0;
}

/** True if the two peers hold the same thing and nothing needs to move. */
export function inSync(r: Reconciliation): boolean {
  return r.send.length === 0 && r.want.length === 0;
}

/**
 * Holds events whose predecessor has not arrived.
 *
 * §2.5: events after a gap are held aside, never applied, so the fold never
 * sees a writer's history with a hole in it. This is where that buffering
 * lives — storage refuses a gap outright, because deciding *what to do* about
 * one is a network concern.
 */
export class PendingEvents<T> {
  private readonly held = new Map<string, Map<number, T>>();

  /**
   * Hold an event that cannot yet be applied.
   *
   * `writer` is passed separately rather than read off the event, because an
   * event's writer is bytes and this indexes by their hex form — keeping the
   * conversion at the caller means it happens once rather than per lookup.
   */
  hold(writer: string, seq: number, event: T): void {
    let byseq = this.held.get(writer);
    if (byseq === undefined) {
      byseq = new Map();
      this.held.set(writer, byseq);
    }
    byseq.set(seq, event);
  }

  /**
   * Take everything now applicable for a writer, given its frontier.
   *
   * Returns a contiguous run starting at `frontier + 1`, so the caller can
   * append it in one go, and removes what it returns.
   */
  drain(writer: string, frontier: number): T[] {
    const byseq = this.held.get(writer);
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
    if (byseq.size === 0) this.held.delete(writer);
    return out;
  }

  /**
   * What to ask for: the span between a writer's frontier and its lowest held
   * event. Exactly the gap, so a request names no more than it needs.
   */
  gaps(frontiers: ReadonlyMap<string, number>): SendRange[] {
    const out: SendRange[] = [];
    for (const [writer, byseq] of this.held) {
      const have = frontiers.get(writer) ?? -1;
      let lowest = Number.MAX_SAFE_INTEGER;
      for (const seq of byseq.keys()) if (seq < lowest) lowest = seq;
      if (lowest > have + 1) out.push({ writer, from: have + 1 });
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
  for (const [writer, f] of Object.entries(vv)) out.set(writer, f.frontier);
  return out;
}

export type { WireFrontier };
