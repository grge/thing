/**
 * Formatting the raw log for inspection (debug view).
 *
 * Read-only. Nothing here feeds the fold; it exists so the event stream is
 * legible when something goes wrong, which from stage 4 onward it will.
 */
import { hex, ROOT, type Event, type State, type Value } from '../fold/index.js';

export interface LogRow {
  readonly index: number;
  readonly writer: string;
  readonly seq: number;
  readonly lamport: number;
  readonly prev: string | null;
  readonly target: string;
  readonly targetLabel: string;
  readonly attr: string;
  readonly value: string;
  readonly wall: string;
}

const short = (h: string): string => `${h.slice(0, 6)}…`;

/** Render a value for display. Hashes and uuids are truncated; text is quoted. */
function showValue(v: Value, state: State): string {
  switch (v.t) {
    case 'uuid': {
      const key = hex(v.v);
      if (key === hex(ROOT)) return 'ROOT';
      const obj = state.objects.get(key);
      const name = obj?.name;
      return name != null ? `${short(key)} (${name})` : short(key);
    }
    case 'hash':
      return short(hex(v.v));
    case 'null':
      return 'null';
    case 'pos':
      return `${v.v.x},${v.v.y}`;
    case 'bool':
      return String(v.v);
    case 'kind':
      return v.v;
    case 'string':
      return JSON.stringify(v.v);
    case 'link':
      // Space first, since that is the identity; the object, when present, is a
      // deep link within it.
      return v.v.object === undefined
        ? `→ ${short(hex(v.v.space))}`
        : `→ ${short(hex(v.v.space))}/${short(hex(v.v.object))}`;
  }
}

/**
 * Label an event's target by its *current* resolved name, which is what makes
 * the log readable — but note this is the folded present, not what the name was
 * when the event was written.
 */
function labelFor(target: Uint8Array, state: State): string {
  const key = hex(target);
  if (key === hex(ROOT)) return 'ROOT';
  return state.objects.get(key)?.name ?? '—';
}

export function toRows(log: readonly Event[], state: State): LogRow[] {
  return log.map((e, index) => ({
    index,
    writer: short(hex(e.writer)),
    seq: e.seq,
    lamport: e.lamport,
    prev: e.prev === null ? null : short(hex(e.prev)),
    target: hex(e.target),
    targetLabel: labelFor(e.target, state),
    attr: e.attr,
    value: showValue(e.value, state),
    wall: new Date(e.wall).toISOString().slice(11, 19),
  }));
}

export interface WriterSummary {
  readonly writer: string;
  readonly full: string;
  readonly count: number;
  /** Highest *contiguous* seq held — the version vector rule (§3.1). */
  readonly contiguous: number;
  readonly highest: number;
  /** Seq numbers held but not contiguous, i.e. sitting past a gap (§3.3). */
  readonly gaps: number[];
}

/**
 * Per-writer summary, shaped like the version vector a peer would send (§3.1).
 *
 * "Contiguous" is the load-bearing part: a peer holding 0–47 and 49 reports 47,
 * because 49 is held but unapplied until 48 arrives. Showing both numbers makes
 * a stall visible before there is any transport to blame.
 */
export function summarise(log: readonly Event[]): WriterSummary[] {
  const byWriter = new Map<string, Set<number>>();
  for (const e of log) {
    const w = hex(e.writer);
    let seqs = byWriter.get(w);
    if (seqs === undefined) {
      seqs = new Set();
      byWriter.set(w, seqs);
    }
    seqs.add(e.seq);
  }

  const out: WriterSummary[] = [];
  for (const [full, seqs] of byWriter) {
    const sorted = [...seqs].sort((a, b) => a - b);
    let contiguous = -1;
    for (const n of sorted) {
      if (n === contiguous + 1) contiguous = n;
      else break;
    }
    out.push({
      writer: short(full),
      full,
      count: sorted.length,
      contiguous,
      highest: sorted[sorted.length - 1] ?? -1,
      gaps: sorted.filter((n) => n > contiguous),
    });
  }
  return out.sort((a, b) => (a.full < b.full ? -1 : 1));
}
