/**
 * Metadata sync (§3.1–§3.4).
 *
 * Pure: takes and returns data, performs no I/O and knows nothing about the
 * transport. The interesting parts — version vectors, gap detection, the
 * hold-aside buffer — are testable without a network, in the same spirit as
 * blobtransfer.ts.
 */
import { type Event, hex } from '../fold/index.js';
import type { VersionVector } from './protocol.js';

/**
 * A peer's knowledge: writer -> highest **contiguous** seq held (§3.1).
 *
 * "Contiguous" is load-bearing. A peer holding writer A's 0–47 and also 49
 * reports 47: event 49 is held but not applied (§3.3), and reporting 49 would
 * tell the other peer not to send 48 — precisely the event needed to unstall
 * the chain.
 */
export function versionVector(events: Iterable<Event>): VersionVector {
  const seqs = new Map<string, Set<number>>();
  for (const e of events) {
    const w = hex(e.writer);
    let held = seqs.get(w);
    if (held === undefined) {
      held = new Set();
      seqs.set(w, held);
    }
    held.add(e.seq);
  }

  const vv: VersionVector = {};
  for (const [writer, held] of seqs) {
    let contiguous = -1;
    while (held.has(contiguous + 1)) contiguous += 1;
    // A writer whose seq 0 is missing contributes nothing: we hold no prefix
    // of its chain at all.
    if (contiguous >= 0) vv[writer] = contiguous;
  }
  return vv;
}

/**
 * Events this peer holds that `theirs` lacks, ascending seq per writer (§3.4).
 *
 * Ascending order means `prev` chains resolve without buffering in the common
 * case — the receiver applies each event as it arrives.
 */
export function eventsSince(events: readonly Event[], theirs: VersionVector): Event[] {
  const out = events.filter((e) => {
    const known = theirs[hex(e.writer)];
    return known === undefined || e.seq > known;
  });

  out.sort((a, b) => {
    const aw = hex(a.writer);
    const bw = hex(b.writer);
    if (aw !== bw) return aw < bw ? -1 : 1;
    return a.seq - b.seq;
  });
  return out;
}

/** A missing range in one writer's chain, as a `GAP` request names it (§3.4). */
export interface GapRange {
  readonly writer: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Holds events whose predecessors are missing (§3.3).
 *
 * An event whose `prev` is not yet held is held aside, not applied, so the fold
 * never sees a writer's history with holes in it. This is the one place v0
 * buffers, and it is nearly free because the hash chain already says precisely
 * what is missing.
 */
export class PendingBuffer {
  /** writer -> seq -> event, for events held but not yet applicable. */
  private pending = new Map<string, Map<number, Event>>();
  /** writer -> highest contiguous seq applied. */
  private applied = new Map<string, number>();

  constructor(existing: Iterable<Event> = []) {
    for (const [writer, seq] of Object.entries(versionVector(existing))) {
      this.applied.set(writer, seq);
    }
  }

  get pendingCount(): number {
    let n = 0;
    for (const byseq of this.pending.values()) n += byseq.size;
    return n;
  }

  /**
   * Offer an event. Returns everything now applicable, in chain order — the
   * event itself plus any buffered successors it unblocks.
   *
   * An event already applied returns nothing: applying the same event twice is
   * a no-op for the fold (§1.3), but re-emitting it would churn storage.
   */
  offer(event: Event): Event[] {
    const writer = hex(event.writer);
    const have = this.applied.get(writer) ?? -1;

    if (event.seq <= have) return [];

    if (event.seq > have + 1) {
      // Its predecessor is missing: hold it aside (§3.3).
      let byseq = this.pending.get(writer);
      if (byseq === undefined) {
        byseq = new Map();
        this.pending.set(writer, byseq);
      }
      byseq.set(event.seq, event);
      return [];
    }

    // Applicable. Drain any buffered successors it unblocks.
    const out: Event[] = [event];
    let next = event.seq + 1;
    const byseq = this.pending.get(writer);
    if (byseq !== undefined) {
      for (;;) {
        const buffered = byseq.get(next);
        if (buffered === undefined) break;
        out.push(buffered);
        byseq.delete(next);
        next += 1;
      }
      if (byseq.size === 0) this.pending.delete(writer);
    }

    this.applied.set(writer, next - 1);
    return out;
  }

  /**
   * Ranges to request via `GAP` (§3.4).
   *
   * For each writer with buffered events, the span between what has been
   * applied and the lowest buffered seq is exactly what is missing.
   */
  gaps(): GapRange[] {
    const out: GapRange[] = [];
    for (const [writer, byseq] of this.pending) {
      const have = this.applied.get(writer) ?? -1;
      const lowest = Math.min(...byseq.keys());
      if (lowest > have + 1) out.push({ writer, from: have + 1, to: lowest - 1 });
    }
    return out;
  }
}
