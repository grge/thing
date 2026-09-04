import { describe, expect, it } from 'vitest';
import { buildTree, flatten, wouldCycle } from './tree.js';
import { fold, hex, ROOT } from '../fold/index.js';
import { TestWriter, uuid, writer } from '../fold/testkit.js';

const names = (ns: { obj: { name: string | null } }[]) => ns.map((n) => n.obj.name);

describe('buildTree (§8.1)', () => {
  it('nests children under their parent', () => {
    const a = new TestWriter(writer('alice'));
    const d = uuid('dir');
    const f = uuid('file');
    const s = fold([
      a.kind(d, 'dir'),
      a.name(d, 'docs'),
      a.parent(d, ROOT),
      a.kind(f, 'file'),
      a.name(f, 'notes.txt'),
      a.parent(f, d),
    ]);
    const tree = buildTree(s, false);
    expect(names(tree)).toEqual(['docs']);
    expect(names(tree[0]!.children)).toEqual(['notes.txt']);
  });

  it('sorts directories before files, then by name', () => {
    const a = new TestWriter(writer('alice'));
    const mk = (u: string, n: string, k: 'file' | 'dir') => {
      const t = uuid(u);
      return [a.kind(t, k), a.name(t, n), a.parent(t, ROOT)];
    };
    const s = fold([...mk('z', 'zebra', 'file'), ...mk('a', 'apple', 'file'), ...mk('d', 'dir', 'dir')]);
    expect(names(buildTree(s, false))).toEqual(['dir', 'apple', 'zebra']);
  });

  it('keeps siblings with identical names, ordered stably by uuid (§4.2)', () => {
    const a = new TestWriter(writer('alice'));
    const [x, y] = [uuid('bbb'), uuid('aaa')];
    const s = fold([
      a.kind(x, 'file'), a.name(x, 'same'), a.parent(x, ROOT),
      a.kind(y, 'file'), a.name(y, 'same'), a.parent(y, ROOT),
    ]);
    const tree = buildTree(s, false);
    expect(names(tree)).toEqual(['same', 'same']);
    // 'aaa' sorts before 'bbb', regardless of event order.
    expect(tree[0]!.key).toBe(hex(y));
  });

  it('hides tombstoned objects unless asked for them (§4.5)', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const s = fold([a.kind(f, 'file'), a.name(f, 'gone'), a.parent(f, ROOT), a.deleted(f, true)]);
    expect(names(buildTree(s, false))).toEqual([]);
    expect(names(buildTree(s, true))).toEqual(['gone']);
  });

  it('shows an object whose parent no event ever created (§3.5)', () => {
    // The ghost parent is materialised at ROOT, so its child is still reachable.
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const ghost = uuid('ghost');
    const s = fold([a.name(f, 'orphan'), a.parent(f, ghost)]);
    const tree = buildTree(s, false);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.obj.name).toBeNull();
    expect(names(tree[0]!.children)).toEqual(['orphan']);
  });

  it('places a cycle-broken object at ROOT (§4.1)', () => {
    const a = new TestWriter(writer('alice'));
    const [x, y] = [uuid('aaa'), uuid('bbb')];
    const s = fold([a.name(x, 'x'), a.parent(x, y), a.name(y, 'y'), a.parent(y, x)]);
    const tree = buildTree(s, false);
    expect(names(tree)).toEqual(['x']);
    expect(tree[0]!.obj.cycleBroken).toBe(true);
    expect(names(tree[0]!.children)).toEqual(['y']);
  });
});

describe('flatten', () => {
  it('includes children only for expanded directories', () => {
    const a = new TestWriter(writer('alice'));
    const d = uuid('dir');
    const f = uuid('file');
    const s = fold([
      a.kind(d, 'dir'), a.name(d, 'docs'), a.parent(d, ROOT),
      a.kind(f, 'file'), a.name(f, 'notes.txt'), a.parent(f, d),
    ]);
    const tree = buildTree(s, false);
    expect(names(flatten(tree, new Set()))).toEqual(['docs']);
    expect(names(flatten(tree, new Set([hex(d)])))).toEqual(['docs', 'notes.txt']);
  });
});

describe('wouldCycle', () => {
  it('refuses a move into the subtree being moved', () => {
    const a = new TestWriter(writer('alice'));
    const parent = uuid('p');
    const child = uuid('c');
    const s = fold([a.parent(parent, ROOT), a.parent(child, parent)]);
    expect(wouldCycle(s, parent, child)).toBe(true);
    expect(wouldCycle(s, parent, parent)).toBe(true);
  });

  it('allows an ordinary move', () => {
    const a = new TestWriter(writer('alice'));
    const [d1, d2, f] = [uuid('d1'), uuid('d2'), uuid('f')];
    const s = fold([a.parent(d1, ROOT), a.parent(d2, ROOT), a.parent(f, d1)]);
    expect(wouldCycle(s, f, d2)).toBe(false);
  });
});
