/**
 * The sequence rule (ARCHITECTURE.md §3.8) — an ordered list two writers can
 * edit at once.
 *
 * **This is the bet.** §3.8 asks whether "merge rule" stays a small vocabulary
 * or becomes "arbitrary code with private state". A sequence is the rule most
 * likely to break that, so it fits the ordinary `Rule` contract or the
 * vocabulary does not hold. Nothing here reaches outside `Entry` — no log
 * access, no clock, no other slice.
 *
 * Values are **operations**, not assertions, which is the one place this rule
 * differs from a register:
 *
 * ```
 * { op: 'ins', after: ElementId | null, body: bytes }
 * { op: 'del', target: ElementId }
 * ```
 *
 * Ordering is RGA's: among elements sharing an anchor, the later
 * `(lamport, writer)` sorts first. Deterministic from the events alone, which
 * is what keeps the fold order-independent (§3.6).
 *
 * See `docs/design/SEQUENCE.md` for the canonical form, pinned before this was coded.
 */
import { compareBytes, hex, Writer as ByteWriter } from './bytes.js';
import type { Key } from './chain.js';
import type { Acc, Entry, Rule } from './rule.js';

/**
 * An element's identity: the event that created it.
 *
 * **`writer/point/seq`, not `writer/seq`.** The prototype used the latter, and
 * it stopped being unique when append points arrived (§2.1): one writer has
 * several chains, each with its own `seq 0`, so two of that writer's own
 * processes would mint the same id for different elements. Every anchor would
 * be ambiguous and a delete could hit the wrong element — silently, since the
 * result is a plausible list in the wrong order.
 *
 * Derived from the event rather than minted by the rule, which is what makes a
 * missing anchor an ordinary chain gap (§2.5) rather than a new kind of lookup.
 */
export type ElementId = string;

export function elementIdOf(key: Key): ElementId {
  return `${hex(key.writer)}/${hex(key.id)}`;
}

export type SeqOp =
  | { readonly op: 'ins'; readonly after: ElementId | null; readonly body: Uint8Array }
  | { readonly op: 'del'; readonly target: ElementId };

/** One element, as the accumulator holds it. */
export interface SeqNode {
  readonly id: ElementId;
  readonly after: ElementId | null;
  readonly body: Uint8Array;
  /** RGA's tiebreak among elements sharing an anchor. */
  readonly lamport: number;
  readonly writer: Uint8Array;
  deleted: boolean;
}

/**
 * The accumulator.
 *
 * Holds tombstones, anchors and comparison metadata — none of it observable,
 * all of it necessary: a concurrent insert may still anchor to a deleted
 * element, so a tombstone cannot be dropped when the delete arrives (§3.8).
 */
export interface SeqAcc {
  readonly nodes: Map<ElementId, SeqNode>;
  /** Deletes whose target has not arrived. Not part of the canonical form. */
  readonly orphanDeletes: Set<ElementId>;
}

/* ── codec ──────────────────────────────────────────────────────────────── */

const INS = 1;
const DEL = 2;

/**
 * Operations as bytes.
 *
 * `decode` returns null rather than throwing for anything it cannot read: the
 * fold is total (§3.4), so a malformed value is one the rule ignores.
 */
const codec = {
  decode(bytes: Uint8Array): SeqOp | null {
    try {
      if (bytes.length < 1) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let at = 1;
      const readId = (): ElementId | null => {
        const present = bytes[at];
        at += 1;
        if (present === 0) return null;
        if (present !== 1) throw new Error('bad presence byte');
        const len = view.getUint32(at, false);
        at += 4;
        const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + len));
        at += len;
        return s;
      };

      if (bytes[0] === INS) {
        const after = readId();
        const len = view.getUint32(at, false);
        at += 4;
        const body = bytes.slice(at, at + len);
        if (body.length !== len) return null;
        return { op: 'ins', after, body };
      }
      if (bytes[0] === DEL) {
        const target = readId();
        if (target === null) return null;
        return { op: 'del', target };
      }
      return null;
    } catch {
      return null;
    }
  },

  encode(value: SeqOp): Uint8Array {
    const w = new ByteWriter();
    const writeId = (id: ElementId | null): void => {
      if (id === null) {
        w.u8(0);
        return;
      }
      w.u8(1);
      const bytes = new TextEncoder().encode(id);
      w.u32(bytes.length);
      w.bytes(bytes);
    };
    if (value.op === 'ins') {
      w.u8(INS);
      writeId(value.after);
      w.u32(value.body.length);
      w.bytes(value.body);
    } else {
      w.u8(DEL);
      writeId(value.target);
    }
    return w.finish();
  },
};

/* ── merge ──────────────────────────────────────────────────────────────── */

function empty(): SeqAcc {
  return { nodes: new Map(), orphanDeletes: new Set() };
}

/**
 * Apply operations.
 *
 * Idempotent and order-independent, which is what the homomorphism needs: an
 * insert seen twice is one node, and a delete arriving before its target is
 * held rather than dropped — dropping it would make state depend on the order
 * events happened to arrive.
 */
function step(acc: SeqAcc, entries: readonly Entry<SeqOp>[]): Acc<SeqAcc> {
  const nodes = new Map(acc.nodes);
  const orphans = new Set(acc.orphanDeletes);

  for (const { key, value } of entries) {
    if (value.op === 'ins') {
      const id = elementIdOf(key);
      // Idempotent: the same event applied twice is the same node.
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          after: value.after,
          body: value.body,
          lamport: key.lamport,
          writer: key.writer,
          deleted: orphans.has(id),
        });
        orphans.delete(id);
      }
    } else {
      const target = nodes.get(value.target);
      if (target === undefined) {
        // The target may still arrive. Held, never discarded.
        orphans.add(value.target);
      } else {
        nodes.set(value.target, { ...target, deleted: true });
      }
    }
  }

  // Inserts whose anchor has not arrived are *not* held here: they are in
  // `nodes` and simply do not appear in `render` until the anchor does. That
  // keeps `step` a pure function of the bag, and makes the pending case a
  // property of rendering rather than extra accumulator state (§3.4).
  return { acc: { nodes, orphanDeletes: orphans } };
}

/**
 * The observable list: live elements, in order.
 *
 * Tombstones are not here — a deleted element is not in the list and its
 * position is not observable (§3.6's "hash the observable state"). Elements
 * whose anchor is missing are also absent, and appear when it arrives.
 */
function render(acc: SeqAcc): readonly Uint8Array[] {
  const children = new Map<ElementId | null, SeqNode[]>();
  for (const node of acc.nodes.values()) {
    // An anchor naming an element nobody holds is not placeable yet.
    if (node.after !== null && !acc.nodes.has(node.after)) continue;
    let siblings = children.get(node.after);
    if (siblings === undefined) {
      siblings = [];
      children.set(node.after, siblings);
    }
    siblings.push(node);
  }

  // RGA: among elements sharing an anchor, later `(lamport, writer)` first.
  // Ties on id, so two implementations cannot disagree.
  for (const siblings of children.values()) {
    siblings.sort((a, b) => {
      if (a.lamport !== b.lamport) return b.lamport - a.lamport;
      const byWriter = compareBytes(b.writer, a.writer);
      if (byWriter !== 0) return byWriter;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  const out: Uint8Array[] = [];
  const walk = (anchor: ElementId | null): void => {
    for (const node of children.get(anchor) ?? []) {
      if (!node.deleted) out.push(node.body);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

export const sequence: Rule<SeqOp, SeqAcc, readonly Uint8Array[]> = {
  id: 'sequence',
  codec,
  merge: { empty, step, render },
};

/* ── canonical form (§3.6) ──────────────────────────────────────────────── */

/**
 * The accumulator as bytes, pinned.
 *
 * **Sorted by element id, not by list position.** Two implementations may build
 * the list by different traversals and disagree about intermediate structure
 * while agreeing exactly on the set of nodes; sorting by an intrinsic key
 * removes that freedom. `docs/design/SEQUENCE.md` has the layout.
 *
 * Orphan deletes are deliberately excluded: they describe what a peer has
 * *received*, not what the state *is*.
 */
export function encodeSeqAcc(acc: SeqAcc): Uint8Array {
  const w = new ByteWriter();
  const ids = [...acc.nodes.keys()].sort();
  w.u32(ids.length);
  for (const id of ids) {
    const node = acc.nodes.get(id)!;
    const idBytes = new TextEncoder().encode(node.id);
    w.u32(idBytes.length);
    w.bytes(idBytes);
    if (node.after === null) {
      w.u8(0);
    } else {
      w.u8(1);
      const a = new TextEncoder().encode(node.after);
      w.u32(a.length);
      w.bytes(a);
    }
    w.u8(node.deleted ? 1 : 0);
    w.u64(node.lamport);
    w.u32(node.body.length);
    w.bytes(node.body);
  }
  return w.finish();
}
