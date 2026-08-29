/**
 * Integration test for stage 2: the real Space class against real storage
 * shims, exercising the operations the UI performs.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Space } from './space.js';
import type { SpaceRecord } from './storage.js';
import { buildTree } from './tree.js';
import { hex, ROOT } from '../fold/index.js';

// localStorage is not present in the node environment; a Map is enough.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const rec = (mode: SpaceRecord['mode'] = 'local'): SpaceRecord => ({
  id: 'test-space',
  name: 'test',
  mode,
});

const names = (ns: { obj: { name: string | null } }[]) => ns.map((n) => n.obj.name);

beforeEach(() => store.clear());

describe('Space (stage 2)', () => {
  it('creates a directory and a file inside it', async () => {
    const s = await Space.open(rec());
    const dir = await s.createDir(ROOT, 'docs');
    await s.createFile(dir, 'notes.txt', new TextEncoder().encode('hello'), 'text/plain');

    const tree = buildTree(s.state, false);
    expect(names(tree)).toEqual(['docs']);
    expect(names(tree[0]!.children)).toEqual(['notes.txt']);
  });

  it('round-trips through storage', async () => {
    const first = await Space.open(rec());
    const dir = await first.createDir(ROOT, 'docs');
    await first.createFile(dir, 'a.txt', new TextEncoder().encode('content'), 'text/plain');

    // A fresh Space over the same id must fold to the same tree.
    const second = await Space.open(rec());
    expect(names(buildTree(second.state, false))).toEqual(['docs']);
    expect(second.eventCount).toBe(first.eventCount);
  });

  it('stores blob bytes retrievably, addressed by content hash', async () => {
    const s = await Space.open(rec());
    const bytes = new TextEncoder().encode('the quick brown fox');
    const id = await s.createFile(ROOT, 'fox.txt', bytes, 'text/plain');

    const obj = s.state.objects.get(hex(id))!;
    expect(obj.content).not.toBeNull();
    const got = await s.content(obj.content!);
    expect(new TextDecoder().decode(got!.bytes)).toBe('the quick brown fox');
  });

  it('dedups identical content to one blob', async () => {
    const s = await Space.open(rec());
    const bytes = new TextEncoder().encode('same bytes');
    const a = await s.createFile(ROOT, 'a.txt', bytes, 'text/plain');
    const b = await s.createFile(ROOT, 'b.txt', bytes, 'text/plain');

    const oa = s.state.objects.get(hex(a))!;
    const ob = s.state.objects.get(hex(b))!;
    // Two objects, one content hash (§6: addressed by plaintext hash).
    expect(hex(oa.content!)).toBe(hex(ob.content!));
  });

  it('renames with a single attribute write (§4.2)', async () => {
    const s = await Space.open(rec());
    const id = await s.createFile(ROOT, 'before.txt', new Uint8Array([1]), 'text/plain');
    const before = s.eventCount;
    await s.rename(id, 'after.txt');
    expect(s.eventCount).toBe(before + 1);
    expect(s.state.objects.get(hex(id))!.name).toBe('after.txt');
  });

  it('moves with a single :parent write (§4.1)', async () => {
    const s = await Space.open(rec());
    const d1 = await s.createDir(ROOT, 'one');
    const d2 = await s.createDir(ROOT, 'two');
    const f = await s.createFile(d1, 'f.txt', new Uint8Array([1]), 'text/plain');

    const before = s.eventCount;
    await s.move(f, d2);
    expect(s.eventCount).toBe(before + 1);
    expect(s.path(f)).toBe('/two/f.txt');
  });

  it('derives paths by walking :parent (§4.1)', async () => {
    const s = await Space.open(rec());
    const a = await s.createDir(ROOT, 'a');
    const b = await s.createDir(a, 'b');
    const f = await s.createFile(b, 'deep.txt', new Uint8Array([1]), 'text/plain');
    expect(s.path(f)).toBe('/a/b/deep.txt');
  });

  it('deletes and undeletes (§4.5)', async () => {
    const s = await Space.open(rec());
    const f = await s.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');

    await s.setDeleted(f, true);
    expect(s.state.objects.get(hex(f))!.deleted).toBe(true);
    expect(buildTree(s.state, false)).toHaveLength(0);

    await s.setDeleted(f, false);
    expect(s.state.objects.get(hex(f))!.deleted).toBe(false);
    expect(buildTree(s.state, false)).toHaveLength(1);
  });

  it('undelete-wins: a rename after a delete revives the object (§4.5)', async () => {
    const s = await Space.open(rec());
    const f = await s.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');
    await s.setDeleted(f, true);
    await s.rename(f, 'revived.txt');
    expect(s.state.objects.get(hex(f))!.deleted).toBe(false);
  });

  it('a reader space mints no WriterId and refuses writes (§8.6)', async () => {
    const s = await Space.open(rec('reader'));
    expect(s.writable).toBe(false);
    expect(s.writerId).toBeNull();
    await expect(s.createDir(ROOT, 'nope')).rejects.toThrow(/read-only/);
  });

  it('a resumed writer continues its seq and lamport without reuse (§2.2)', async () => {
    const first = await Space.open(rec());
    await first.createDir(ROOT, 'a');
    const afterFirst = first.writerState!;

    const second = await Space.open(rec());
    expect(second.writerState!.seq).toBe(afterFirst.seq);
    expect(second.writerState!.lamport).toBeGreaterThanOrEqual(afterFirst.lamport);

    // The next event must not collide with anything already in the log.
    await second.createDir(ROOT, 'b');
    expect(second.writerState!.lamport).toBeGreaterThan(afterFirst.lamport);
  });
});
