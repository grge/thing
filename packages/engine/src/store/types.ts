/**
 * The storage interface (ARCHITECTURE.md §2).
 *
 * Storage is the only genuinely platform-bound layer: `core` and `net` compile
 * with no DOM and no Node types, so this is where a browser and a headless peer
 * actually diverge. One interface, two backends, one conformance suite.
 *
 * **Asynchronous throughout**, because IndexedDB is. That is the opposite call
 * from the fold, deliberately — a fold is a pure computation that never waits on
 * anything, while this is a real I/O boundary where a promise costs nothing.
 *
 * **Append-only.** Events are never mutated and never deleted (§2.1), so the
 * only write is an append. Nothing here rewrites a log; a backend that did would
 * make every write O(n) and would be lying about what a log is.
 */
import type { Event, Hash, PublicKey } from '../core/index.js';

/** A space's identity: its Ed25519 public key, as lowercase hex. */
export type SpaceId = string;

/** A writer's identity within a space, as lowercase hex. */
export type WriterId = string;

/**
 * What a peer knows of one writer's chain (§2.3).
 *
 * `frontier` is the highest **contiguous** sequence number held. "Contiguous" is
 * load-bearing: a peer holding 0–47 and also 49 reports 47, because reporting 49
 * would suppress the send of 48 — the one event needed to unstall the chain.
 *
 * `tip` is the id of the event at that frontier, and it is what makes a fork
 * *detectable*. Two peers can agree on a number while holding different
 * histories; comparing `(frontier, tip)` cannot miss that.
 */
export interface WriterFrontier {
  readonly frontier: number;
  readonly tip: Hash;
}

/** A peer's knowledge of a space, per writer (§2.3). */
export type VersionVector = ReadonlyMap<WriterId, WriterFrontier>;

/**
 * A range of one writer's chain to read.
 *
 * `from` is inclusive, `to` exclusive. Both are sequence numbers, so a caller
 * asks for what it lacks rather than for a byte offset.
 */
export interface SeqRange {
  readonly writer: WriterId;
  readonly from: number;
  readonly to?: number;
}

/**
 * Why an append was refused.
 *
 * A returned value rather than an exception, because the caller decides what a
 * refusal means: a peer drops the event and may report the sender, a local
 * writer has a bug, a diagnostic wants to say which check failed.
 */
export type AppendRejection =
  /** Already held. Appending twice is a no-op, not an error (§1.1). */
  | { readonly kind: 'duplicate'; readonly writer: WriterId; readonly seq: number }
  /** `seq` skips ahead of what is held: the caller has a gap to fill first. */
  | { readonly kind: 'gap'; readonly writer: WriterId; readonly expected: number; readonly got: number }
  /** `prev` does not match the event it claims to follow — a fork or a graft. */
  | { readonly kind: 'fork'; readonly writer: WriterId; readonly seq: number }
  /** The signature does not verify for the claimed writer, in this space. */
  | { readonly kind: 'unverified'; readonly writer: WriterId; readonly seq: number };

export interface AppendResult {
  /** Events actually written, in chain order. */
  readonly appended: readonly Event[];
  /** Events refused, each with why. */
  readonly rejected: readonly { readonly event: Event; readonly why: AppendRejection }[];
}

/**
 * A space's event log and blob store.
 *
 * One instance per space. **Blob stores are per space** (§2.4): a single store
 * shared across spaces answers a request for bytes regardless of which space the
 * requester belongs to, so a peer learns whether this device holds given content
 * without being able to see the space that references it.
 */
export interface SpaceStore {
  readonly space: SpaceId;

  /* ── events ───────────────────────────────────────────────────────────── */

  /**
   * Append events, verifying each against the chain it extends.
   *
   * Events may arrive in any order and for any writer; the implementation
   * applies what it can. Anything whose predecessor is absent is refused with a
   * `gap`, for the caller to fill and retry — this store does not buffer, which
   * is `net`'s job (§2.5).
   */
  append(events: readonly Event[]): Promise<AppendResult>;

  /** Every event held, in no guaranteed order. */
  readAll(): AsyncIterable<Event>;

  /** One writer's chain, ascending by `seq`. */
  readRange(range: SeqRange): AsyncIterable<Event>;

  /** What this peer knows, per writer (§2.3). */
  versionVector(): Promise<VersionVector>;

  /** How many events are held. */
  count(): Promise<number>;

  /* ── blobs ────────────────────────────────────────────────────────────── */

  /**
   * Store bytes under their own hash.
   *
   * The hash is computed here rather than trusted from the caller, so a
   * mislabelled blob cannot enter the store. Returns the hash it was stored
   * under.
   */
  putBlob(bytes: Uint8Array): Promise<Hash>;

  /** Bytes by hash, or null. */
  getBlob(hash: Hash): Promise<Uint8Array | null>;

  hasBlob(hash: Hash): Promise<boolean>;

  /** Every blob hash held — what a `HAVE` exchange advertises (§2.4). */
  blobHashes(): AsyncIterable<Hash>;

  /** Remove a blob. Events are never deleted; blobs are a cache. */
  deleteBlob(hash: Hash): Promise<void>;

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  close(): Promise<void>;
}

/**
 * Where spaces live.
 *
 * A backend is this plus a `SpaceStore` implementation. Nothing above the store
 * package should know which one it holds.
 */
export interface Store {
  /** Open a space, creating it if absent. */
  open(space: SpaceId, key: PublicKey): Promise<SpaceStore>;

  /** Spaces this store holds. */
  list(): Promise<readonly SpaceId[]>;

  /** Forget a space entirely: its log, its blobs, its identity. */
  destroy(space: SpaceId): Promise<void>;

  close(): Promise<void>;
}
