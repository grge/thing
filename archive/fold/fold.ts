/**
 * The fold: a pure function from an event *set* to state (§1.3, §4).
 *
 * THE load-bearing property: any peer that has applied the same set of events
 * holds the same state, regardless of arrival order. Everything here is written
 * to preserve that, and `src/fold/fold.test.ts` checks it by shuffling.
 *
 * The fold is TOTAL (§3.5). It must produce sensible state for any event set,
 * including one referencing an absent blob, an unknown parent UUID, or an
 * object with no `:kind`. There is no event set it may reject.
 */
import { hex } from './hash.js';
import { compareKeys, greater, type Key, keyOf, type MaybeKey, maxKey } from './key.js';
import type { ObjectState, State } from './state.js';
import { type Event, type Hash, type Kind, type Link, type Pos, ROOT, type Uuid } from './types.js';

/** Per-object accumulator. Every field is a max over a set, hence commutative. */
interface Acc {
  uuid: Uuid;

  parent: Uuid;
  parentKey: MaybeKey;

  name: string | null;
  nameKey: MaybeKey;

  content: Hash | null;
  contentKey: MaybeKey;

  pos: Pos | null;
  posKey: MaybeKey;

  kind: Kind | null;
  kindKey: MaybeKey;

  type: string | null;
  typeKey: MaybeKey;
  link: Link | null;
  linkKey: MaybeKey;

  /**
   * §4.5. `kill` is the max key over `:deleted = true` events; `live` is the max
   * key over `:content`/`:name`/`:parent`/`:pos`/`:deleted = false` events.
   * Both are maxima over sets, so both are order-independent.
   */
  kill: MaybeKey;
  live: MaybeKey;
}

function emptyAcc(uuid: Uuid): Acc {
  return {
    uuid,
    parent: ROOT,
    parentKey: null,
    name: null,
    nameKey: null,
    content: null,
    contentKey: null,
    pos: null,
    posKey: null,
    kind: null,
    kindKey: null,
    type: null,
    typeKey: null,
    link: null,
    linkKey: null,
    kill: null,
    live: null,
  };
}

/**
 * Fold an event set into state.
 *
 * Takes an iterable, not an array, and never inspects arrival order: the only
 * comparisons made are `(lamport, writer)` maxima (§2.2). Duplicate events are
 * harmless — applying the same event twice is a no-op, because a max over a set
 * does not care how many times a member appears.
 */
export function fold(events: Iterable<Event>): State {
  const accs = new Map<string, Acc>();

  const accFor = (uuid: Uuid): Acc => {
    const k = hex(uuid);
    let a = accs.get(k);
    if (a === undefined) {
      a = emptyAcc(uuid);
      accs.set(k, a);
    }
    return a;
  };

  for (const e of events) {
    const a = accFor(e.target);
    const key = keyOf(e);

    switch (e.attr) {
      case ':parent': {
        if (e.value.t !== 'uuid') break; // malformed: ignore, stay total (§3.5)
        if (greater(key, a.parentKey)) {
          a.parent = e.value.v;
          a.parentKey = key;
        }
        a.live = maxKey(a.live, key);
        // The parent may be an object no event has ever targeted. That is legal
        // and it must still appear in state, so materialise it (§3.5).
        accFor(e.value.v);
        break;
      }

      case ':name': {
        if (e.value.t !== 'string') break;
        if (greater(key, a.nameKey)) {
          a.name = e.value.v;
          a.nameKey = key;
        }
        a.live = maxKey(a.live, key);
        break;
      }

      case ':content': {
        if (e.value.t !== 'hash' && e.value.t !== 'null') break;
        if (greater(key, a.contentKey)) {
          a.content = e.value.t === 'hash' ? e.value.v : null;
          a.contentKey = key;
        }
        a.live = maxKey(a.live, key);
        break;
      }

      case ':pos': {
        if (e.value.t !== 'pos') break;
        if (greater(key, a.posKey)) {
          a.pos = e.value.v;
          a.posKey = key;
        }
        a.live = maxKey(a.live, key);
        break;
      }

      case ':kind': {
        if (e.value.t !== 'kind') break;
        if (greater(key, a.kindKey)) {
          a.kind = e.value.v;
          a.kindKey = key;
        }
        // NOTE: `:kind` is deliberately NOT a live-attr event. §4.5 lists
        // exactly `:content`, `:name`, `:parent`, `:pos` and `:deleted = false`.
        break;
      }

      case ':type': {
        if (e.value.t !== 'string') break;
        if (greater(key, a.typeKey)) {
          a.type = e.value.v;
          a.typeKey = key;
        }
        // Like `:kind`, not a live-attr event: asserting a format is not a
        // reason to revive a tombstoned object (§4.5).
        break;
      }

      case ':link': {
        if (e.value.t !== 'link') break;
        if (greater(key, a.linkKey)) {
          a.link = e.value.v;
          a.linkKey = key;
        }
        // Unlike `:kind` and `:type`, this **is** a live-attr event. Setting a
        // link is authoring — it is what the object is *for* — so it revives a
        // tombstoned object exactly as writing `:content` does. The reasoning
        // in §4.5 applies unchanged: a resurrected object is recoverable by
        // re-deleting, whereas an authored link vanishing behind a tombstone
        // looks like data loss.
        a.live = maxKey(a.live, key);
        break;
      }

      case ':deleted': {
        if (e.value.t !== 'bool') break;
        if (e.value.v) {
          a.kill = maxKey(a.kill, key);
        } else {
          // An explicit undelete counts as a live-attr event (§4.5).
          a.live = maxKey(a.live, key);
        }
        break;
      }
    }
  }

  const parents = resolveCycles(accs);

  const objects = new Map<string, ObjectState>();
  for (const [k, a] of accs) {
    const resolved = parents.get(k)!;
    objects.set(k, {
      uuid: a.uuid,
      parent: resolved.parent,
      name: a.name,
      content: a.content,
      pos: a.pos,
      // §4.5: deleted iff a kill exists and beats every live-attr write.
      deleted: a.kill !== null && greater(a.kill, a.live),
      kind: a.kind,
      type: a.type,
      link: a.link,
      cycleBroken: resolved.broken,
    });
  }

  return { objects };
}

interface Resolved {
  parent: Uuid;
  broken: boolean;
}

/**
 * Break cycles in the resolved parent map (§4.1).
 *
 * Within each cycle, the object with the lexicographically smallest UUID is
 * re-parented to ROOT. Repeat until no cycle remains.
 *
 * Depth is not usable as the tiebreak — inside a cycle no node has a depth,
 * which is what a cycle means — and any rule referring to prior state would let
 * peers that folded different event orders disagree. The UUID rule is a
 * function of the resolved parent map alone, so every peer picks the same
 * victim.
 */
function resolveCycles(accs: ReadonlyMap<string, Acc>): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  for (const [k, a] of accs) {
    out.set(k, { parent: a.parent, broken: false });
  }

  const rootKey = hex(ROOT);

  // Iterate to a fixed point: breaking one cycle can leave another intact.
  for (;;) {
    const cycle = findCycle(out, rootKey);
    if (cycle === null) break;

    // Smallest UUID in the cycle, by the hex key (order-equivalent to
    // lexicographic byte order, since hex is fixed-width and monotonic).
    let victim = cycle[0]!;
    for (const k of cycle) if (k < victim) victim = k;

    out.set(victim, { parent: ROOT, broken: true });
  }

  return out;
}

/**
 * Find any one cycle in the parent map, returned as its member keys.
 * Returns null when the map is acyclic.
 *
 * Walks from each node following `parent`. A node whose parent is ROOT, or is
 * absent from the map, terminates the walk — an unknown parent is legal (§3.5).
 */
function findCycle(map: ReadonlyMap<string, Resolved>, rootKey: string): string[] | null {
  const SAFE = 1; // proven to reach root / a dead end
  const state = new Map<string, number>();

  for (const start of map.keys()) {
    if (state.get(start) === SAFE) continue;

    const path: string[] = [];
    const seen = new Map<string, number>(); // key -> index in `path`
    let cur = start;

    for (;;) {
      if (state.get(cur) === SAFE) break;

      const at = seen.get(cur);
      if (at !== undefined) {
        // Found a cycle: everything from its first occurrence onward.
        return path.slice(at);
      }

      seen.set(cur, path.length);
      path.push(cur);

      if (cur === rootKey) break;
      const node = map.get(cur);
      if (node === undefined) break; // unknown parent: dead end, not a cycle
      const next = hex(node.parent);
      if (next === cur) {
        // Self-parent is a cycle of one.
        return [cur];
      }
      cur = next;
    }

    for (const k of path) state.set(k, SAFE);
  }

  return null;
}

/**
 * Derive an object's path by walking `:parent` to ROOT, joining `:name` (§4.1).
 * Paths are never stored and never sent; this is a UI convenience.
 *
 * Cycle-broken objects hang off ROOT, so this always terminates.
 */
export function pathOf(state: State, uuid: Uuid): string[] {
  const parts: string[] = [];
  const rootKey = hex(ROOT);
  let cur = hex(uuid);
  const guard = new Set<string>();

  while (cur !== rootKey) {
    if (guard.has(cur)) break; // defensive; resolveCycles should prevent this
    guard.add(cur);

    const obj = state.objects.get(cur);
    if (obj === undefined) break;
    parts.push(obj.name ?? '(unnamed)');
    cur = hex(obj.parent);
  }

  return parts.reverse();
}

export { compareKeys, type Key };
