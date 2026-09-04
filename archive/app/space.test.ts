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

/**
 * Spaces take an origin-wide write lock (I23), and a Space that is dropped
 * without `close()` holds it for the life of the process. Tests open the same
 * id repeatedly, so they release explicitly — a browser tab gets this for free
 * when it closes, but a test runner does not.
 */
const opened: Space[] = [];
async function open(record = rec()): Promise<Space> {
  const s = await Space.open(record);
  opened.push(s);
  return s;
}

beforeEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
  store.clear();
});

describe('Space (stage 2)', () => {
  it('creates a directory and a file inside it', async () => {
    const s = await open();
    const dir = await s.createDir(ROOT, 'docs');
    await s.createFile(dir, 'notes.txt', new TextEncoder().encode('hello'), 'text/plain');

    const tree = buildTree(s.state, false);
    expect(names(tree)).toEqual(['docs']);
    expect(names(tree[0]!.children)).toEqual(['notes.txt']);
  });

  it('round-trips through storage', async () => {
    const first = await open();
    const dir = await first.createDir(ROOT, 'docs');
    await first.createFile(dir, 'a.txt', new TextEncoder().encode('content'), 'text/plain');

    // A fresh Space over the same id must fold to the same tree.
    const second = await open();
    expect(names(buildTree(second.state, false))).toEqual(['docs']);
    expect(second.eventCount).toBe(first.eventCount);
  });

  it('stores blob bytes retrievably, addressed by content hash', async () => {
    const s = await open();
    const bytes = new TextEncoder().encode('the quick brown fox');
    const id = await s.createFile(ROOT, 'fox.txt', bytes, 'text/plain');

    const obj = s.state.objects.get(hex(id))!;
    expect(obj.content).not.toBeNull();
    const got = await s.content(obj.content!);
    expect(new TextDecoder().decode(got!)).toBe('the quick brown fox');
  });

  it('dedups identical content to one blob', async () => {
    const s = await open();
    const bytes = new TextEncoder().encode('same bytes');
    const a = await s.createFile(ROOT, 'a.txt', bytes, 'text/plain');
    const b = await s.createFile(ROOT, 'b.txt', bytes, 'text/plain');

    const oa = s.state.objects.get(hex(a))!;
    const ob = s.state.objects.get(hex(b))!;
    // Two objects, one content hash (§6: addressed by plaintext hash).
    expect(hex(oa.content!)).toBe(hex(ob.content!));
  });

  it('renames with a single attribute write (§4.2)', async () => {
    const s = await open();
    const id = await s.createFile(ROOT, 'before.txt', new Uint8Array([1]), 'text/plain');
    const before = s.eventCount;
    await s.rename(id, 'after.txt');
    expect(s.eventCount).toBe(before + 1);
    expect(s.state.objects.get(hex(id))!.name).toBe('after.txt');
  });

  it('moves with a single :parent write (§4.1)', async () => {
    const s = await open();
    const d1 = await s.createDir(ROOT, 'one');
    const d2 = await s.createDir(ROOT, 'two');
    const f = await s.createFile(d1, 'f.txt', new Uint8Array([1]), 'text/plain');

    const before = s.eventCount;
    await s.move(f, d2);
    expect(s.eventCount).toBe(before + 1);
    expect(s.path(f)).toBe('/two/f.txt');
  });

  it('derives paths by walking :parent (§4.1)', async () => {
    const s = await open();
    const a = await s.createDir(ROOT, 'a');
    const b = await s.createDir(a, 'b');
    const f = await s.createFile(b, 'deep.txt', new Uint8Array([1]), 'text/plain');
    expect(s.path(f)).toBe('/a/b/deep.txt');
  });

  it('deletes and undeletes (§4.5)', async () => {
    const s = await open();
    const f = await s.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');

    await s.setDeleted(f, true);
    expect(s.state.objects.get(hex(f))!.deleted).toBe(true);
    expect(buildTree(s.state, false)).toHaveLength(0);

    await s.setDeleted(f, false);
    expect(s.state.objects.get(hex(f))!.deleted).toBe(false);
    expect(buildTree(s.state, false)).toHaveLength(1);
  });

  it('undelete-wins: a rename after a delete revives the object (§4.5)', async () => {
    const s = await open();
    const f = await s.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');
    await s.setDeleted(f, true);
    await s.rename(f, 'revived.txt');
    expect(s.state.objects.get(hex(f))!.deleted).toBe(false);
  });

  it('a reader space mints no WriterId and refuses writes (§8.6)', async () => {
    const s = await open(rec('reader'));
    expect(s.writable).toBe(false);
    expect(s.writerId).toBeNull();
    await expect(s.createDir(ROOT, 'nope')).rejects.toThrow(/read-only/);
  });

  it('a resumed writer continues its seq and lamport without reuse (§2.2)', async () => {
    const first = await open();
    await first.createDir(ROOT, 'a');
    const afterFirst = first.writerState!;

    // Close before reopening. Two *live* Spaces on one id is exactly the fork
    // I23 describes, and the write lock now prevents it — so this test models
    // reopening a space, which is what it was always about.
    await first.close();
    const second = await open();
    expect(second.writerState!.seq).toBe(afterFirst.seq);
    expect(second.writerState!.lamport).toBeGreaterThanOrEqual(afterFirst.lamport);

    // The next event must not collide with anything already in the log.
    await second.createDir(ROOT, 'b');
    expect(second.writerState!.lamport).toBeGreaterThan(afterFirst.lamport);
  });
});

describe('one writer per space, per origin (I23)', () => {
  it('a second Space on the same id opens read-only', async () => {
    const first = await open();
    expect(first.writable).toBe(true);

    // What two tabs on one origin do. Without the lock both would resume at the
    // same seq and emit different events there, forking the chain.
    const second = await open();
    expect(second.writable).toBe(false);
    expect(second.readOnlyReason).toBe('locked-by-other-tab');
  });

  it('the read-only one refuses writes rather than forking', async () => {
    const first = await open();
    await first.createDir(ROOT, 'a');
    const second = await open();

    await expect(second.createDir(ROOT, 'b')).rejects.toThrow();
    // And nothing was appended behind the refusal.
    expect(second.eventCount).toBe(first.eventCount);
  });

  it('the holder keeps writing normally', async () => {
    const first = await open();
    await open(); // a second tab arrives and is refused
    await expect(first.createDir(ROOT, 'still works')).resolves.toBeDefined();
  });

  it('closing the holder lets the next one write', async () => {
    const first = await open();
    await first.close();
    const second = await open();
    expect(second.writable).toBe(true);
    expect(second.readOnlyReason).toBeNull();
  });

  it('a reader takes no lock, since it never writes', async () => {
    // Two reader tabs on one space are fine: neither can append, so neither can
    // fork anything.
    const a = await open(rec('reader'));
    const b = await open(rec('reader'));
    expect(a.writable).toBe(false);
    expect(b.writable).toBe(false);
    expect(a.readOnlyReason).toBeNull();
    expect(b.readOnlyReason).toBeNull();
  });
});
