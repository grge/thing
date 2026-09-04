/**
 * The fold kernel (§3.1).
 *
 * THE CLAIM UNDER TEST: this file contains no type-specific code. It does not
 * know what a filesystem is, what a chat is, or what a document is. It
 * partitions the log by slice key, applies each slice's rule, and collects.
 *
 * Three phases, each depending only on those above it (§3.1):
 *
 *   1. root            — admitted on the space key alone (§7.2.1), consults nothing
 *   2. attribute slices — ALWAYS register, so no declaration is needed
 *   3. body slices      — rule named by that object's `:kind`
 *
 * Phase 2 is the load-bearing one: because attributes never declare anything, a
 * client can always fold the STRUCTURE of a space — the tree, the names, each
 * object's `:kind` — regardless of whether it can read the bodies (§3.1).
 */
import { ATTRIBUTE_OVERRIDES, ATTRIBUTE_RULE, BODY_RULES, type Folded } from './rules.js';
import { type Event, ROOT, sliceKeyOf, splitSliceKey, type Uuid } from './types.js';

export const BODY_ATTR = ':body';

/** What one object folded to. */
export interface ObjectState {
  readonly uuid: Uuid;
  /** Attribute slices, all folded by the fixed rule. */
  readonly attrs: ReadonlyMap<string, unknown>;
  /** The body slice's value, or undefined if the object has no body. */
  readonly content?: unknown;
  /**
   * Set when the object declares a `:kind` naming a rule this client does not
   * have. §3.1: the object still appears, with correct structure — only its
   * body is unreadable. This is the failure mode §4 describes for a missing
   * view, arriving one level down.
   */
  readonly contentRuleMissing?: string;
  /** Events the body rule held aside (§3.4). */
  readonly pending?: readonly Event[];
}

export interface State {
  /** The root's attributes: writer set, view hint, name (§3.5). */
  readonly root: ReadonlyMap<string, unknown>;
  readonly objects: ReadonlyMap<Uuid, ObjectState>;
}

/** Bucket the log by slice key. One pass; the phases then run over buckets. */
function partition(events: Iterable<Event>): Map<string, Event[]> {
  const bags = new Map<string, Event[]>();
  for (const e of events) {
    const k = sliceKeyOf(e);
    let bag = bags.get(k);
    if (bag === undefined) {
      bag = [];
      bags.set(k, bag);
    }
    bag.push(e);
  }
  return bags;
}

/**
 * Fold an event set into state.
 *
 * `spaceKey` is the writer whose signature admits root events (§7.2.1). Events
 * targeting ROOT from anyone else are dropped — that is the whole of the
 * circularity fix, and it is why phase 1 can consult nothing.
 *
 * `writers` is normally read from the root in phase 1; passing it explicitly is
 * only for testing the permission check in isolation.
 */
export function fold(events: Iterable<Event>, spaceKey: string): State {
  const bags = partition(events);

  // ── Phase 1: the root. Space key only.
  const root = new Map<string, unknown>();
  for (const [k, bag] of bags) {
    const { target, attr } = splitSliceKey(k);
    if (target !== ROOT) continue;
    const admitted = bag.filter((e) => e.writer === spaceKey);
    if (admitted.length === 0) continue;
    const rule = ATTRIBUTE_OVERRIDES[attr] ?? ATTRIBUTE_RULE;
    root.set(attr, rule(admitted).value);
  }

  // The writer set, as phase 1 computed it. Everything below is checked
  // against this — validity is a local computation over the log (§7).
  const declared = root.get(':writers');
  const writerSet: Set<string> | null = Array.isArray(declared)
    ? new Set(declared as string[])
    : null;
  const admits = (e: Event): boolean =>
    writerSet === null ? true : writerSet.has(e.writer) || e.writer === spaceKey;

  // ── Phase 2: attribute slices. Always register, no declaration read.
  const attrsByObject = new Map<Uuid, Map<string, unknown>>();
  const contentBags = new Map<Uuid, Event[]>();

  for (const [k, bag] of bags) {
    const { target, attr } = splitSliceKey(k);
    if (target === ROOT) continue;

    const admitted = bag.filter(admits);
    if (admitted.length === 0) continue;

    if (attr === BODY_ATTR) {
      contentBags.set(target, admitted);
      // Materialise the object even if it has only a body (§3.4 totality).
      if (!attrsByObject.has(target)) attrsByObject.set(target, new Map());
      continue;
    }

    let attrs = attrsByObject.get(target);
    if (attrs === undefined) {
      attrs = new Map();
      attrsByObject.set(target, attrs);
    }
    const rule = ATTRIBUTE_OVERRIDES[attr] ?? ATTRIBUTE_RULE;
    attrs.set(attr, rule(admitted).value);
  }

  // An object named as someone's `:parent` but never itself written still
  // exists (§3.4). Materialise it.
  for (const attrs of [...attrsByObject.values()]) {
    const parent = attrs.get(':parent');
    if (typeof parent === 'string' && parent !== ROOT && !attrsByObject.has(parent)) {
      attrsByObject.set(parent, new Map());
    }
  }

  // ── Phase 3: body slices. Rule named by this object's `:kind`.
  const objects = new Map<Uuid, ObjectState>();
  for (const [uuid, attrs] of attrsByObject) {
    const bag = contentBags.get(uuid);
    if (bag === undefined) {
      objects.set(uuid, { uuid, attrs });
      continue;
    }

    const typeName = attrs.get(':kind');
    const ruleName = typeof typeName === 'string' ? typeName : 'blob';
    const rule = BODY_RULES[ruleName];

    if (rule === undefined) {
      // §3.1: structure is still correct; only this object is unreadable.
      objects.set(uuid, { uuid, attrs, contentRuleMissing: ruleName });
      continue;
    }

    const folded: Folded = rule(bag);
    objects.set(uuid, {
      uuid,
      attrs,
      content: folded.value,
      pending: folded.pending,
    });
  }

  return { root, objects };
}

/** Children of an object, for walking a `:parent` tree. Not part of the fold. */
export function childrenOf(state: State, parent: Uuid): ObjectState[] {
  const out: ObjectState[] = [];
  for (const o of state.objects.values()) {
    const p = o.attrs.get(':parent');
    if ((p ?? ROOT) === parent) out.push(o);
  }
  return out;
}
