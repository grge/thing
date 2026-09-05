/**
 * The short code (§5.4).
 *
 * A rendezvous hint, never identity. What matters is that it is stable, that it
 * is derived rather than stored, and that its alphabet is one a person can
 * transcribe without mistakes.
 */
import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH, codeFor, isCode } from './code.js';
import { generateKeyPair, keyPairFromSeed, SEED_LEN } from './sign.js';
import { labelled } from './testkit.js';

describe('the short code', () => {
  it('is derived, so the same key always gives the same code', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    expect(codeFor(key.publicKey)).toBe(codeFor(key.publicKey));
  });

  it('is eight characters from an unambiguous alphabet', async () => {
    const key = await generateKeyPair();
    const code = codeFor(key.publicKey);
    expect(code).toHaveLength(CODE_LENGTH);
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
  });

  it('omits the characters people confuse', () => {
    // The whole reason for a custom alphabet: these get transcribed by hand.
    for (const c of ['0', 'O', '1', 'l', 'I']) {
      expect(CODE_ALPHABET.includes(c)).toBe(false);
    }
  });

  it('differs between keys', async () => {
    const a = await keyPairFromSeed(labelled('a', SEED_LEN));
    const b = await keyPairFromSeed(labelled('b', SEED_LEN));
    expect(codeFor(a.publicKey)).not.toBe(codeFor(b.publicKey));
  });

  it('recognises its own shape', async () => {
    const key = await generateKeyPair();
    expect(isCode(codeFor(key.publicKey))).toBe(true);
    expect(isCode('too-short')).toBe(false);
    expect(isCode('0OIl1234')).toBe(false); // right length, wrong alphabet
  });
});
