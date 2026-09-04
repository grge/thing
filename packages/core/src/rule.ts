/**
 * The rule contract (ARCHITECTURE.md §3.2).
 *
 * A rule is **two things, usable independently**:
 *
 * 1. A **codec** — how to read and write the values in its slice. A log
 *    inspector holding only this can decode every value in a slice without
 *    folding anything, which is what makes an unknown log legible rather than a
 *    column of opaque bytes.
 * 2. A **merge** — how to combine a bag of decoded values into one result.
 *
 * They are separate because their obligations are separate: the codec is what
 * §3.6 pins to a canonical form, the merge is what must be a join-semilattice.
 *
 * **The merge's contract is stronger than "pure function of a set".** That much
 * is free, since a merge takes a bag. What §9.1 and incremental folding need is
 * the homomorphism
 *
 *     merge(merge(S₁) ⊕ S₂) = merge(S₁ ∪ S₂)
 *
 * — folding part of a bag and then folding the rest onto that result gives the
 * same answer as folding everything at once. That is what lets a peer keep a
 * running accumulator instead of replaying from empty, and what makes a snapshot
 * a legitimate starting point rather than a lossy summary. A rule can fail it,
 * which is why it is stated here and checked by property test.
 */
import type { Key } from './chain.js';

/**
 * One event's contribution to a slice, as a rule sees it.
 *
 * The rule gets the decoded value and the comparison key, and nothing else — no
 * access to other slices, no access to the log, no clock. A rule needing more
 * than this is the failure §3.8 describes.
 */
export interface Entry<V> {
  readonly key: Key;
  readonly value: V;
}

/**
 * A rule's accumulated state.
 *
 * **Keeps the comparison keys** (§3.7). The rendered state a view sees drops
 * them, but anything persisted or transmitted must not: an event arriving later
 * with an earlier key cannot be resolved against a result that has forgotten
 * which key won.
 */
export interface Acc<A> {
  readonly acc: A;
  /** Entries the rule could not yet apply — a pending anchor (§3.4). */
  readonly pending?: readonly Entry<unknown>[];
}

/**
 * How a rule decodes and encodes its values (§3.2).
 *
 * `decode` must tolerate anything: a malformed value is a value the rule
 * ignores, never an exception that stops the fold. Totality (§3.4) is a property
 * of the whole fold and cannot be maintained if a codec can throw.
 */
export interface Codec<V> {
  /** Bytes to value, or null if this value is not one this rule understands. */
  decode(bytes: Uint8Array): V | null;
  /** Value to bytes. Canonical: the same value always yields the same bytes. */
  encode(value: V): Uint8Array;
}

/**
 * A merge rule (§3.2).
 *
 * `A` is the accumulator — what persists, keys included. `V` is the decoded
 * value. `R` is what a view sees, which may drop everything the accumulator
 * keeps for resolution.
 */
export interface Merge<V, A, R> {
  /** The identity of the accumulator: what an empty bag folds to. */
  empty(): A;
  /**
   * Fold entries onto an accumulator.
   *
   * Must satisfy the homomorphism above: order-independent, idempotent, and
   * indifferent to how the entries were batched.
   */
  step(acc: A, entries: readonly Entry<V>[]): Acc<A>;
  /** The view's projection. Drops resolution metadata (§3.7). */
  render(acc: A): R;
}

/**
 * A complete rule: an identifier, a codec, and a merge.
 *
 * The identifier is part of the contract — two clients disagreeing about what
 * `sequence` means is unrecoverable (§3.2) — so it is stable and never reused.
 */
export interface Rule<V = unknown, A = unknown, R = unknown> {
  readonly id: string;
  readonly codec: Codec<V>;
  readonly merge: Merge<V, A, R>;
}

/**
 * A rule whose value type has been erased.
 *
 * The fold dispatches rules by name, so it holds them without knowing their
 * value types. Erasing to `unknown` at the boundary is safe because a rule's
 * codec is the only thing that produces values for its own merge — nothing else
 * can put a wrongly-typed value into a bag.
 */
export type AnyRule = Rule<unknown, unknown, unknown>;

/** Erase a rule's value type for storage in a dispatch table. */
export function erase<V, A, R>(rule: Rule<V, A, R>): AnyRule {
  return rule as unknown as AnyRule;
}

/**
 * Apply a rule to a bag of raw events' values, from empty.
 *
 * The convenience path: decode, drop what the codec rejects, fold. Incremental
 * callers use `step` directly with an accumulator they already hold.
 */
export function foldSlice<V, A, R>(
  rule: Rule<V, A, R>,
  entries: readonly Entry<Uint8Array>[],
): Acc<A> {
  const decoded: Entry<V>[] = [];
  for (const e of entries) {
    const value = rule.codec.decode(e.value);
    // A value this rule cannot read is skipped, not fatal (§3.4).
    if (value !== null) decoded.push({ key: e.key, value });
  }
  return rule.merge.step(rule.merge.empty(), decoded);
}
