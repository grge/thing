/**
 * Deriving a renderable tree from folded state (§4.1, §8.1).
 *
 * Paths are derived, never stored. This is the UI convenience §4.1 describes
 * and nothing more.
 */
import { hex, type ObjectState, ROOT, type State, type Uuid } from '../fold/index.js';

export interface TreeNode {
  readonly obj: ObjectState;
  readonly key: string;
  readonly depth: number;
  readonly children: TreeNode[];
}

/**
 * Build the forest under ROOT.
 *
 * Sorted by kind then name then uuid: directories first, which is the ordinary
 * file-browser convention, and uuid last so siblings with identical names
 * (§4.2 says these are legal) still have a stable, peer-identical order.
 */
export function buildTree(state: State, showDeleted: boolean): TreeNode[] {
  const rootKey = hex(ROOT);
  const byParent = new Map<string, ObjectState[]>();
  for (const obj of state.objects.values()) {
    if (obj.deleted && !showDeleted) continue;
    // ROOT is a sentinel, not a real object. The fold materialises it as soon
    // as anything is parented to it (§3.5 totality), and its own `parent`
    // defaults to ROOT — so without this it appears as its own child.
    if (hex(obj.uuid) === rootKey) continue;
    const pk = hex(obj.parent);
    let bucket = byParent.get(pk);
    if (bucket === undefined) {
      bucket = [];
      byParent.set(pk, bucket);
    }
    bucket.push(obj);
  }

  const seen = new Set<string>();

  const build = (parentKey: string, depth: number): TreeNode[] => {
    const kids = byParent.get(parentKey) ?? [];
    const sorted = [...kids].sort(compareObjects);
    const out: TreeNode[] = [];
    for (const obj of sorted) {
      const key = hex(obj.uuid);
      // Defensive: resolveCycles should make this unreachable (§4.1).
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ obj, key, depth, children: build(key, depth + 1) });
    }
    return out;
  };

  return build(rootKey, 0);
}

function compareObjects(a: ObjectState, b: ObjectState): number {
  const ad = a.kind === 'dir' ? 0 : 1;
  const bd = b.kind === 'dir' ? 0 : 1;
  if (ad !== bd) return ad - bd;
  const an = a.name ?? '';
  const bn = b.name ?? '';
  if (an !== bn) return an < bn ? -1 : 1;
  return hex(a.uuid) < hex(b.uuid) ? -1 : 1;
}

/** Flatten to visible rows, honouring which directories are expanded. */
export function flatten(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: readonly TreeNode[]): void => {
    for (const n of ns) {
      out.push(n);
      if (n.children.length > 0 && expanded.has(n.key)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Would moving `target` under `newParent` create a cycle?
 *
 * The fold breaks cycles deterministically (§4.1), so this is not needed for
 * correctness — but a drag that visibly re-parents something to ROOT is a
 * baffling outcome, and refusing the drop is kinder than performing it.
 */
export function wouldCycle(state: State, target: Uuid, newParent: Uuid): boolean {
  const targetKey = hex(target);
  let cur = hex(newParent);
  const rootKey = hex(ROOT);
  const guard = new Set<string>();

  while (cur !== rootKey) {
    if (cur === targetKey) return true;
    if (guard.has(cur)) return false;
    guard.add(cur);
    const obj = state.objects.get(cur);
    if (obj === undefined) return false;
    cur = hex(obj.parent);
  }
  return false;
}
