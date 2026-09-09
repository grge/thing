/**
 * The Node backend against the shared conformance suite.
 *
 * The suite is the same one the memory backend runs (`@thing/engine`), which is
 * the point: a browser and a headless peer must behave identically, and the
 * only way to be sure is one set of expectations rather than two that look
 * similar.
 */
import { describe, expect, it } from 'vitest';
import {
  chainOf,
  conformanceTests,
  type Event,
  hex,
  keyPairFromSeed,
  ROOT,
  SEED_LEN,
  type Store,
  Writer,
} from '@thing/engine';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './filestore.js';

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

const dirs: string[] = [];

conformanceTests(
  'files',
  async (): Promise<Store> => {
    const dir = await mkdtemp(join(tmpdir(), 'thing-store-'));
    dirs.push(dir);
    return new FileStore(dir);
  },
  async () => {
    // Each store gets its own temp directory; clear them as they are finished
    // with, so a failing run does not leave the tmpdir full.
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  },
);

describe('a log that holds an event more than once', () => {
  // **`append` deduplicates, so this cannot happen within one process** — but
  // a log is a file. Anything that wrote around a live store, or a crash
  // between the write and the state update, leaves copies, and both reading
  // and reopening have to cope.
  //
  // Sorting by seq puts the copies adjacent, so `0, 0, 0, 1, ...` broke two
  // walks that stepped by `expect + 1`: `ChainSet.load` pinned the chain at 0,
  // and `readRange` yielded one event and stopped. A peer asking for the range
  // received seq 0 and nothing else, however many times it asked — which
  // showed up as a file with a name, no content, and a folder icon.
  it('serves the whole range, not just the first event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thing-dup-'));
    dirs.push(dir);

    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const events: Event[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(await w.write(ROOT, `:a${i}`, new TextEncoder().encode(`v${i}`), i));
    }

    // Write the log by hand, with every event three times — what the store
    // would have on disk after the failure this guards against.
    const store = await new FileStore(dir).open(hex(key.publicKey), key.publicKey);
    await store.append(events);
    await store.append(events);
    await store.append(events);
    const raw = await readFile(join(dir, hex(key.publicKey), 'log'));
    await writeFile(join(dir, hex(key.publicKey), 'log'), Buffer.concat([raw, raw, raw]));

    // Reopen: the chain rebuilds from a log with duplicates in it.
    const reopened = await new FileStore(dir).open(hex(key.publicKey), key.publicKey);
    const vv = await reopened.versionVector();
    expect([...vv.values()][0]?.frontier).toBe(4);

    const served: number[] = [];
    for await (const e of reopened.readRange({ chain: chainOf(events[0]!), from: 0 })) {
      served.push(e.seq);
    }
    expect(served).toEqual([0, 1, 2, 3, 4]);
  });

  it('still stops at a genuine gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thing-gap-'));
    dirs.push(dir);
    const key = await keyPairFromSeed(labelled('gap', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const events: Event[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(await w.write(ROOT, `:a${i}`, new TextEncoder().encode(`v${i}`), i));
    }

    const store = await new FileStore(dir).open(hex(key.publicKey), key.publicKey);
    // 0, 1 then 3, 4 — the store refuses the last two as a gap, so the log
    // holds a prefix and the range must end where the prefix does.
    await store.append([events[0]!, events[1]!, events[3]!, events[4]!]);

    const served: number[] = [];
    for await (const e of store.readRange({ chain: chainOf(events[0]!), from: 0 })) {
      served.push(e.seq);
    }
    expect(served).toEqual([0, 1]);
  });
});
