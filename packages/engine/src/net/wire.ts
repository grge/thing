/**
 * Events on the wire.
 *
 * A third encoding, alongside `core`'s signed preimage and the store's own
 * framing — and deliberately so. The signed encoding omits the signature and
 * the space key because an event's identity must not depend on them; a store
 * needs both but is free to change its layout; this one has to survive JSON.
 * Conflating any two of the three would mean a change to one silently breaking
 * another.
 */
import { fromHex, hex, type Event } from '../core/index.js';
import type { WireEvent, WireVersionVector } from './protocol.js';
import type { VersionVector } from '../store/index.js';

export function toWire(e: Event): WireEvent {
  return {
    w: hex(e.writer),
    s: e.seq,
    p: e.prev === null ? null : hex(e.prev),
    l: e.lamport,
    t: hex(e.target),
    a: e.attr,
    v: hex(e.value),
    wall: e.wall,
    sig: hex(e.sig),
  };
}

/**
 * Decode an event, or null if the shape is wrong.
 *
 * Returns null rather than throwing: this runs on a peer's data, and a
 * malformed event is a peer being broken or hostile. Nothing here checks the
 * *signature* — that is the store's job at the moment of append (§2.3), so
 * there is exactly one place where verification can be forgotten.
 */
export function fromWire(w: unknown): Event | null {
  if (typeof w !== 'object' || w === null) return null;
  const e = w as Partial<WireEvent>;

  if (
    typeof e.w !== 'string' ||
    typeof e.s !== 'number' ||
    typeof e.l !== 'number' ||
    typeof e.t !== 'string' ||
    typeof e.a !== 'string' ||
    typeof e.v !== 'string' ||
    typeof e.wall !== 'number' ||
    typeof e.sig !== 'string' ||
    (e.p !== null && typeof e.p !== 'string')
  ) {
    return null;
  }

  try {
    return {
      writer: fromHex(e.w),
      seq: e.s,
      prev: e.p === null ? null : fromHex(e.p),
      lamport: e.l,
      target: fromHex(e.t),
      attr: e.a,
      value: fromHex(e.v),
      wall: e.wall,
      sig: fromHex(e.sig),
    };
  } catch {
    return null;
  }
}

export function vvToWire(vv: VersionVector): WireVersionVector {
  const out: Record<string, { frontier: number; tip: string }> = {};
  for (const [writer, f] of vv) {
    out[writer] = { frontier: f.frontier, tip: hex(f.tip) };
  }
  return out;
}
