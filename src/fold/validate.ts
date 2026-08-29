/**
 * Structural checks on events (§2, §2.2).
 *
 * These are obligations on the event *creator* — nothing on the wire enforces
 * them. They are separated from `fold` deliberately: the fold must be total
 * (§3.5) and never reject an event set, so it cannot be the thing that raises.
 * A creator calls these; the fold does not.
 */
import { hex } from './hash.js';
import {
  CONTENT_HASH_LEN,
  type Event,
  SHORT_HASH_LEN,
  UUID_LEN,
  WRITER_LEN,
} from './types.js';

export class InvalidEvent extends Error {}

/** Field-shape checks: sizes, and the value variant matching the attr (§4). */
export function validateEvent(e: Event): void {
  if (e.writer.length !== WRITER_LEN) throw new InvalidEvent(`writer must be ${WRITER_LEN} bytes`);
  if (e.target.length !== UUID_LEN) throw new InvalidEvent(`target must be ${UUID_LEN} bytes`);
  if (!Number.isInteger(e.seq) || e.seq < 0) throw new InvalidEvent(`seq must be a u32`);
  if (!Number.isInteger(e.lamport) || e.lamport < 0) throw new InvalidEvent(`lamport must be a u64`);

  // `prev` is null iff seq === 0 (§2).
  if (e.seq === 0 && e.prev !== null) throw new InvalidEvent(`seq 0 must have prev = null`);
  if (e.seq > 0 && e.prev === null) throw new InvalidEvent(`seq > 0 must have a prev`);
  if (e.prev !== null && e.prev.length !== SHORT_HASH_LEN) {
    throw new InvalidEvent(`prev must be ${SHORT_HASH_LEN} bytes`);
  }

  const v = e.value;
  switch (e.attr) {
    case ':parent':
      if (v.t !== 'uuid') throw new InvalidEvent(`:parent takes a uuid`);
      if (v.v.length !== UUID_LEN) throw new InvalidEvent(`:parent uuid must be ${UUID_LEN} bytes`);
      break;
    case ':name':
      if (v.t !== 'string') throw new InvalidEvent(`:name takes a string`);
      break;
    case ':content':
      if (v.t !== 'hash' && v.t !== 'null') throw new InvalidEvent(`:content takes a hash or null`);
      if (v.t === 'hash' && v.v.length !== CONTENT_HASH_LEN) {
        throw new InvalidEvent(`:content hash must be ${CONTENT_HASH_LEN} bytes`);
      }
      break;
    case ':pos': {
      if (v.t !== 'pos') throw new InvalidEvent(`:pos takes a pos`);
      // Fixed point only. Floats are not permitted in hashed positions (§4.4).
      const { x, y } = v.v;
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        throw new InvalidEvent(`:pos must be integers (fixed point, 1/1000 unit)`);
      }
      const I32_MIN = -2147483648;
      const I32_MAX = 2147483647;
      if (x < I32_MIN || x > I32_MAX || y < I32_MIN || y > I32_MAX) {
        throw new InvalidEvent(`:pos out of i32 range`);
      }
      break;
    }
    case ':deleted':
      if (v.t !== 'bool') throw new InvalidEvent(`:deleted takes a bool`);
      break;
    case ':kind':
      if (v.t !== 'kind') throw new InvalidEvent(`:kind takes a kind`);
      break;
    case ':type':
      if (v.t !== 'string') throw new InvalidEvent(`:type takes a string`);
      // A MIME type, not a renderer name (§4.7). Length-capped because it is
      // hashed into every EventId and an unbounded string there is a footgun.
      if (v.v.length > 255) throw new InvalidEvent(`:type must be at most 255 chars`);
      break;
  }
}

/**
 * Check the invariant the comparison key depends on (§2.2): within a single
 * writer, lamports are strictly increasing, so no two of that writer's events
 * ever share a stamp.
 *
 * A violation means `(lamport, writer)` stops being a total order and LWW falls
 * back to arrival order — silently breaking §1.3. This is the cheapest place to
 * catch it, and it is worth running over any log loaded from storage or
 * received from a peer.
 */
export function checkWriterLamports(events: Iterable<Event>): void {
  const seen = new Map<string, Map<number, number>>(); // writer -> lamport -> seq
  for (const e of events) {
    const w = hex(e.writer);
    let byLamport = seen.get(w);
    if (byLamport === undefined) {
      byLamport = new Map();
      seen.set(w, byLamport);
    }
    const prevSeq = byLamport.get(e.lamport);
    if (prevSeq !== undefined && prevSeq !== e.seq) {
      throw new InvalidEvent(
        `writer ${w.slice(0, 8)} reused lamport ${e.lamport} at seq ${prevSeq} and ${e.seq}; ` +
          `(lamport, writer) is no longer a total order`,
      );
    }
    byLamport.set(e.lamport, e.seq);
  }
}
