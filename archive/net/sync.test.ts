/**
 * Stage 5: version vectors, diffing, and the hold-aside buffer (§3.1–§3.4).
 */
import { describe, expect, it } from 'vitest';
import { eventsSince, PendingBuffer, versionVector } from './sync.js';
import { hex } from '../fold/index.js';
import { TestWriter, uuid, writer } from '../fold/testkit.js';
import type { Event } from '../fold/index.js';

const alice = writer('alice');
const bob = writer('bob');
const A = hex(alice);
const B = hex(bob);

/** n events from one writer, seq 0..n-1. */
function chain(w: Uint8Array, n: number): Event[] {
  const tw = new TestWriter(w);
  const t = uuid('f');
  return Array.from({ length: n }, (_, i) => tw.name(t, `v${i}`));
}

describe('versionVector (§3.1)', () => {
  it('reports the highest contiguous seq', () => {
    expect(versionVector(chain(alice, 5))).toEqual({ [A]: 4 });
  });

  it('reports the contiguous prefix, not the highest held', () => {
    // Holding 0,1,2 and 4 reports 2 — reporting 4 would tell the peer not to
    // send 3, the one event needed to unstall the chain (§3.3).
    const all = chain(alice, 5);
    const gapped = [all[0]!, all[1]!, all[2]!, all[4]!];
    expect(versionVector(gapped)).toEqual({ [A]: 2 });
  });

  it('omits a writer whose seq 0 is missing', () => {
    const all = chain(alice, 5);
    expect(versionVector([all[1]!, all[2]!])).toEqual({});
  });

  it('tracks writers independently', () => {
    expect(versionVector([...chain(alice, 3), ...chain(bob, 7)])).toEqual({ [A]: 2, [B]: 6 });
  });

  it('is order-independent', () => {
    const events = [...chain(alice, 4), ...chain(bob, 2)];
    const shuffled = [...events].reverse();
    expect(versionVector(shuffled)).toEqual(versionVector(events));
  });

  it('is empty for an empty log — a fresh join (§3.4)', () => {
    expect(versionVector([])).toEqual({});
  });
});

describe('eventsSince (§3.4)', () => {
  it('sends everything to a peer with an empty VV', () => {
    const events = chain(alice, 3);
    expect(eventsSince(events, {})).toHaveLength(3);
  });

  it('sends only what the peer lacks', () => {
    const events = chain(alice, 5);
    const diff = eventsSince(events, { [A]: 2 });
    expect(diff.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('sends nothing when the peer is current', () => {
    expect(eventsSince(chain(alice, 3), { [A]: 2 })).toEqual([]);
  });

  it('sends ascending per writer, so prev chains resolve without buffering', () => {
    const events = [...chain(alice, 3), ...chain(bob, 3)].reverse();
    const diff = eventsSince(events, {});
    const bySeq = new Map<string, number[]>();
    for (const e of diff) {
      const w = hex(e.writer);
      bySeq.set(w, [...(bySeq.get(w) ?? []), e.seq]);
    }
    for (const seqs of bySeq.values()) {
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it('handles a peer ahead on one writer and behind on another', () => {
    const events = [...chain(alice, 5), ...chain(bob, 2)];
    const diff = eventsSince(events, { [A]: 4 });
    expect(diff.every((e) => hex(e.writer) === B)).toBe(true);
    expect(diff).toHaveLength(2);
  });
});

describe('PendingBuffer (§3.3)', () => {
  it('applies an in-order chain immediately', () => {
    const buf = new PendingBuffer();
    const events = chain(alice, 3);
    expect(buf.offer(events[0]!).map((e) => e.seq)).toEqual([0]);
    expect(buf.offer(events[1]!).map((e) => e.seq)).toEqual([1]);
    expect(buf.pendingCount).toBe(0);
  });

  it('holds aside an event whose predecessor is missing', () => {
    const buf = new PendingBuffer();
    const events = chain(alice, 3);
    expect(buf.offer(events[2]!)).toEqual([]);
    expect(buf.pendingCount).toBe(1);
  });

  it('releases buffered successors when the gap is filled', () => {
    const buf = new PendingBuffer();
    const e = chain(alice, 4);
    buf.offer(e[3]!);
    buf.offer(e[1]!); // still blocked: 0 missing
    buf.offer(e[2]!);
    expect(buf.pendingCount).toBe(3);

    // 0 arrives and unblocks the whole chain, in order.
    expect(buf.offer(e[0]!).map((x) => x.seq)).toEqual([0, 1, 2, 3]);
    expect(buf.pendingCount).toBe(0);
  });

  it('never emits an event twice', () => {
    const buf = new PendingBuffer();
    const e = chain(alice, 2);
    expect(buf.offer(e[0]!)).toHaveLength(1);
    expect(buf.offer(e[0]!)).toEqual([]);
    expect(buf.offer(e[1]!)).toHaveLength(1);
    expect(buf.offer(e[1]!)).toEqual([]);
  });

  it('resumes from an existing log rather than re-applying it', () => {
    const e = chain(alice, 5);
    const buf = new PendingBuffer(e.slice(0, 3)); // already hold 0,1,2
    expect(buf.offer(e[1]!)).toEqual([]);
    expect(buf.offer(e[3]!).map((x) => x.seq)).toEqual([3]);
  });

  it('buffers writers independently — one stall does not block another', () => {
    const buf = new PendingBuffer();
    const a = chain(alice, 3);
    const b = chain(bob, 2);
    buf.offer(a[2]!); // alice stalled
    expect(buf.offer(b[0]!).map((e) => e.seq)).toEqual([0]);
    expect(buf.offer(b[1]!).map((e) => e.seq)).toEqual([1]);
  });

  it('names the missing range for a GAP request (§3.4)', () => {
    const buf = new PendingBuffer();
    const e = chain(alice, 6);
    buf.offer(e[0]!);
    buf.offer(e[4]!);
    expect(buf.gaps()).toEqual([{ writer: A, from: 1, to: 3 }]);
  });

  it('reports no gaps when nothing is buffered', () => {
    const buf = new PendingBuffer();
    buf.offer(chain(alice, 2)[0]!);
    expect(buf.gaps()).toEqual([]);
  });

  it('a permanently missing event stalls that writer, visibly (§3.3, §10.2)', () => {
    const buf = new PendingBuffer();
    const e = chain(alice, 5);
    buf.offer(e[0]!);
    for (const x of e.slice(2)) buf.offer(x);
    // Everything after the hole is held, applied nothing, and says why.
    expect(buf.pendingCount).toBe(3);
    expect(buf.gaps()).toEqual([{ writer: A, from: 1, to: 1 }]);
  });
});
