/**
 * The folded state: what a set of events means (§4).
 */
import type { Hash, Kind, Pos, Uuid } from './types.js';

export interface ObjectState {
  readonly uuid: Uuid;
  /** Resolved `:parent` after cycle-breaking (§4.1). ROOT if never set. */
  readonly parent: Uuid;
  /** Resolved `:name`, or null if the object has no name event (§4.2). */
  readonly name: string | null;
  /** Full SHA-256 of the plaintext blob, or null for no content (§4.3). */
  readonly content: Hash | null;
  /** Fixed-point canvas coordinates, or null if never positioned (§4.4). */
  readonly pos: Pos | null;
  /** Derived predicate over the whole event set, NOT a plain LWW slot (§4.5). */
  readonly deleted: boolean;
  /** Advisory: tells the UI how to render (§4.6). Null if never set. */
  readonly kind: Kind | null;
  /**
   * MIME type, asserted at creation and replicated like any other attribute
   * (§4.7). Names a *format*, never a renderer — a client with no renderer for
   * it degrades by suffix and then by base type. Null if never asserted.
   */
  readonly type: string | null;
  /**
   * True if this object was re-parented to ROOT to break a cycle (§4.1).
   * Fold-local state, never an event. Recomputed on every fold, so it vanishes
   * when the cycle does.
   */
  readonly cycleBroken: boolean;
}

export interface State {
  /** Every object any event has mentioned, keyed by hex(uuid). */
  readonly objects: ReadonlyMap<string, ObjectState>;
}
