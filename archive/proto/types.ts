/**
 * A prototype of the tiered slice model in ARCHITECTURE.md §3.
 *
 * The question this exists to answer: is the model coherent? Specifically, can a
 * filesystem, a chat and a co-edited document live in ONE space, folded by ONE
 * algorithm, with no type-specific code in the fold?
 *
 * Deliberately not production code. No signing, no networking, no storage — the
 * substrate is assumed (§2 is Proven) and only the fold is under test. Events are
 * plain objects rather than canonical bytes.
 */

/** A writer's identity. Real system: a 32-byte Ed25519 public key (§2.1). */
export type Writer = string;

/** An object's identity. Real system: a UUID (§2.1). */
export type Uuid = string;

export const ROOT: Uuid = 'ROOT';

/**
 * The slice an event belongs to (§3.1).
 *
 * `target` + `attr` together name the bag. The substrate never reads either —
 * chains and version vectors work on (writer, seq) alone — so this is purely a
 * fold concern.
 */
export interface SliceKey {
  readonly target: Uuid;
  readonly attr: string;
}

export const SLICE_SEP = '\u0000';

export function sliceKeyOf(e: Event): string {
  return e.target + SLICE_SEP + e.attr;
}

/** Split a slice key back into its parts. */
export function splitSliceKey(k: string): { target: Uuid; attr: string } {
  const i = k.indexOf(SLICE_SEP);
  return { target: k.slice(0, i), attr: k.slice(i + SLICE_SEP.length) };
}

/**
 * One event. Mirrors §2.1's envelope minus the parts the fold does not read:
 * no `prev`, no `sig`, no `wall`.
 *
 * `seq` is per-writer and strictly incrementing, which is what makes
 * `(writer, seq)` a stable unique identity for anything an event creates —
 * the property §3.8 relies on so that a sequence's element ids need no
 * separate minting.
 */
export interface Event {
  readonly writer: Writer;
  readonly seq: number;
  readonly lamport: number;
  readonly target: Uuid;
  readonly attr: string;
  readonly value: unknown;
}

/** The comparison key for register resolution: `(lamport, writer)` (§2.2). */
export interface Key {
  readonly lamport: number;
  readonly writer: Writer;
}

export function keyOf(e: Event): Key {
  return { lamport: e.lamport, writer: e.writer };
}

export function compareKeys(a: Key, b: Key): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.writer === b.writer) return 0;
  return a.writer < b.writer ? -1 : 1;
}

/** An element id, for rules that create addressable things (§3.8). */
export type ElementId = string;

export function elementIdOf(e: Event): ElementId {
  return `${e.writer}:${e.seq}`;
}
