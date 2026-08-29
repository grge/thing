/**
 * Canonical encoding (§2.1). Two peers must produce byte-identical encodings of
 * the same event or hashing and dedup break. Fixed field order, length-prefixed
 * values, no maps, no optional field reordering, no floats in hashed positions.
 */
import {
  type AttrName,
  type Event,
  type Value,
  CONTENT_HASH_LEN,
  SHORT_HASH_LEN,
  UUID_LEN,
  WRITER_LEN,
} from './types.js';

/** Fixed tags. Never renumber: these bytes are hashed. */
const ATTR_TAG: Record<AttrName, number> = {
  ':parent': 1,
  ':name': 2,
  ':content': 3,
  ':pos': 4,
  ':deleted': 5,
  ':kind': 6,
};

const VALUE_TAG = {
  uuid: 1,
  string: 2,
  hash: 3,
  null: 4,
  pos: 5,
  bool: 6,
  kind: 7,
} as const;

const KIND_TAG = { file: 1, dir: 2 } as const;

class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;

  bytes(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }

  u8(n: number): void {
    this.bytes(Uint8Array.of(n));
  }

  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false); // big-endian, fixed
    this.bytes(b);
  }

  /** Lamport is u64; JS numbers are exact to 2^53, far beyond POC reach. */
  u64(n: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
    this.bytes(b);
  }

  i32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, false);
    this.bytes(b);
  }

  /** Length-prefixed, so no value can be confused with its neighbours. */
  lenPrefixed(b: Uint8Array): void {
    this.u32(b.length);
    this.bytes(b);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

const utf8 = new TextEncoder();

function encodeValue(w: Writer, value: Value): void {
  w.u8(VALUE_TAG[value.t]);
  switch (value.t) {
    case 'uuid':
      expectLen(value.v, UUID_LEN, 'uuid value');
      w.bytes(value.v);
      return;
    case 'string':
      // Length-prefixed UTF-8. No normalisation: the bytes the writer chose are
      // the bytes that get hashed, everywhere.
      w.lenPrefixed(utf8.encode(value.v));
      return;
    case 'hash':
      // Content hashes are full SHA-256 (§2.1).
      expectLen(value.v, CONTENT_HASH_LEN, 'content hash');
      w.bytes(value.v);
      return;
    case 'null':
      return;
    case 'pos':
      // Fixed point i32 pair (§4.4). Floats never reach this encoder.
      w.i32(value.v.x);
      w.i32(value.v.y);
      return;
    case 'bool':
      w.u8(value.v ? 1 : 0);
      return;
    case 'kind':
      w.u8(KIND_TAG[value.v]);
      return;
  }
}

function expectLen(b: Uint8Array, n: number, what: string): void {
  if (b.length !== n) {
    throw new Error(`canonical encoding: ${what} must be ${n} bytes, got ${b.length}`);
  }
}

/**
 * Encode an event for hashing. Field order is exactly the envelope order in §2:
 * writer, seq, prev, lamport, target, attr, value, wall.
 *
 * `wall` is included: it is display-only for *resolution* (§2), but it is part
 * of the event's identity, so two events differing only in `wall` are different
 * events with different EventIds.
 */
export function encodeEvent(e: Event): Uint8Array {
  const w = new Writer();

  expectLen(e.writer, WRITER_LEN, 'writer');
  w.bytes(e.writer);

  w.u32(e.seq);

  if (e.prev === null) {
    w.u8(0);
  } else {
    expectLen(e.prev, SHORT_HASH_LEN, 'prev');
    w.u8(1);
    w.bytes(e.prev);
  }

  w.u64(e.lamport);

  expectLen(e.target, UUID_LEN, 'target');
  w.bytes(e.target);

  w.u8(ATTR_TAG[e.attr]);
  encodeValue(w, e.value);

  w.u64(e.wall);

  return w.finish();
}
