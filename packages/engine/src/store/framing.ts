/**
 * Storing an event as bytes.
 *
 * **Not the canonical encoding.** `core`'s `encodeEventBody` produces what gets
 * *signed*, and it deliberately omits the signature and the space key — the
 * first because an event's identity must not depend on it, the second because
 * the receiver already knows which space it holds. A store needs neither
 * property: it needs to write an event down and read the same event back,
 * signature included.
 *
 * Keeping the two apart matters. If a store reused the signed encoding it would
 * have to append the signature separately, and any drift between the two
 * encodings would be a bug that only appeared on reload. This format is free to
 * change; the signed one is not.
 *
 * ```
 * [u32 length]
 * [writer 32][point 16][sig 64][u32 seq][u8 hasPrev][prev 32?]
 * [u32 depCount][dep 32]*[u64 lamport]
 * [target 16][u32 attrLen][attr][u32 valueLen][value][u64 wall]
 * ```
 *
 * A length prefix comes first so a reader can skip a frame it cannot parse, and
 * so a truncated tail — a write interrupted by a crash — is detectable rather
 * than being read as garbage.
 */
import {
  ByteWriter,
  type Event,
  HASH_LEN,
  POINT_LEN,
  PUBLIC_KEY_LEN,
  SIGNATURE_LEN,
  UUID_LEN,
} from '../core/index.js';

/** The leading `u32` length. */
export const FRAME_HEADER = 4;

const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();

export function encodeEvent(e: Event): Uint8Array {
  const attr = UTF8.encode(e.attr);
  const body = new ByteWriter();

  body.fixed(e.writer, PUBLIC_KEY_LEN, 'writer');
  body.fixed(e.point, POINT_LEN, 'point');
  body.fixed(e.sig, SIGNATURE_LEN, 'signature');
  body.u32(e.seq);
  if (e.prev === null) {
    body.u8(0);
  } else {
    body.u8(1);
    body.fixed(e.prev, HASH_LEN, 'prev');
  }
  body.u32(e.deps.length);
  for (const d of e.deps) body.fixed(d, HASH_LEN, 'dep');
  body.u64(e.lamport);
  body.fixed(e.target, UUID_LEN, 'target');
  body.lenPrefixed(attr);
  body.lenPrefixed(e.value);
  body.u64(e.wall);

  const bytes = body.finish();
  const frame = new ByteWriter();
  frame.u32(bytes.length);
  frame.bytes(bytes);
  return frame.finish();
}

/**
 * Decode one frame at `at`.
 *
 * Returns the event and where the next frame begins, or null if the buffer does
 * not hold a complete frame here — which is how a truncated tail is recognised.
 */
export function decodeEvent(buf: Uint8Array, at: number): { event: Event; next: number } | null {
  if (at + FRAME_HEADER > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const length = view.getUint32(at, false);
  const start = at + FRAME_HEADER;
  const end = start + length;
  if (end > buf.length) return null;

  let p = start;
  const take = (n: number): Uint8Array => {
    const out = buf.subarray(p, p + n);
    p += n;
    return out;
  };

  try {
    const writer = take(PUBLIC_KEY_LEN);
    const point = take(POINT_LEN);
    const sig = take(SIGNATURE_LEN);
    const seq = view.getUint32(p, false);
    p += 4;
    const hasPrev = buf[p] === 1;
    p += 1;
    const prev = hasPrev ? take(HASH_LEN) : null;
    const depCount = view.getUint32(p, false);
    p += 4;
    const deps: Uint8Array[] = [];
    for (let i = 0; i < depCount; i++) deps.push(new Uint8Array(take(HASH_LEN)));
    const lamport = Number(view.getBigUint64(p, false));
    p += 8;
    const target = take(UUID_LEN);
    const attrLen = view.getUint32(p, false);
    p += 4;
    const attr = FROM_UTF8.decode(take(attrLen));
    const valueLen = view.getUint32(p, false);
    p += 4;
    const value = take(valueLen);
    const wall = Number(view.getBigUint64(p, false));
    p += 8;

    if (p !== end) return null; // a frame that does not account for its length

    return {
      event: {
        writer: new Uint8Array(writer),
        point: new Uint8Array(point),
        seq,
        prev: prev === null ? null : new Uint8Array(prev),
        deps,
        lamport,
        target: new Uint8Array(target),
        attr,
        value: new Uint8Array(value),
        wall,
        sig: new Uint8Array(sig),
      },
      next: end,
    };
  } catch {
    return null;
  }
}
