/**
 * The merge-rule vocabulary (§3.2).
 *
 * THE CONTRACT UNDER TEST. Every rule is:
 *
 *     (events for ONE slice) -> value
 *
 * It sees its own bag and nothing else. No access to other slices, no access to
 * the log, no clock, no I/O. If a rule needs more than this, §3's universality
 * claim is in trouble — that is what this file exists to find out.
 */
import { compareKeys, elementIdOf, type ElementId, type Event, keyOf } from './types.js';

/**
 * A rule folds a bag into a value, and may also report events it could not yet
 * apply.
 *
 * `pending` is §3.4's fourth totality case: an event whose anchor has not
 * arrived is held, not discarded, and folded when the anchor does. Only the
 * sequence rule ever produces it.
 */
export interface Folded {
  readonly value: unknown;
  readonly pending?: readonly Event[];
}

export type Rule = (events: readonly Event[]) => Folded;

/* ── register ──────────────────────────────────────────────────────────────
 * Highest (lamport, writer) wins. The rule every attribute slice uses (§3.2),
 * and the one the existing prototype already implements.
 */
export const register: Rule = (events) => {
  let best: Event | undefined;
  for (const e of events) {
    if (best === undefined || compareKeys(keyOf(e), keyOf(best)) > 0) best = e;
  }
  return { value: best === undefined ? null : best.value };
};

/* ── blob ──────────────────────────────────────────────────────────────────
 * §3.2 calls this "the degenerate member, not a special case": a body that is
 * a hash, with the bytes travelling by §2.4's separate path. It is exactly a
 * register over a hash, which is the point — the filesystem's existing
 * behaviour arriving as the simplest rule rather than as its own mechanism.
 */
export const blob: Rule = register;

/* ── flag ──────────────────────────────────────────────────────────────────
 * §3.2's worked example of a rule that looks like a register and is not.
 * Deleted iff a kill event beats every authoring write. A predicate over the
 * whole bag, never an incremental "later write clears the tombstone".
 */
export const flag: Rule = (events) => {
  let kill: Event | undefined;
  let live: Event | undefined;
  for (const e of events) {
    if (e.value === true) {
      if (kill === undefined || compareKeys(keyOf(e), keyOf(kill)) > 0) kill = e;
    } else {
      if (live === undefined || compareKeys(keyOf(e), keyOf(live)) > 0) live = e;
    }
  }
  const deleted =
    kill !== undefined && (live === undefined || compareKeys(keyOf(kill), keyOf(live)) > 0);
  return { value: deleted };
};

/* ── sequence ──────────────────────────────────────────────────────────────
 * The one that decided the bet (§3.8). An ordered list two writers can edit
 * concurrently.
 *
 * Events are operations, not assertions:
 *
 *     { op: 'ins', after: ElementId | null, body: unknown }
 *     { op: 'del', target: ElementId }
 *
 * Three things §3.8 says this rule must do, all tested here:
 *
 * 1. ELEMENT IDS DERIVE FROM (writer, seq). Not minted by the rule. That is
 *    what makes a missing anchor an ordinary chain gap rather than a new kind
 *    of lookup — the id names the event that created it.
 *
 * 2. TOMBSTONES LIVE IN THE FOLD OUTPUT. A deleted element keeps its position
 *    because a concurrent insert may still anchor to it. They grow with edit
 *    history and cannot be collected while any concurrent insert could still
 *    reference one.
 *
 * 3. A MISSING ANCHOR IS PENDING, NOT FATAL. The rest of the slice resolves.
 *
 * The ordering rule is RGA's: among elements sharing an anchor, later
 * (lamport, writer) sorts first. That is deterministic from the events alone,
 * which is what makes the fold order-independent.
 */
export interface SeqElement {
  readonly id: ElementId;
  readonly body: unknown;
  readonly deleted: boolean;
}

interface Node {
  readonly id: ElementId;
  readonly body: unknown;
  readonly key: { lamport: number; writer: string };
  readonly after: ElementId | null;
}

export const sequence: Rule = (events) => {
  const inserts = new Map<ElementId, Node>();
  const deletes = new Set<ElementId>();

  for (const e of events) {
    const v = e.value as { op?: string; after?: ElementId | null; target?: ElementId; body?: unknown };
    if (v?.op === 'ins') {
      const id = elementIdOf(e);
      inserts.set(id, {
        id,
        body: v.body,
        key: keyOf(e),
        after: v.after ?? null,
      });
    } else if (v?.op === 'del' && typeof v.target === 'string') {
      deletes.add(v.target);
    }
  }

  // An insert whose anchor is not in this bag cannot be placed. Hold it aside
  // (§3.4) — it is not discarded, and it resolves when the anchor arrives.
  const pending: Event[] = [];
  const placeable = new Map<ElementId, Node>();
  for (const [id, n] of inserts) {
    if (n.after === null || inserts.has(n.after)) placeable.set(id, n);
  }
  if (placeable.size !== inserts.size) {
    for (const e of events) {
      const v = e.value as { op?: string };
      if (v?.op === 'ins' && !placeable.has(elementIdOf(e))) pending.push(e);
    }
  }

  // Children of each anchor, ordered: later (lamport, writer) first. RGA's rule.
  const children = new Map<ElementId | null, Node[]>();
  for (const n of placeable.values()) {
    let list = children.get(n.after);
    if (list === undefined) {
      list = [];
      children.set(n.after, list);
    }
    list.push(n);
  }
  for (const list of children.values()) {
    list.sort((a, b) => -compareKeys(a.key, b.key));
  }

  // Walk depth-first from the head. Iterative, because a long document would
  // otherwise blow the stack.
  const out: SeqElement[] = [];
  const stack: Node[] = [...(children.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push({ id: n.id, body: n.body, deleted: deletes.has(n.id) });
    const kids = children.get(n.id);
    if (kids !== undefined) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }

  return { value: out, pending: pending.length > 0 ? pending : undefined };
};

/* ── the vocabulary ────────────────────────────────────────────────────────
 * §3.2: attribute slices are ALWAYS register. Only body rules vary, and each
 * object names one via its `:kind` attribute (§4.2).
 */
export const BODY_RULES: Record<string, Rule> = {
  blob,
  register,
  sequence,
};

/** §3.2: attribute slices need no declaration. This is why. */
export const ATTRIBUTE_RULE: Rule = register;

/** `:deleted` is the one attribute that is not a plain register (§3.2). */
export const ATTRIBUTE_OVERRIDES: Record<string, Rule> = {
  ':deleted': flag,
};
