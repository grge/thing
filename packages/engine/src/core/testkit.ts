/**
 * Shared test helpers. Not shipped — imported only by `*.test.ts`.
 *
 * The shuffle helpers are here rather than in one test file because
 * order-independence is asserted at three levels: the fold (§3), reconciliation
 * (§2.3), and any incremental fold. All three want the same generator, and all
 * three fail in the same way if it is subtly biased.
 */
import fc from 'fast-check';

/**
 * An arbitrary permutation of `[0, n)`.
 *
 * Used to shuffle an event set before folding. `shuffledSubarray` with min and
 * max both `n` yields a permutation rather than a sample, which is what
 * order-independence needs: every event present, order arbitrary.
 */
export function permutation(n: number): fc.Arbitrary<number[]> {
  return fc.shuffledSubarray([...Array(n).keys()], { minLength: n, maxLength: n });
}

/** Reorder `items` by a permutation of its indices. */
export function reorder<T>(items: readonly T[], order: readonly number[]): T[] {
  return order.map((i) => items[i]!);
}

/**
 * Deterministic bytes from a label, so tests read as intentions rather than as
 * hex. Never a real key: anything verifying signatures must generate properly.
 */
export function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

/** Hex, for legible assertion failures. */
export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
