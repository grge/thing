/**
 * The short code (ARCHITECTURE.md §5.4).
 *
 * Eight characters derived from a space's key, for the cases where a person has
 * to read one off a screen and type it into another. It is **a rendezvous hint
 * only** — never identity, never authority.
 *
 * Being short means being guessable, and that is precisely why nothing depends
 * on it: an impostor who claims a code can answer your call, but what they serve
 * will not verify against the key you actually want (§5.1). The code narrows
 * *where to look*; the key decides *what is real*.
 *
 * Derived from the hash of the key rather than from the key's own bytes, so the
 * code leaks nothing usable about the key itself.
 */
import { hash } from './hash.js';
import type { PublicKey } from './sign.js';

/**
 * A deliberately unambiguous alphabet: no `0`/`O`, no `1`/`l`/`I`.
 *
 * These get transcribed by hand between devices, which is the whole point of
 * them being short — so the characters that get confused are simply absent.
 */
export const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export const CODE_LENGTH = 8;

/** The rendezvous code for a space. */
export function codeFor(key: PublicKey): string {
  const digest = hash(key);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[digest[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/** Whether a string looks like a code, so a caller can tell it from a key. */
export function isCode(s: string): boolean {
  return s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));
}
