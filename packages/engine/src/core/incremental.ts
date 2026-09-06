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
import { type Event, eventId, ROOT, type Uuid } from './event.js';
import {
  BODY_ATTR,
  KIND_ATTR,
  type ObjectState,
  PARENT_ATTR,
  resolveParents,
  type SliceState,
  type State,
  admitsWith,
  resolveForks,
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
  private readonly spaceHex: string;
  /**
   * Every non-root event seen, admitted or not.
   *
   * Kept because admission is not a property this fold can accumulate: an
   * event is judged against the writer set **its author had seen** (§7.2.3's
   * `deps`), and a root event arriving later can change the answer for events
   * already folded — in either direction. Rather than track that, non-root
   * state is recomputed from here whenever anything arrives.
   *
   * The cost is holding the log in memory, which `Space` already does since it
   * replays from the store on open.
   */
  private pending: Event[] = [];
  /**
   * Every event ever applied, kept so a membership change can be honoured.
   *
   * §7.2.3 judges an event against the writer set **its author had seen**
   * (`deps`), which the incremental path cannot evaluate from accumulated state
   * alone — the answer for an event already applied can change when a later
   * root event arrives. Rather than approximate it, a change to the writer set
   * refolds from here, which makes this fold agree with the full one by
   * construction rather than by argument.
   *
   * The cost is holding the log in memory. That is already true of `Space`,
   * which replays from the store on open, and a refold is rare: only a root
   * event that actually changes membership triggers one.
   */
  /**
   * Root events, kept separately.
   *
   * `admitsWith` needs them: without the root events in the set it is given it
   * sees no declaration anywhere and admits everyone. They are separate from
   * `pending` because refolding never re-applies them — root state is
   * self-authorising (§7.2.1) and does not depend on the writer set.
   */
  private roots: Event[] = [];

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

    for (const e of rest) this.pending.push(e);

    // **Always recompute admission from `deps`, never from accumulated state.**
    // An earlier version only refolded when membership changed, which left
    // events arriving *after* a change judged against the current writer set
    // rather than against what their author had seen — the same disagreement
    // this change exists to remove, reintroduced one layer down. Recomputing
    // unconditionally is slower and cannot drift.
    this.refold();
  }

  private applyRoot(e: Event): void {
    // §7.2.1: root events are admitted on a signature from the space key
    // alone, so this consults no state and there is no fixed point to find.
    if (hex(e.writer) !== this.spaceHex) return;

    this.roots.push(e);
    this.mergeInto(this.root, e.attr, attributeRule(e.attr), e);
    // No writer set is cached. Admission is recomputed from `deps` on every
    // apply — caching it here is exactly what made this fold disagree with a
    // replay.
  }

  /**
   * Rebuild non-root state from every event held.
   *
   * Called when membership changes. The root is left alone — root events are
   * self-authorising (§7.2.1), so nothing about them depends on the writer set.
   */
  private refold(): void {
    this.objects.clear();
    this.parents.clear();
    this.treeDirty = true;

    // Forks first, then `deps` — the same two functions the full fold uses, in
    // the same order, so the two cannot give different answers. A losing branch
    // must be gone before admission is computed, since it must not contribute
    // to anything at all (§7.3.1).
    const live = resolveForks(this.space, [...this.roots, ...this.pending]);
    const admits = admitsWith(this.space, live, this.spaceHex);
    const rootIds = new Set(this.roots.map((e) => hex(eventId(this.space, e))));
    for (const e of live) {
      if (rootIds.has(hex(eventId(this.space, e)))) continue;
      if (admits(e)) this.applyOther(e);
    }
  }

  private applyOther(e: Event): void {
    // Note this admits against the writer set *as it currently stands*, which
    // is not what §7.2.3 asks for — an event should be judged against what its
    // author had seen (`deps`). Applying an event is monotonic here, so an
    // event admitted before a removal stays applied, which happens to match
    // "valid when written" for the ordinary case and does not for events that
    // arrive after the removal. `refold()` is what makes the two agree.


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
