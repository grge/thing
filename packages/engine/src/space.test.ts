/**
 * A space: log, fold and write path held together.
 *
 * The property stage 4 exists to establish: **write a filesystem into a space,
 * reopen it, and get identical state.** The fold is not persisted, so reopening
 * replays the log — and if the incremental and full folds ever disagreed, this
 * is where it would show.
 */
import { chainOf, type Event, generateKeyPair, hex, type KeyPair, keyPairFromSeed, ROOT, SEED_LEN } from './core/index.js';
import { MemoryStore, type Store } from './store/index.js';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  entry,
  list,
  makeFile,
  makeFolder,
  move,
  read,
  remove,
  rename,
  restore,
} from './fs/files.js';
import { Space } from './space.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

/** A space over a fresh memory store, with a deterministic clock. */
async function openSpace(
  store: Store,
  key: KeyPair,
  writer: KeyPair = key,
): Promise<Space> {
  let tick = 0;
  const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
  return Space.open(spaceStore, {
    key: key.publicKey,
    writer,
    now: () => (tick += 1),
  });
}

async function spaceKey(): Promise<KeyPair> {
  return keyPairFromSeed(labelled('space', SEED_LEN));
}

describe('a space', () => {
  it('writes and folds', async () => {
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);

    const docs = await makeFolder(space, 'docs');
    await makeFile(space, 'readme.md', UTF8.encode('# hello'), {
      parent: docs,
      kind: 'text/markdown',
    });

    const top = list(space.state);
    expect(top.map((e) => e.name)).toEqual(['docs']);
    expect(top[0]!.isFolder).toBe(true);

    const inside = list(space.state, docs);
    expect(inside.map((e) => e.name)).toEqual(['readme.md']);
    expect(inside[0]!.kind).toBe('text/markdown');
    expect(inside[0]!.isFolder).toBe(false);
  });

  it('reads a file back through the blob store', async () => {
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);
    const { id } = await makeFile(space, 'a.txt', UTF8.encode('contents'));
    expect(hex((await read(space, id))!)).toBe(hex(UTF8.encode('contents')));
  });

  it('renames, moves, deletes and restores', async () => {
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);

    const a = await makeFolder(space, 'a');
    const b = await makeFolder(space, 'b');
    const { id } = await makeFile(space, 'note.txt', UTF8.encode('x'), { parent: a });

    await rename(space, id, 'renamed.txt');
    expect(entry(space.state, id)!.name).toBe('renamed.txt');

    await move(space, id, b);
    expect(list(space.state, a)).toHaveLength(0);
    expect(list(space.state, b).map((e) => e.name)).toEqual(['renamed.txt']);

    await remove(space, id);
    expect(list(space.state, b)).toHaveLength(0);
    // A tombstone, not a removal: the object is still there (§2.1).
    expect(list(space.state, b, { includeDeleted: true })).toHaveLength(1);
    expect(entry(space.state, id)!.deleted).toBe(true);

    await restore(space, id);
    expect(entry(space.state, id)!.deleted).toBe(false);
  });

  it('notifies listeners on change', async () => {
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);

    let calls = 0;
    const off = space.onChange(() => (calls += 1));
    await makeFolder(space, 'watched');
    expect(calls).toBeGreaterThan(0);

    off();
    const before = calls;
    await makeFolder(space, 'unwatched');
    expect(calls).toBe(before);
  });

  it('refuses to write without a key', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    const replica = await Space.open(spaceStore, { key: key.publicKey });

    expect(replica.writable).toBe(false);
    await expect(replica.write(ROOT, ':name', UTF8.encode('x'))).rejects.toThrow(/not writable/);
  });

  it('a local write takes the same path as a remote one', async () => {
    // Including verification: a writer that produced an invalid event should
    // find out here rather than when a peer rejects it.
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);
    const e = await space.write(ROOT, ':name', UTF8.encode('named'));

    // The event is in the log, not only in the fold.
    const vv = await space.versionVector();
    expect(vv.get(chainOf(e))?.frontier).toBe(e.seq);
  });

  it('rejects a tampered event from a peer', async () => {
    // Tampering with the value alone, so the chain still lines up and the
    // signature is the only thing that can catch it.
    const key = await spaceKey();
    const store = new MemoryStore();
    const space = await openSpace(store, key);

    const donor = await openSpace(new MemoryStore(), key);
    const next = await donor.write(ROOT, ':name', UTF8.encode('real'));
    const forged = { ...next, value: UTF8.encode('forged') };

    const result = await space.receive([forged]);
    expect(result.appended).toHaveLength(0);
    expect(result.rejected[0]?.why.kind).toBe('unverified');
  });

  it('rejects an event whose chain does not line up', async () => {
    // Checked before the signature, because it is cheaper — a duplicate or a
    // graft should not pay for verification.
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);
    const good = await space.write(ROOT, ':name', UTF8.encode('real'));

    const grafted = { ...good, seq: good.seq + 5 };
    const result = await space.receive([grafted]);
    expect(result.rejected[0]?.why.kind).toBe('gap');
  });
});

describe('reopening', () => {
  it('gets identical state from the log', async () => {
    // The stage-4 property. The fold is not persisted, so this is a full
    // replay — and it must agree with the incremental fold that built the
    // original.
    const key = await spaceKey();
    const store = new MemoryStore();

    const first = await openSpace(store, key);
    const docs = await makeFolder(first, 'docs');
    const sub = await makeFolder(first, 'nested', docs);
    const { id } = await makeFile(first, 'readme.md', UTF8.encode('# hello'), {
      parent: sub,
      kind: 'text/markdown',
    });
    await makeFile(first, 'deleted.txt', UTF8.encode('gone'), { parent: docs });
    const [, second] = list(first.state, docs, { includeDeleted: true });
    await remove(first, second!.id);

    const before = summarise(first);
    await first.close();

    const again = await openSpace(store, key);
    expect(summarise(again)).toBe(before);
    expect(hex((await read(again, id))!)).toBe(hex(UTF8.encode('# hello')));
  });

  it('reopening starts a new chain, and both fold together', async () => {
    // This used to assert the opposite — that a reopen *continued* the chain,
    // because starting a second one at seq 0 would have been a fork of this
    // writer's own history. With append points it is not: the two chains are
    // separate positions under one identity, and nothing has to guess whether
    // the previous process is still running (§2.1's `Point`).
    const key = await spaceKey();
    const store = new MemoryStore();

    const first = await openSpace(store, key);
    await makeFolder(first, 'a');
    const before = await first.versionVector();
    await first.close();

    const again = await openSpace(store, key);
    await makeFolder(again, 'b');
    const after = await again.versionVector();

    // A second chain, not a longer one.
    expect(after.size).toBe(before.size + 1);
    for (const [chain, f] of before) {
      // The first chain is untouched: same frontier, same tip, no fork.
      expect(after.get(chain)).toEqual(f);
    }

    // And what matters to a person: both writes are there, in order.
    expect(list(again.state).map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('two processes with one key write concurrently and both survive', async () => {
    // The guarantee stage 7.6 exists for. Before append points these two would
    // both have written seq 0 with the same prev, producing two validly signed
    // events at one position — a fork §7.3 resolves by *dropping one branch*.
    // Now they are separate chains and both writes are simply kept.
    const key = await spaceKey();
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();

    const a = await openSpace(storeA, key);
    const b = await openSpace(storeB, key);
    await makeFolder(a, 'from-a');
    await makeFolder(b, 'from-b');

    // Exchange logs, as syncing would.
    const eventsOfA: Event[] = [];
    for await (const e of (await storeA.open(hex(key.publicKey), key.publicKey)).readAll()) {
      eventsOfA.push(e);
    }
    const eventsOfB: Event[] = [];
    for await (const e of (await storeB.open(hex(key.publicKey), key.publicKey)).readAll()) {
      eventsOfB.push(e);
    }

    const intoB = await b.receive(eventsOfA);
    const intoA = await a.receive(eventsOfB);

    // Nothing refused: no duplicate seq, no fork, no rejection at all.
    expect(intoB.rejected).toEqual([]);
    expect(intoA.rejected).toEqual([]);

    // And both converge on both writes.
    expect(list(a.state).map((e) => e.name).sort()).toEqual(['from-a', 'from-b']);
    expect(list(b.state).map((e) => e.name).sort()).toEqual(['from-a', 'from-b']);
  });

  it('a read-only replica sees what a writer wrote', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();

    const writerSpace = await openSpace(store, key);
    await makeFolder(writerSpace, 'shared');
    await writerSpace.close();

    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    const replica = await Space.open(spaceStore, { key: key.publicKey });
    expect(list(replica.state).map((e) => e.name)).toEqual(['shared']);
  });
});

describe('multi-writer', () => {
  it('two writers converge on one space', async () => {
    const key = await spaceKey();
    const other = await generateKeyPair();

    // Each holds its own store, as two peers would.
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();

    const a = await openSpace(storeA, key, key);
    // The space key admits the second writer (§7.2.1).
    await a.write(ROOT, ':writers', UTF8.encode(`${hex(key.publicKey)},${hex(other.publicKey)}`));
    await makeFolder(a, 'from-a');

    const bStore = await storeB.open(hex(key.publicKey), key.publicKey);
    const b = await Space.open(bStore, { key: key.publicKey, writer: other, now: () => 100 });

    // Ship a's events to b, then b writes and ships back.
    const fromA: Awaited<ReturnType<Space['write']>>[] = [];
    for await (const e of (await storeA.open(hex(key.publicKey), key.publicKey)).readAll()) {
      fromA.push(e);
    }
    await b.receive(fromA);
    await makeFolder(b, 'from-b');

    const fromB: Awaited<ReturnType<Space['write']>>[] = [];
    for await (const e of bStore.readAll()) fromB.push(e);
    await a.receive(fromB);

    expect(list(a.state).map((e) => e.name)).toEqual(['from-a', 'from-b']);
    expect(list(b.state).map((e) => e.name)).toEqual(['from-a', 'from-b']);
    expect(summarise(a)).toBe(summarise(b));
  });
});

/** A comparable rendering of a space's visible state. */
function summarise(space: Space): string {
  const lines: string[] = [];
  const walk = (parent: Uint8Array, depth: number): void => {
    for (const e of list(space.state, parent, { includeDeleted: true })) {
      const hash = contentHash(space.state, e.id);
      lines.push(
        `${'  '.repeat(depth)}${e.name} kind=${e.kind ?? '-'} del=${e.deleted}` +
          ` body=${hash === null ? '-' : hex(hash).slice(0, 8)}`,
      );
      walk(e.id, depth + 1);
    }
  };
  walk(ROOT, 0);
  return lines.join('\n');
}
