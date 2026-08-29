/**
 * Core types for the event log. See docs/SPEC.md §2 (envelope) and §4 (attributes).
 */

/** 16 random bytes, one per browser profile per space (§2). */
export type WriterId = Uint8Array;

/** 16 bytes. The only identity an object has; paths are derived (§1.1, §4.1). */
export type Uuid = Uint8Array;

/** Truncated to 16 bytes for `prev`/EventId, full 32 for content hashes (§2.1). */
export type Hash = Uint8Array;

/** Reserved all-zero UUID naming the root directory (§4.1). */
export const ROOT: Uuid = new Uint8Array(16);

export const UUID_LEN = 16;
export const WRITER_LEN = 16;
/** `prev` and EventId are SHA-256 truncated to 16 bytes (§2.1). */
export const SHORT_HASH_LEN = 16;
/** `:content` holds a full SHA-256 of the plaintext blob (§4.3, §6). */
export const CONTENT_HASH_LEN = 32;

export type AttrName = ':parent' | ':name' | ':content' | ':pos' | ':deleted' | ':kind';

export type Kind = 'file' | 'dir';

/**
 * Canvas coordinates in fixed point, 1 unit = 1/1000 canvas unit (§4.4).
 * Integers only — floats are not permitted in hashed positions.
 */
export interface Pos {
  readonly x: number;
  readonly y: number;
}

/**
 * An attribute value. Which variant is legal depends on `attr`; see §4 and
 * `validateEvent` in ./validate.ts.
 */
export type Value =
  | { readonly t: 'uuid'; readonly v: Uuid }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'hash'; readonly v: Hash }
  | { readonly t: 'null' }
  | { readonly t: 'pos'; readonly v: Pos }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'kind'; readonly v: Kind };

/**
 * A single assertion: this attribute of this object now has this value (§1.2).
 * Events are never mutated or deleted.
 */
export interface Event {
  readonly writer: WriterId;
  /** Per-writer, starts at 0, strictly +1 (§2). */
  readonly seq: number;
  /** Hash of this writer's event seq-1; null iff seq === 0 (§3.2). */
  readonly prev: Hash | null;
  /** Lamport clock; see §2.2. Compared as `(lamport, writer)` throughout. */
  readonly lamport: number;
  readonly target: Uuid;
  readonly attr: AttrName;
  readonly value: Value;
  /** ms since epoch. DISPLAY ONLY — never used to resolve (§2). */
  readonly wall: number;
}
