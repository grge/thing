/**
 * Stage 4's headline property, on disk.
 *
 * A Node process creates a space, writes a filesystem into it, and reopens it
 * from a *new* store over the same directory — nothing shared but the bytes.
 * The fold is not persisted, so this is a full replay of the log through a
 * fresh `Folder`, and it must agree with the incremental fold that built the
 * original.
 */
import { contentHash, hex, keyPairFromSeed, list, makeFile, makeFolder, read, remove, rename, ROOT, SEED_LEN, Space, type VersionVector } from '@thing/engine';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from './filestore.js';

const UTF8 = new TextEncoder();
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thing-e2e-'));
  dirs.push(dir);
  return dir;
}

async function keys() {
  const seed = new Uint8Array(SEED_LEN);
  seed.set(UTF8.encode('e2e-space'));
  return keyPairFromSeed(seed);
}

async function openAt(dir: string, key: Awaited<ReturnType<typeof keys>>) {
  const store = new FileStore(dir);
  let tick = 0;
  const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
  const space = await Space.open(spaceStore, {
    key: key.publicKey,
    writer: key,
    now: () => (tick += 1),
  });
  return { store, space };
}

/** A comparable rendering of the whole tree. */
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

describe('a space on disk', () => {
  it('survives a full restart with identical state', async () => {
    const dir = await tempDir();
    const key = await keys();

    const first = await openAt(dir, key);
    const docs = await makeFolder(first.space, 'docs');
    const nested = await makeFolder(first.space, 'nested', docs);
    const { id: readme } = await makeFile(
      first.space,
      'readme.md',
      UTF8.encode('# a real file\n'),
      { parent: nested, kind: 'text/markdown' },
    );
    const { id: gone } = await makeFile(first.space, 'old.txt', UTF8.encode('bye'), {
      parent: docs,
    });
    await remove(first.space, gone);
    await rename(first.space, docs, 'documents');

    const before = summarise(first.space);
    // Total across every chain, not one chain's frontier: a restart opens a new
    // append point (§2.1), so "how much is in the log" is the sum rather than
    // the length of any one chain.
    const held = (vv: VersionVector): number => {
      let n = 0;
      for (const f of vv.values()) n += f.frontier + 1;
      return n;
    };
    const eventCount = held(await first.space.versionVector());
    await first.space.close();
    await first.store.close();

    // A new process would look exactly like this: a new store over the same
    // directory, with nothing carried over in memory.
    const second = await openAt(dir, key);
    expect(summarise(second.space)).toBe(before);
    expect(hex((await read(second.space, readme))!)).toBe(hex(UTF8.encode('# a real file\n')));
    expect(held(await second.space.versionVector())).toBe(eventCount);

    // And it is still writable — on a new chain, which folds together with the
    // old one into the same tree.
    await makeFolder(second.space, 'added-later');
    expect(list(second.space.state).map((e) => e.name).sort()).toEqual([
      'added-later',
      'documents',
    ]);
    await second.space.close();
    await second.store.close();
  });

  it('a deep tree round-trips', async () => {
    const dir = await tempDir();
    const key = await keys();

    const first = await openAt(dir, key);
    let parent = ROOT;
    for (let depth = 0; depth < 8; depth++) {
      parent = await makeFolder(first.space, `level-${depth}`, parent);
      await makeFile(first.space, `file-${depth}.txt`, UTF8.encode(`contents ${depth}`), {
        parent,
        kind: 'text/plain',
      });
    }
    const before = summarise(first.space);
    await first.space.close();
    await first.store.close();

    const second = await openAt(dir, key);
    expect(summarise(second.space)).toBe(before);
    await second.space.close();
    await second.store.close();
  });

  it('blobs survive the restart too', async () => {
    const dir = await tempDir();
    const key = await keys();

    const big = new Uint8Array(1 << 16);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff;

    const first = await openAt(dir, key);
    const { id } = await makeFile(first.space, 'big.bin', big);
    await first.space.close();
    await first.store.close();

    const second = await openAt(dir, key);
    const back = (await read(second.space, id))!;
    expect(back).toHaveLength(big.length);
    expect(hex(back.subarray(0, 32))).toBe(hex(big.subarray(0, 32)));
    await second.space.close();
    await second.store.close();
  });
});
