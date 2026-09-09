/**
 * The reading key, and what it encrypts (ARCHITECTURE.md §6).
 *
 * A space may hold a symmetric **reading key**. Where it does, event values and
 * blob contents are encrypted under it, and a peer without it stores, verifies,
 * serves and relays without ever reading (§6.1). Everything here is pure: no
 * store, no space, no clock.
 *
 * **XChaCha20-Poly1305, not WebCrypto.** `platform.d.ts` declares only what
 * *both* runtimes genuinely provide, and warns that widening it to fix one
 * import silently loses that property everywhere. `sign.ts` set the precedent
 * for the same reason. XChaCha's 24-byte nonce also removes any question of
 * nonce-size pressure, which a 12-byte AEAD would have made a real constraint
 * below.
 *
 * **Two subkeys, never the raw key** (§6). Values and blobs are separate
 * domains and are kept apart by HKDF rather than by convention, so a construction
 * error in one cannot reach the other.
 *
 * **Values use a derived nonce; blobs use a random one.** The two differ because
 * what makes a nonce safe differs:
 *
 * - A value's nonce is `(writer, point, seq)` — the triple that already keys a
 *   chain (`chainOf`). §6 originally said `(writer, seq)` and flagged that the
 *   pair was unique *only because one identity had one chain*; append points
 *   broke that, and `docs/design/CAPABILITIES.md` records the correction. The
 *   triple is unique by construction rather than by assumption: a chain is what
 *   it names, and a chain has one event per `seq`.
 * - A blob has no envelope, so it has no such triple. Its nonce is random and
 *   travels with the ciphertext.
 *
 * **Blobs are randomised deliberately, not by default.** §6 offers deriving a
 * blob's key and nonce from its plaintext hash, which would restore §2.4's
 * deduplication. `docs/working/ENCRYPTION-PLAN.md` takes the trade the other
 * way: determinism hands a hub operator a confirm-a-known-file attack — guess a
 * candidate, encrypt it, compare — against a party a public server exposes you
 * to by definition. Randomising costs duplicate storage, and only when one space
 * stores the same bytes twice. Disk on a machine you own against a standing
 * disclosure to whoever hosts you.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat } from './bytes.js';
import type { Event, Point } from './event.js';
import type { PublicKey } from './sign.js';

/**
 * A space's reading key: 32 bytes, symmetric, shared out of band (§6).
 *
 * Distinct from every other key here — it is not a keypair, it names nothing,
 * and it grants exactly one thing. The type is an alias rather than a wrapper
 * so it stays bytes, which is how it travels in a link fragment.
 */
export type ReadingKey = Uint8Array;

export const READING_KEY_LEN = 32;

/** XChaCha20's nonce: 24 bytes. */
export const NONCE_LEN = 24;

/** Poly1305's tag, appended to every ciphertext by the AEAD. */
export const TAG_LEN = 16;

/**
 * HKDF `info` strings, which is what actually separates the two subkeys.
 *
 * **Never change one.** A changed string derives a different subkey, and every
 * value ever written under the old one becomes undecryptable — with no error
 * that says so, because authentication failure is indistinguishable from
 * corruption.
 */
const VALUE_INFO = new TextEncoder().encode('thing/v1/value');
const BLOB_INFO = new TextEncoder().encode('thing/v1/blob');

/**
 * A fresh reading key.
 *
 * Refuses rather than falling back where there is no platform RNG, for the same
 * reason `newPoint` does: a predictable key is worse than no key, because it
 * looks like it works.
 */
export function newReadingKey(): ReadingKey {
  const out = new Uint8Array(READING_KEY_LEN);
  if (typeof crypto === 'undefined' || crypto.getRandomValues === undefined) {
    throw new Error('no secure random source for a reading key');
  }
  crypto.getRandomValues(out);
  return out;
}

/**
 * The two subkeys a reading key expands to.
 *
 * Derived once and held, because HKDF on every event would be a hash per value
 * on the fold's hot path for an answer that never changes.
 */
export interface Subkeys {
  readonly value: Uint8Array;
  readonly blob: Uint8Array;
}

export function subkeys(reading: ReadingKey): Subkeys {
  if (reading.length !== READING_KEY_LEN) {
    throw new Error(`a reading key is ${READING_KEY_LEN} bytes, got ${reading.length}`);
  }
  // No salt: the input is already a uniformly random key rather than a
  // password, so extract has nothing to spread out. The domain separation is
  // entirely in `info`, which is what it is for.
  return {
    value: hkdf(sha256, reading, undefined, VALUE_INFO, 32),
    blob: hkdf(sha256, reading, undefined, BLOB_INFO, 32),
  };
}

/* ── values ─────────────────────────────────────────────────────────────── */

/**
 * Where a value sits: the triple that already keys a chain plus a position on
 * it, which is exactly what makes it a nonce.
 */
export interface Position {
  readonly writer: PublicKey;
  readonly point: Point;
  readonly seq: number;
}

/**
 * The nonce for one value: 24 bytes over `(writer, point, seq)`.
 *
 * Hashed rather than concatenated, because the triple is 68 bytes and a nonce is
 * 24 — so some compression is required either way, and truncating a hash of the
 * whole triple keeps every component contributing. Collision would need a
 * SHA-256 collision truncated to 192 bits, against inputs that are already
 * distinct by construction.
 */
export function valueNonce(at: Position): Uint8Array {
  const w = new Uint8Array(4);
  new DataView(w.buffer).setUint32(0, at.seq, false);
  return sha256(concat([at.writer, at.point, w])).subarray(0, NONCE_LEN);
}

/**
 * Encrypt one event value.
 *
 * The ciphertext is what the envelope carries and what the signature covers, so
 * nothing about the event shape changes — `value` was always opaque bytes
 * (§2.1) and a signature over ciphertext verifies exactly as one over plaintext.
 */
export function encryptValue(keys: Subkeys, at: Position, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(keys.value, valueNonce(at)).encrypt(plaintext);
}

/**
 * Decrypt one event value, or null if it does not authenticate.
 *
 * **Null rather than throwing**, because the fold is total (§3.4): a value that
 * will not decrypt is one slice this peer cannot read, exactly like a value its
 * codec rejects, and it must not take down the fold around it. The cases it
 * covers are ordinary — a wrong key, a space that gained a key partway, an
 * event written before one — and none of them is corruption to report.
 */
export function decryptValue(
  keys: Subkeys,
  at: Position,
  ciphertext: Uint8Array,
): Uint8Array | null {
  try {
    return xchacha20poly1305(keys.value, valueNonce(at)).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/* ── blobs ──────────────────────────────────────────────────────────────── */

/**
 * Encrypt blob content: a random nonce, then the ciphertext.
 *
 * The nonce is prepended rather than kept beside, because a blob is stored and
 * fetched as one opaque run of bytes addressed by its hash (§2.4) and there is
 * nowhere else to put it. It is not secret; it only has to be unique.
 *
 * **Two calls on identical bytes must produce different ciphertexts.** That is
 * the point of randomising, and `cipher.test.ts` asserts it rather than trusting
 * that nobody later "optimises" the nonce into something derived.
 */
export function encryptBlob(keys: Subkeys, plaintext: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(NONCE_LEN);
  if (typeof crypto === 'undefined' || crypto.getRandomValues === undefined) {
    throw new Error('no secure random source for a blob nonce');
  }
  crypto.getRandomValues(nonce);
  return concat([nonce, xchacha20poly1305(keys.blob, nonce).encrypt(plaintext)]);
}

/** Decrypt blob content written by `encryptBlob`, or null if it does not authenticate. */
export function decryptBlob(keys: Subkeys, stored: Uint8Array): Uint8Array | null {
  if (stored.length < NONCE_LEN + TAG_LEN) return null;
  const nonce = stored.subarray(0, NONCE_LEN);
  const body = stored.subarray(NONCE_LEN);
  try {
    return xchacha20poly1305(keys.blob, nonce).decrypt(body);
  } catch {
    return null;
  }
}

/* ── the fold's boundary ────────────────────────────────────────────────── */

/**
 * One event with its value decrypted, for a fold that holds the reading key.
 *
 * **Decryption happens here, at the entry to the fold, and nowhere below it.**
 * The three decode sites §6 pointed at are not all reachable with a nonce in
 * hand: `applyRule` and `refoldBody` see an `Entry`, whose `key` is a `Key`
 * (`lamport, writer, id`) and carries neither `point` nor `seq`. Threading the
 * triple down to them would mean widening `Entry` — a change to the rule
 * contract, for a concern rules must not have — so the value is made plaintext
 * once while the whole envelope is still in hand, and everything downstream is
 * untouched.
 *
 * **Root-targeted events pass through unchanged** (`docs/design/ROOT-IN-CLEAR.md`).
 * They were never encrypted, so there is nothing to undo, and this is where that
 * exemption is applied on the reading side.
 *
 * **A value that will not decrypt keeps its ciphertext** rather than being
 * dropped. The event is still admitted, still folds, and its slice resolves to
 * whatever its codec makes of bytes that are not what it expected — which is
 * `null`, skipped, exactly as §3.4 requires of any unreadable value. Dropping
 * the event instead would make the fold disagree with a keyless peer's about
 * *which events exist*, and §6.1 is clear that only reading differs.
 */
export function decrypted(keys: Subkeys | null, e: Event, isRootTarget: boolean): Event {
  if (keys === null || isRootTarget) return e;
  const plain = decryptValue(keys, e, e.value);
  return plain === null ? e : { ...e, value: plain };
}

/**
 * Encrypt a value about to be written, unless it targets the root.
 *
 * The counterpart of `decrypted`, and deliberately the same shape: the
 * exemption is stated once on each side rather than tested at every call.
 */
export function encrypted(
  keys: Subkeys | null,
  at: Position,
  value: Uint8Array,
  isRootTarget: boolean,
): Uint8Array {
  if (keys === null || isRootTarget) return value;
  return encryptValue(keys, at, value);
}
