/**
 * The comparison key used throughout the spec: `(lamport, writer)` (§2.2).
 *
 * Ties on `lamport` are genuinely concurrent writes; they break on `writer`
 * bytes lexicographically. Arbitrary, but identical on every peer, which is the
 * only requirement.
 */
import { compareBytes } from './hash.js';
import type { Event, WriterId } from './types.js';

export interface Key {
  readonly lamport: number;
  readonly writer: WriterId;
}

export function keyOf(e: Event): Key {
  return { lamport: e.lamport, writer: e.writer };
}

export function compareKeys(a: Key, b: Key): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  return compareBytes(a.writer, b.writer);
}

/**
 * `⊥` from §4.5 — less than every key. Represented as null; these helpers keep
 * the null handling in one place rather than scattered through the fold.
 */
export type MaybeKey = Key | null;

export function greater(a: MaybeKey, b: MaybeKey): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return compareKeys(a, b) > 0;
}

/** Returns whichever key is greater, treating null as ⊥. */
export function maxKey(a: MaybeKey, b: MaybeKey): MaybeKey {
  return greater(b, a) ? b : a;
}
