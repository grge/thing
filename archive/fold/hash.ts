/**
 * Hashing (§2.1). SHA-256, truncated to 16 bytes for `prev` and EventId, full
 * 32 bytes for content hashes (§4.3).
 *
 * Truncation is safe here because dedup is by EventId and 16 bytes puts the
 * birthday bound at ~2^64 events, which a POC will not approach. It is not safe
 * against an adversary (§10.6).
 */
import { encodeEvent } from './encode.js';
import { type Event, type Hash, SHORT_HASH_LEN } from './types.js';

/** WebCrypto is available in browsers and in Node >= 20. */
const subtle: SubtleCrypto = globalThis.crypto.subtle;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return new Uint8Array(buf);
}

/** EventId = SHA-256 of the canonical encoding, truncated to 16 bytes (§2.1). */
export async function eventId(e: Event): Promise<Hash> {
  const full = await sha256(encodeEvent(e));
  return full.slice(0, SHORT_HASH_LEN);
}

/** Lowercase hex. Used as a Map key wherever a byte array must be compared. */
export function hex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`fromHex: odd-length string`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic byte comparison. Used to break Lamport ties (§2.2). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
