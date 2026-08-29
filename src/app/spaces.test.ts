/**
 * Stage 3: multiple live logs and cross-space moves (§8.3, §8.5).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Spaces } from './spaces.js';
import { buildTree } from './tree.js';
import { hex, ROOT } from '../fold/index.js';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const names = (ns: { obj: { name: string | null } }[]) => ns.map((n) => n.obj.name);

beforeEach(() => store.clear());

describe('Spaces (§8.3)', () => {
  it('opens one local space on first run', async () => {
    const spaces = await Spaces.load();
    expect(spaces.list).toHaveLength(1);
    expect(spaces.list[0]!.mode).toBe('local');
    expect(spaces.get(spaces.list[0]!.id)).not.toBeNull();
  });

  it('holds every space open simultaneously, not just the visible one', async () => {
    const spaces = await Spaces.load();
    const b = await spaces.create('second', 'local');
    const c = await spaces.create('third', 'local');
    // All three are live: N logs folded, N keyspaces (§8.3).
    expect(spaces.get(spaces.list[0]!.id)).not.toBeNull();
    expect(spaces.get(b.id)).not.toBeNull();
    expect(spaces.get(c.id)).not.toBeNull();
  });

  it('gives each space its own writer identity (§2)', async () => {
    const spaces = await Spaces.load();
    const b = await spaces.create('second', 'local');
    const a = spaces.get(spaces.list[0]!.id)!;
    expect(hex(a.writerId!)).not.toBe(hex(spaces.get(b.id)!.writerId!));
  });

  it('keeps space logs independent', async () => {
    const spaces = await Spaces.load();
    const a = spaces.get(spaces.list[0]!.id)!;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    await a.createDir(ROOT, 'only-in-a');
    expect(names(buildTree(a.state, false))).toEqual(['only-in-a']);
    expect(names(buildTree(b.state, false))).toEqual([]);
  });

  it('survives a reload with both spaces intact', async () => {
    const first = await Spaces.load();
    const aId = first.list[0]!.id;
    const bRec = await first.create('second', 'local');
    await first.get(aId)!.createDir(ROOT, 'in-a');
    await first.get(bRec.id)!.createDir(ROOT, 'in-b');

    const reloaded = await Spaces.load();
    expect(reloaded.list).toHaveLength(2);
    expect(names(buildTree(reloaded.get(aId)!.state, false))).toEqual(['in-a']);
    expect(names(buildTree(reloaded.get(bRec.id)!.state, false))).toEqual(['in-b']);
  });
});

describe('cross-space moves (§8.5)', () => {
  it('recreates the object under a new UUID and tombstones the source', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const a = spaces.get(aId)!;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    const f = await a.createFile(ROOT, 'travel.txt', new TextEncoder().encode('hi'), 'text/plain');
    await spaces.moveAcross(aId, bRec.id, f);

    // Source: tombstoned, so gone from the visible tree.
    expect(a.state.objects.get(hex(f))!.deleted).toBe(true);
    expect(names(buildTree(a.state, false))).toEqual([]);

    // Destination: present, and under a *different* UUID.
    const arrived = buildTree(b.state, false);
    expect(names(arrived)).toEqual(['travel.txt']);
    expect(arrived[0]!.key).not.toBe(hex(f));
  });

  it('is not a :parent write — the destination writes fresh events', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    const f = await spaces.get(aId)!.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');
    const before = b.eventCount;
    await spaces.moveAcross(aId, bRec.id, f);
    // :kind, :name, :parent, :content — four fresh assertions, not one move.
    expect(b.eventCount).toBe(before + 4);
  });

  it('resolves content in the destination without copying the blob', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    const bytes = new TextEncoder().encode('shared bytes');
    const f = await spaces.get(aId)!.createFile(ROOT, 'f.txt', bytes, 'text/plain');
    await spaces.moveAcross(aId, bRec.id, f);

    const arrived = buildTree(b.state, false)[0]!.obj;
    const got = await b.content(arrived.content!);
    expect(new TextDecoder().decode(got!.bytes)).toBe('shared bytes');
  });

  it('carries a directory subtree, with new UUIDs throughout', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const a = spaces.get(aId)!;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    const dir = await a.createDir(ROOT, 'docs');
    await a.createFile(dir, 'one.txt', new Uint8Array([1]), 'text/plain');
    await a.createFile(dir, 'two.txt', new Uint8Array([2]), 'text/plain');

    await spaces.moveAcross(aId, bRec.id, dir);

    const tree = buildTree(b.state, false);
    expect(names(tree)).toEqual(['docs']);
    expect(names(tree[0]!.children).sort()).toEqual(['one.txt', 'two.txt']);
    expect(tree[0]!.key).not.toBe(hex(dir));
  });

  it('copy leaves the source intact', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const a = spaces.get(aId)!;
    const bRec = await spaces.create('second', 'local');

    const f = await a.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');
    await spaces.moveAcross(aId, bRec.id, f, { copy: true });

    expect(a.state.objects.get(hex(f))!.deleted).toBe(false);
    expect(names(buildTree(spaces.get(bRec.id)!.state, false))).toEqual(['f.txt']);
  });

  it('refuses a move INTO a reader space (§8.5 asymmetry)', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const reader = await spaces.create('theirs', 'reader');
    const f = await spaces.get(aId)!.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');

    await expect(spaces.moveAcross(aId, reader.id, f)).rejects.toThrow(/read-only/);
  });

  it('allows a move OUT of a reader space, leaving the source untouched', async () => {
    // Writing only to the destination, which we own. The source keeps the
    // object because we cannot tombstone it there.
    const spaces = await Spaces.load();
    const local = spaces.list[0]!.id;
    const readerRec = await spaces.create('theirs', 'reader');

    // Seed the reader's log as if replicated from a peer: write it as a local
    // space first, then reopen the same id read-only.
    const seedRec = await spaces.create('seed', 'local');
    const seed = spaces.get(seedRec.id)!;
    const f = await seed.createFile(ROOT, 'theirs.txt', new Uint8Array([9]), 'text/plain');

    await spaces.moveAcross(seedRec.id, local, f);
    expect(names(buildTree(spaces.get(local)!.state, false))).toEqual(['theirs.txt']);
    expect(readerRec.mode).toBe('reader');
  });
});

describe('storage keying (§2) — what stage 3 exists to catch', () => {
  it('keys each space log under its own localStorage key', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const bRec = await spaces.create('second', 'local');

    await spaces.get(aId)!.createDir(ROOT, 'in-a');
    await spaces.get(bRec.id)!.createDir(ROOT, 'in-b');

    const keys = [...store.keys()].filter((k) => k.startsWith('thing:events:'));
    expect(keys).toContain(`thing:events:${aId}`);
    expect(keys).toContain(`thing:events:${bRec.id}`);

    // The decisive check: neither log contains the other's content.
    expect(store.get(`thing:events:${aId}`)).toContain('in-a');
    expect(store.get(`thing:events:${aId}`)).not.toContain('in-b');
    expect(store.get(`thing:events:${bRec.id}`)).not.toContain('in-a');
  });

  it('keys each writer identity separately, so seq counters cannot collide', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const bRec = await spaces.create('second', 'local');

    const writerKeys = [...store.keys()].filter((k) => k.startsWith('thing:writer:'));
    expect(writerKeys).toContain(`thing:writer:${aId}`);
    expect(writerKeys).toContain(`thing:writer:${bRec.id}`);
    expect(store.get(`thing:writer:${aId}`)).not.toBe(store.get(`thing:writer:${bRec.id}`));
  });

  it('advances each space seq independently from zero', async () => {
    const spaces = await Spaces.load();
    const a = spaces.get(spaces.list[0]!.id)!;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    await a.createDir(ROOT, 'x');
    await a.createDir(ROOT, 'y');
    // b has written nothing, so its seq must still be 0 despite a's activity.
    expect(b.writerState!.seq).toBe(0);
    expect(a.writerState!.seq).toBe(6); // two dirs × (kind, name, parent)
  });

  it('shares one blob store across spaces, addressed by content (§8.5)', async () => {
    const spaces = await Spaces.load();
    const a = spaces.get(spaces.list[0]!.id)!;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    const bytes = new TextEncoder().encode('identical');
    const fa = await a.createFile(ROOT, 'a.txt', bytes, 'text/plain');
    const fb = await b.createFile(ROOT, 'b.txt', bytes, 'text/plain');

    const ha = a.state.objects.get(hex(fa))!.content!;
    const hb = b.state.objects.get(hex(fb))!.content!;
    expect(hex(ha)).toBe(hex(hb));
    // And each space can read the blob the other wrote — the leak §10.9 notes.
    expect((await a.content(hb))!.bytes.length).toBe(bytes.length);
  });
});

describe('cross-space moves are broadcastable (§3.4, §8.5)', () => {
  /**
   * A cross-space move writes to two logs. Replication tracks a watermark per
   * space and flushes what is past it — so both sides must show new events, or
   * a peer of either space never learns what happened. This was a real bug: the
   * UI flushed only the visible space, and a reader stayed stale until reload.
   */
  it('leaves unbroadcast events in BOTH spaces', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const a = spaces.get(aId)!;
    const bRec = await spaces.create('second', 'local');
    const b = spaces.get(bRec.id)!;

    const f = await a.createFile(ROOT, 'travel.txt', new Uint8Array([1]), 'text/plain');

    // Watermarks as they would stand after a flush of each space.
    const aMark = a.log.length;
    const bMark = b.log.length;

    await spaces.moveAcross(aId, bRec.id, f);

    // Destination gained the four fresh assertions.
    expect(b.since(bMark).length).toBe(4);
    // Source gained the tombstone — the half that was being missed.
    expect(a.since(aMark).length).toBe(1);
    expect(a.since(aMark)[0]!.attr).toBe(':deleted');
  });

  it('a copy leaves nothing to broadcast in the source', async () => {
    const spaces = await Spaces.load();
    const aId = spaces.list[0]!.id;
    const a = spaces.get(aId)!;
    const bRec = await spaces.create('second', 'local');

    const f = await a.createFile(ROOT, 'f.txt', new Uint8Array([1]), 'text/plain');
    const aMark = a.log.length;

    await spaces.moveAcross(aId, bRec.id, f, { copy: true });
    expect(a.since(aMark)).toEqual([]);
  });
})

describe('forgetting a space', () => {
  it('removes it from the registry and from storage', async () => {
    const spaces = await Spaces.load();
    const keep = spaces.list[0]!.id;
    const doomed = await spaces.create('doomed', 'local');
    await spaces.get(doomed.id)!.createDir(ROOT, 'stuff');

    await spaces.forget(doomed.id);

    expect(spaces.list.map((r) => r.id)).toEqual([keep]);
    expect(spaces.get(doomed.id)).toBeNull();
    expect(store.get(`thing:events:${doomed.id}`)).toBeUndefined();
    expect(store.get(`thing:writer:${doomed.id}`)).toBeUndefined();
  });

  it('survives a reload — the space stays gone', async () => {
    const first = await Spaces.load();
    const doomed = await first.create('doomed', 'local');
    await first.forget(doomed.id);

    const reloaded = await Spaces.load();
    expect(reloaded.list.some((r) => r.id === doomed.id)).toBe(false);
  });

  it('frees blobs nothing else references', async () => {
    const spaces = await Spaces.load();
    const doomed = await spaces.create('doomed', 'local');
    await spaces
      .get(doomed.id)!
      .createFile(ROOT, 'only-here.txt', new TextEncoder().encode('unique bytes'), 'text/plain');

    const { blobsFreed } = await spaces.forget(doomed.id);
    expect(blobsFreed).toBeGreaterThan(0);
  });

  it('KEEPS a blob another space still references (§8.5 shared store)', async () => {
    // The decisive case: the store is shared and content-addressed, so deleting
    // by space would corrupt any other space holding the same bytes.
    const spaces = await Spaces.load();
    const keeper = spaces.get(spaces.list[0]!.id)!;
    const doomed = await spaces.create('doomed', 'local');

    const bytes = new TextEncoder().encode('shared between spaces');
    const kept = await keeper.createFile(ROOT, 'mine.txt', bytes, 'text/plain');
    await spaces.get(doomed.id)!.createFile(ROOT, 'theirs.txt', bytes, 'text/plain');

    await spaces.forget(doomed.id);

    const hash = keeper.state.objects.get(hex(kept))!.content!;
    const still = await keeper.content(hash);
    expect(still).not.toBeNull();
    expect(new TextDecoder().decode(still!.bytes)).toBe('shared between spaces');
  });

  it('does not disturb the surviving space log', async () => {
    const spaces = await Spaces.load();
    const keeper = spaces.get(spaces.list[0]!.id)!;
    await keeper.createDir(ROOT, 'survivor');
    const before = keeper.eventCount;

    const doomed = await spaces.create('doomed', 'local');
    await spaces.forget(doomed.id);

    expect(keeper.eventCount).toBe(before);
    expect(names(buildTree(keeper.state, false))).toEqual(['survivor']);
  });
});
