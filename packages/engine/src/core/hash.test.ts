/**
 * Hashing, and the one property the split relies on.
 *
 * Event ids hash synchronously and blobs hash asynchronously (see hash.ts). Two
 * implementations of SHA-256 therefore exist in the tree, and if they ever
 * disagreed a blob would verify under one path and fail under the other. That
 * is a test, not a hope.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hex } from './bytes.js';
import { hash, HASH_LEN, hashLarge } from './hash.js';

describe('sha-256', () => {
  it('matches the published digest for the empty input', () => {
    expect(hex(hash(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published digest for "abc"', () => {
    expect(hex(hash(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is 32 bytes, never truncated', () => {
    // §2.1: prev is a second-preimage target and event ids drive dedup, so a
    // shortened hash is a security parameter change, not a size saving.
    expect(hash(new Uint8Array(0))).toHaveLength(HASH_LEN);
  });

  it('the sync and async paths agree on every input', async () => {
    // The whole justification for having both.
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        expect(hex(await hashLarge(bytes))).toBe(hex(hash(bytes)));
      }),
      { numRuns: 200 },
    );
  });

  it('the async path agrees on a large input too', async () => {
    // Where the two implementations are most likely to diverge: multi-block
    // inputs, where padding and chaining actually run.
    const big = new Uint8Array(1 << 16);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    expect(hex(await hashLarge(big))).toBe(hex(hash(big)));
  });
});
