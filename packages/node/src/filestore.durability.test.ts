/**
 * On-disk durability, which the shared conformance suite cannot express.
 *
 * The suite's durability tests close and reopen a space through the same
 * `Store` instance, which a purely in-memory backend passes trivially. These
 * open a *new* `FileStore` over the same directory, so nothing carries over in
 * process — the only thing that can make them pass is bytes on disk.
 */
import { hex, keyPairFromSeed, ROOT, SEED_LEN, Writer } from '@thing/core';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(join(tmpdir(), 'thing-durable-'));
  dirs.push(dir);
  return dir;
}

async function fixture() {
  const key = await keyPairFromSeed(
    (() => {
      const s = new Uint8Array(SEED_LEN);
      s.set(UTF8.encode('space'));
      return s;
    })(),
  );
  return { key, space: hex(key.publicKey), writer: new Writer(key.publicKey, key) };
}

describe('files: on disk', () => {
  it('a new store over the same directory sees the log', async () => {
    const dir = await tempDir();
    const { key, space, writer } = await fixture();

    const first = new FileStore(dir);
    const s = await first.open(space, key.publicKey);
    for (let i = 0; i < 5; i++) {
      await s.append([await writer.write(ROOT, ':name', UTF8.encode(`v${i}`), i)]);
    }
    const hash = await s.putBlob(UTF8.encode('bytes on disk'));
    await first.close();

    // A different instance: nothing is shared but the directory.
    const second = new FileStore(dir);
    const again = await second.open(space, key.publicKey);
    expect(await again.count()).toBe(5);
    expect(hex((await again.getBlob(hash))!)).toBe(hex(UTF8.encode('bytes on disk')));
    expect((await again.versionVector()).get(hex(key.publicKey))?.frontier).toBe(4);
    await second.close();
  });

  it('appends rather than rewriting', async () => {
    // The property that makes a write O(1) rather than O(log length). The
    // previous implementation of this system re-serialised its whole log on
    // every write, which put a hard ceiling on a space's lifetime.
    const dir = await tempDir();
    const { key, space, writer } = await fixture();
    const store = new FileStore(dir);
    const s = await store.open(space, key.publicKey);

    await s.append([await writer.write(ROOT, ':name', UTF8.encode('one'), 0)]);
    const afterFirst = await readFile(join(dir, space, 'log'));

    await s.append([await writer.write(ROOT, ':name', UTF8.encode('two'), 1)]);
    const afterSecond = await readFile(join(dir, space, 'log'));

    // The first write's bytes are still there, unchanged, at the front.
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    expect(hex(new Uint8Array(afterSecond.subarray(0, afterFirst.length)))).toBe(
      hex(new Uint8Array(afterFirst)),
    );
    await store.close();
  });

  it('a truncated tail ends the log rather than corrupting it', async () => {
    // A write interrupted by a crash leaves a partial frame. The events before
    // it are intact and are what the log holds; the partial one is not read.
    const dir = await tempDir();
    const { key, space, writer } = await fixture();

    const first = new FileStore(dir);
    const s = await first.open(space, key.publicKey);
    await s.append([await writer.write(ROOT, ':name', UTF8.encode('kept'), 0)]);
    await s.append([await writer.write(ROOT, ':name', UTF8.encode('kept too'), 1)]);
    await first.close();

    const path = join(dir, space, 'log');
    const whole = await readFile(path);
    // Cut mid-frame: a length prefix promising more than follows.
    await writeFile(path, whole.subarray(0, whole.length - 10));

    const second = new FileStore(dir);
    const again = await second.open(space, key.publicKey);
    expect(await again.count()).toBe(1);
    // And the store is still usable: the surviving chain accepts what follows.
    expect((await again.versionVector()).get(hex(key.publicKey))?.frontier).toBe(0);
    await second.close();
  });

  it('trailing garbage does not prevent opening', async () => {
    const dir = await tempDir();
    const { key, space, writer } = await fixture();

    const first = new FileStore(dir);
    const s = await first.open(space, key.publicKey);
    await s.append([await writer.write(ROOT, ':name', UTF8.encode('real'), 0)]);
    await first.close();

    await appendFile(join(dir, space, 'log'), Buffer.from([0xff, 0xff, 0xff]));

    const second = new FileStore(dir);
    const again = await second.open(space, key.publicKey);
    expect(await again.count()).toBe(1);
    await second.close();
  });

  it('destroy removes the directory', async () => {
    const dir = await tempDir();
    const { key, space, writer } = await fixture();
    const store = new FileStore(dir);
    const s = await store.open(space, key.publicKey);
    await s.append([await writer.write(ROOT, ':name', UTF8.encode('x'), 0)]);

    await store.destroy(space);
    expect(await store.list()).not.toContain(space);

    const fresh = new FileStore(dir);
    const reopened = await fresh.open(space, key.publicKey);
    expect(await reopened.count()).toBe(0);
    await fresh.close();
    await store.close();
  });
});
