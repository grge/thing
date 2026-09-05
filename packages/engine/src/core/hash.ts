/**
 * SHA-256, in two flavours, because two call sites want different things.
 *
 * **`hash` is synchronous** and used for event ids and chain links. It is on a
 * hot path inside the fold, which ARCHITECTURE.md §3.6 describes as a pure
 * function with no I/O — and an async hash would make the fold return promises,
 * taxing every call site above it for a computation that never waits on
 * anything. Inputs here are a few hundred bytes.
 *
 * **`hashLarge` is asynchronous** and used for blobs, where inputs are megabytes
 * and the call already sits at an I/O boundary. It uses the platform digest
 * where there is one, which is materially faster at that size.
 *
 * The two must agree, and `hash.test.ts` asserts it rather than assuming it.
 */
import { sha256 } from '@noble/hashes/sha2.js';

/** A SHA-256 digest: 32 bytes, never truncated (§2.1). */
export type Hash = Uint8Array;

export const HASH_LEN = 32;

/**
 * Synchronous SHA-256. For event ids, chain links, and anything the fold
 * touches.
 */
export function hash(bytes: Uint8Array): Hash {
  return sha256(bytes);
}

/**
 * Asynchronous SHA-256, preferring the platform implementation. For blob
 * content, where inputs are large.
 *
 * Falls back to the synchronous implementation where WebCrypto is absent or
 * lacks the algorithm, so this resolves everywhere `hash` works.
 */
export async function hashLarge(bytes: Uint8Array): Promise<Hash> {
  const subtle = crypto?.subtle;
  if (subtle !== undefined) {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      return new Uint8Array(digest);
    } catch {
      // Fall through: some runtimes expose subtle and reject the call.
    }
  }
  return hash(bytes);
}
