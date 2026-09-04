/**
 * Incremental folding.
 *
 * A `Folder` holds folded state and updates it as events arrive, instead of
 * replaying the log from empty on every change. That is possible because every
 * merge rule is a homomorphism (`rule.ts`): folding part of a bag and then
 * folding the rest onto the result gives the same answer as folding everything
 * at once.
 *
 * **One event invalidates one slice** — except `:parent`, which feeds the
 * cycle-breaking pass. Cycle-breaking reads every resolved parent at once,
 * because a cycle is a property of the graph rather than of any one bag
 * (ARCHITECTURE.md §3.4), so a `:parent` write invalidates the tree while every
 * other write is local.
 *
 * The guarantee this must uphold, and which `peer` property-tests on every
 * generated history: **an incremental fold and a full refold agree, always.**
 * Anything else would mean a long-running peer drifting from one that just
 * restarted.
 */
import { hex } from './bytes.js';
import { keyOf } from './chain.js';
import { type Event, ROOT, type Uuid } from './event.js';
import {
  BODY_ATTR,
  KIND_ATTR,
  type ObjectState,
  PARENT_ATTR,
  resolveParents,
  type SliceState,
  type State,
  writerSetFrom,
} from './fold.js';
import type { AnyRule, Entry } from './rule.js';
import { attributeRule, bodyRule } from './rules.js';
import type { PublicKey } from './sign.js';

/** A slice's accumulated state, kept so later events can be merged onto it. */
interface LiveSlice {
  readonly rule: AnyRule;
  acc: unknown;
  value: unknown;
  pending?: readonly Entry<unknown>[];
}

interface LiveObject {
  readonly uuid: Uuid;
  readonly attrs: Map<string, LiveSlice>;
  body?: LiveSlice;
  /** Raw body entries, retained because the rule may not be known yet. */
  bodyEntries: Entry<Uint8Array>[];
  bodyRuleMissing?: string;
}

/**
 * Folded state that can be advanced.
 *
 * Construct with the space key, feed it events, read `state`. Feeding the same
 * event twice is a no-op, because every rule is idempotent.
 */
export class Folder {
  private readonly root = new Map<string, LiveSlice>();
  private readonly objects = new Map<string, LiveObject>();
  /** Set when a `:parent` changed, so the tree is recomputed once per read. */
  private treeDirty = true;
  private parents = new Map<string, { parent: Uuid; broken: boolean }>();
  private writers: ReadonlySet<string> | null = null;
  private readonly spaceHex: string;
  /**
   * Events held because their writer was not admitted when they arrived.
   *
   * The writer set can grow — a root event admitting someone may arrive after
   * their writes. Without this, an event that arrived early would be dropped
   * and never reconsidered, and a peer's state would depend on delivery order.
   */
  private deferred: Event[] = [];

  constructor(private readonly space: PublicKey) {
    this.spaceHex = hex(space);
  }

  /** Fold events in. Order does not matter; duplicates are harmless. */
  apply(events: Iterable<Event>): void {
    // Root events first, in case they admit writers whose events are in the
    // same batch. Everything else is order-independent anyway.
    const rest: Event[] = [];
    for (const e of events) {
      if (isRoot(e.target)) this.applyRoot(e);
      else rest.push(e);
    }

    const retry = this.deferred;
    this.deferred = [];
    for (const e of [...retry, ...rest]) this.applyOther(e);
  }

  private applyRoot(e: Event): void {
    // §7.2.1: root events are admitted on a signature from the space key
    // alone, so this consults no state and there is no fixed point to find.
    if (hex(e.writer) !== this.spaceHex) return;

    const before = this.writers;
    this.mergeInto(this.root, e.attr, attributeRule(e.attr), e);

    this.writers = writerSetFrom(sliceValues(this.root), this.spaceHex);
    // A widened writer set may admit events already seen and set aside.
    if (before !== this.writers) {
      const retry = this.deferred;
      this.deferred = [];
      for (const held of retry) this.applyOther(held);
    }
  }

  private applyOther(e: Event): void {
    if (this.writers !== null && !this.writers.has(hex(e.writer))) {
      this.deferred.push(e);
      return;
    }

    const obj = this.ensure(e.target);

    if (e.attr === BODY_ATTR) {
      obj.bodyEntries.push({ key: keyOf(this.space, e), value: e.value });
      this.refoldBody(obj);
      return;
    }

    this.mergeInto(obj.attrs, e.attr, attributeRule(e.attr), e);

    if (e.attr === PARENT_ATTR) {
      // The one cross-slice dependency: a parent write can change which object
      // a cycle re-parents (§3.4), so the whole tree is recomputed on read.
      this.treeDirty = true;
      const parent = obj.attrs.get(PARENT_ATTR)?.value;
      if (parent instanceof Uint8Array && !isRoot(parent)) this.ensure(parent);
    }

    if (e.attr === KIND_ATTR) {
      // The body's rule may only now be known, or may have changed.
      this.refoldBody(obj);
    }
  }

  /** Merge one event into a slice, creating it if absent. */
  private mergeInto(
    slices: Map<string, LiveSlice>,
    attr: string,
    rule: AnyRule,
    e: Event,
  ): void {
    let slice = slices.get(attr);
    if (slice === undefined) {
      slice = { rule, acc: rule.merge.empty(), value: undefined };
      slices.set(attr, slice);
    }

    const value = rule.codec.decode(e.value);
    // A value the codec rejects is skipped, never fatal (§3.4).
    if (value === null) return;

    const folded = rule.merge.step(slice.acc, [{ key: keyOf(this.space, e), value }]);
    slice.acc = folded.acc;
    slice.value = rule.merge.render(folded.acc);
    if (folded.pending !== undefined) slice.pending = folded.pending;
  }

  /**
   * Refold an object's body from its retained entries.
   *
   * Not incremental, deliberately: a `:kind` write can change which rule
   * applies, and entries that arrived before the kind was known must then be
   * reinterpreted. Bodies are refolded from their own entries only, so the cost
   * is bounded by one object rather than by the log.
   */
  private refoldBody(obj: LiveObject): void {
    const kindValue = obj.attrs.get(KIND_ATTR)?.value;
    const kind = typeof kindValue === 'string' ? kindValue : null;
    const rule = bodyRule(kind);

    if (rule === null) {
      delete obj.body;
      // Only report a missing rule for an object that actually has a body:
      // a folder has no `:kind` and no body, and is not "unreadable".
      if (obj.bodyEntries.length > 0) obj.bodyRuleMissing = kind ?? '(none)';
      else delete obj.bodyRuleMissing;
      return;
    }

    delete obj.bodyRuleMissing;
    const decoded: Entry<unknown>[] = [];
    for (const entry of obj.bodyEntries) {
      const value = rule.codec.decode(entry.value);
      if (value !== null) decoded.push({ key: entry.key, value });
    }
    const folded = rule.merge.step(rule.merge.empty(), decoded);
    obj.body = {
      rule,
      acc: folded.acc,
      value: rule.merge.render(folded.acc),
      ...(folded.pending === undefined ? {} : { pending: folded.pending }),
    };
  }

  private ensure(target: Uuid): LiveObject {
    const k = hex(target);
    let obj = this.objects.get(k);
    if (obj === undefined) {
      obj = { uuid: target, attrs: new Map(), bodyEntries: [] };
      this.objects.set(k, obj);
      this.treeDirty = true;
    }
    return obj;
  }

  /** The current state. Recomputes the tree only if a `:parent` changed. */
  get state(): State {
    if (this.treeDirty) {
      this.parents = resolveParents(
        new Map([...this.objects].map(([k, o]) => [k, sliceValues(o.attrs)])),
        new Map([...this.objects].map(([k, o]) => [k, o.uuid])),
      );
      this.treeDirty = false;
    }

    const objects = new Map<string, ObjectState>();
    for (const [k, o] of this.objects) {
      const resolved = this.parents.get(k) ?? { parent: ROOT, broken: false };
      const attrs = new Map<string, SliceState>();
      for (const [name, s] of o.attrs) attrs.set(name, toSliceState(s));

      objects.set(k, {
        uuid: o.uuid,
        attrs,
        parent: resolved.parent,
        cycleBroken: resolved.broken,
        ...(o.body === undefined ? {} : { body: toSliceState(o.body) }),
        ...(o.bodyRuleMissing === undefined ? {} : { bodyRuleMissing: o.bodyRuleMissing }),
      });
    }

    const root = new Map<string, SliceState>();
    for (const [name, s] of this.root) root.set(name, toSliceState(s));

    return { root, objects };
  }
}

function toSliceState(s: LiveSlice): SliceState {
  return {
    rule: s.rule.id,
    acc: s.acc,
    value: s.value,
    ...(s.pending === undefined ? {} : { pending: s.pending }),
  };
}

/** A view of live slices as the rendered values `resolveParents` expects. */
function sliceValues(slices: ReadonlyMap<string, LiveSlice>): ReadonlyMap<string, SliceState> {
  const out = new Map<string, SliceState>();
  for (const [name, s] of slices) out.set(name, toSliceState(s));
  return out;
}

function isRoot(u: Uuid): boolean {
  return hex(u) === hex(ROOT);
}
