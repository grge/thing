/**
 * The conformance suite: what every backend must do, identically.
 *
 * Exported as a function rather than written as tests, so each backend imports
 * it and runs it against itself. That is the whole point — a browser and a
 * headless peer must behave the same, and the only way to be sure is to check
 * them against one set of expectations rather than two that look similar.
 *
 * Not a test file itself: it is imported by `memory.test.ts` and by each
 * backend's own test.
 */
import {
  type Event,
  generateKeyPair,
  hex,
  type KeyPair,
  keyPairFromSeed,
  ROOT,
  SEED_LEN,
  Writer,
} from '../core/index.js';
import { describe, expect, it } from 'vitest';
import type { Store } from './types.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/**
 * Run the suite against a backend.
 *
 * `makeStore` returns a fresh, empty store each call; `cleanup` releases
 * whatever it allocated.
 */
export function conformanceTests(
  name: string,
  makeStore: () => Promise<Store>,
  cleanup?: (store: Store) => Promise<void>,
): void {
  /** A space and a writer for it, plus a few events. */
  async function fixture(): Promise<{
    key: KeyPair;
    space: string;
    writer: Writer;
  }> {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    return { key, space: hex(key.publicKey), writer: new Writer(key.publicKey, key) };
  }

  async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    const store = await makeStore();
    try {
      return await fn(store);
    } finally {
      await store.close();
      if (cleanup !== undefined) await cleanup(store);
    }
  }

  describe(`${name}: events`, () => {
    it('appends and reads back', async () => {
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);

        const e = await writer.write(ROOT, ':name', UTF8.encode('hello'), 1);
        const result = await s.append([e]);

        expect(result.appended).toHaveLength(1);
        expect(result.rejected).toHaveLength(0);
        expect(await s.count()).toBe(1);

        const all = await collect(s.readAll());
        expect(all).toHaveLength(1);
        expect(hex(all[0]!.value)).toBe(hex(e.value));
      });
    });

    it('appending the same event twice is a no-op', async () => {
      // §1.1: the log is a set. A duplicate is not an error.
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        const e = await writer.write(ROOT, ':name', UTF8.encode('x'), 1);

        await s.append([e]);
        const second = await s.append([e]);

        expect(second.appended).toHaveLength(0);
        expect(second.rejected[0]?.why.kind).toBe('duplicate');
        expect(await s.count()).toBe(1);
      });
    });

    it('accepts a batch in any order', async () => {
      // A caller should not have to sort before appending.
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        const events: Event[] = [];
        for (let i = 0; i < 5; i++) {
          events.push(await writer.write(ROOT, ':name', UTF8.encode(`v${i}`), i));
        }

        const result = await s.append([...events].reverse());
        expect(result.appended).toHaveLength(5);
        expect(await s.count()).toBe(5);
      });
    });

    it('refuses an event beyond a gap', async () => {
      // §2.5: storage does not buffer. The caller fills the gap and retries.
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        const first = await writer.write(ROOT, ':name', UTF8.encode('a'), 0);
        const second = await writer.write(ROOT, ':name', UTF8.encode('b'), 1);
        const third = await writer.write(ROOT, ':name', UTF8.encode('c'), 2);

        await s.append([first]);
        const result = await s.append([third]);

        expect(result.appended).toHaveLength(0);
        expect(result.rejected[0]?.why.kind).toBe('gap');

        // Filling the gap admits both.
        const after = await s.append([second, third]);
        expect(after.appended).toHaveLength(2);
      });
    });

    it('refuses an unverified event', async () => {
      // §2.3: nothing enters a store unverified. A peer cannot be trusted to
      // have checked.
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        const e = await writer.write(ROOT, ':name', UTF8.encode('real'), 1);
        const tampered: Event = { ...e, value: UTF8.encode('forged') };

        const result = await s.append([tampered]);
        expect(result.appended).toHaveLength(0);
        expect(result.rejected[0]?.why.kind).toBe('unverified');
      });
    });

    it('refuses an event signed for another space', async () => {
      // §2.1: the space key is in the preimage, so an event lifted from
      // elsewhere does not verify here.
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const other = await generateKeyPair();
        const s = await store.open(space, key.publicKey);

        const elsewhere = new Writer(other.publicKey, key);
        const e = await elsewhere.write(ROOT, ':name', UTF8.encode('x'), 1);

        const result = await s.append([e]);
        expect(result.appended).toHaveLength(0);
        expect(result.rejected[0]?.why.kind).toBe('unverified');
      });
    });

    it('reads one writer’s range in seq order', async () => {
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        for (let i = 0; i < 6; i++) {
          await s.append([await writer.write(ROOT, ':name', UTF8.encode(`v${i}`), i)]);
        }

        const range = await collect(
          s.readRange({ writer: hex(key.publicKey), from: 2, to: 5 }),
        );
        expect(range.map((e) => e.seq)).toEqual([2, 3, 4]);
      });
    });

    it('reports a version vector with a frontier and a tip', async () => {
      // §2.3: the tip is what makes a fork detectable — two peers can agree on
      // a number while holding different histories.
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        for (let i = 0; i < 3; i++) {
          await s.append([await writer.write(ROOT, ':name', UTF8.encode(`v${i}`), i)]);
        }

        const vv = await s.versionVector();
        const entry = vv.get(hex(key.publicKey));
        expect(entry?.frontier).toBe(2);
        expect(entry?.tip).toHaveLength(32);
      });
    });

    it('the version vector reports only the contiguous prefix', async () => {
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        const events: Event[] = [];
        for (let i = 0; i < 4; i++) {
          events.push(await writer.write(ROOT, ':name', UTF8.encode(`v${i}`), i));
        }
        // Hold 0, 1 and 3: the frontier is 1, because 2 is missing.
        await s.append([events[0]!, events[1]!, events[3]!]);

        const vv = await s.versionVector();
        expect(vv.get(hex(key.publicKey))?.frontier).toBe(1);
      });
    });

    it('keeps writers independent', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const other = await keyPairFromSeed(labelled('other', SEED_LEN));
        const s = await store.open(space, key.publicKey);

        const a = new Writer(key.publicKey, key);
        const b = new Writer(key.publicKey, other);
        await s.append([await a.write(ROOT, ':name', UTF8.encode('a'), 0)]);
        await s.append([await b.write(ROOT, ':name', UTF8.encode('b'), 0)]);

        const vv = await s.versionVector();
        expect(vv.size).toBe(2);
        expect(await s.count()).toBe(2);
      });
    });
  });

  describe(`${name}: blobs`, () => {
    it('stores and retrieves by content hash', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const s = await store.open(space, key.publicKey);

        const bytes = UTF8.encode('some content');
        const hash = await s.putBlob(bytes);

        expect(hash).toHaveLength(32);
        expect(await s.hasBlob(hash)).toBe(true);
        expect(hex((await s.getBlob(hash))!)).toBe(hex(bytes));
      });
    });

    it('deduplicates identical content', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const s = await store.open(space, key.publicKey);

        const a = await s.putBlob(UTF8.encode('same'));
        const b = await s.putBlob(UTF8.encode('same'));
        expect(hex(a)).toBe(hex(b));
        expect(await collect(s.blobHashes())).toHaveLength(1);
      });
    });

    it('returns null for a blob it does not hold', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const s = await store.open(space, key.publicKey);
        const absent = labelled('nope', 32);
        expect(await s.getBlob(absent)).toBeNull();
        expect(await s.hasBlob(absent)).toBe(false);
      });
    });

    it('handles an empty blob', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const s = await store.open(space, key.publicKey);
        const hash = await s.putBlob(new Uint8Array(0));
        expect((await s.getBlob(hash))!).toHaveLength(0);
      });
    });

    it('handles a large blob', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const s = await store.open(space, key.publicKey);
        const big = new Uint8Array(1 << 18);
        for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;

        const hash = await s.putBlob(big);
        const back = (await s.getBlob(hash))!;
        expect(back).toHaveLength(big.length);
        expect(back[0]).toBe(big[0]);
        expect(back[big.length - 1]).toBe(big[big.length - 1]);
      });
    });

    it('deletes a blob without touching events', async () => {
      // Blobs are a cache; events are the truth (§11).
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        await s.append([await writer.write(ROOT, ':name', UTF8.encode('x'), 0)]);

        const hash = await s.putBlob(UTF8.encode('bytes'));
        await s.deleteBlob(hash);

        expect(await s.hasBlob(hash)).toBe(false);
        expect(await s.count()).toBe(1);
      });
    });

    it('lists what it holds, for a HAVE exchange', async () => {
      await withStore(async (store) => {
        const { key, space } = await fixture();
        const s = await store.open(space, key.publicKey);
        await s.putBlob(UTF8.encode('one'));
        await s.putBlob(UTF8.encode('two'));
        expect(await collect(s.blobHashes())).toHaveLength(2);
      });
    });
  });

  describe(`${name}: spaces`, () => {
    it('keeps spaces separate, including their blobs', async () => {
      // §2.4: a shared blob store would let a peer learn whether this device
      // holds given content without being able to see the space referencing it.
      await withStore(async (store) => {
        const a = await keyPairFromSeed(labelled('space-a', SEED_LEN));
        const b = await keyPairFromSeed(labelled('space-b', SEED_LEN));

        const sa = await store.open(hex(a.publicKey), a.publicKey);
        const sb = await store.open(hex(b.publicKey), b.publicKey);

        const hash = await sa.putBlob(UTF8.encode('secret'));
        expect(await sa.hasBlob(hash)).toBe(true);
        expect(await sb.hasBlob(hash)).toBe(false);

        const w = new Writer(a.publicKey, a);
        await sa.append([await w.write(ROOT, ':name', UTF8.encode('x'), 0)]);
        expect(await sa.count()).toBe(1);
        expect(await sb.count()).toBe(0);
      });
    });

    it('lists open spaces', async () => {
      await withStore(async (store) => {
        const a = await keyPairFromSeed(labelled('space-a', SEED_LEN));
        await store.open(hex(a.publicKey), a.publicKey);
        expect(await store.list()).toContain(hex(a.publicKey));
      });
    });

    it('destroys a space', async () => {
      await withStore(async (store) => {
        const { key, space, writer } = await fixture();
        const s = await store.open(space, key.publicKey);
        await s.append([await writer.write(ROOT, ':name', UTF8.encode('x'), 0)]);
        await s.close();

        await store.destroy(space);
        expect(await store.list()).not.toContain(space);

        const reopened = await store.open(space, key.publicKey);
        expect(await reopened.count()).toBe(0);
      });
    });
  });

  describe(`${name}: durability`, () => {
    it('survives close and reopen', async () => {
      // The property that distinguishes a store from a cache. A memory backend
      // passes trivially within one process; a durable one has to mean it.
      const store = await makeStore();
      const { key, space, writer } = await fixture();

      const s = await store.open(space, key.publicKey);
      const events: Event[] = [];
      for (let i = 0; i < 4; i++) {
        events.push(await writer.write(ROOT, ':name', UTF8.encode(`v${i}`), i));
      }
      await s.append(events);
      const hash = await s.putBlob(UTF8.encode('durable bytes'));
      await s.close();

      const again = await store.open(space, key.publicKey);
      expect(await again.count()).toBe(4);
      expect(hex((await again.getBlob(hash))!)).toBe(hex(UTF8.encode('durable bytes')));

      const vv = await again.versionVector();
      expect(vv.get(hex(key.publicKey))?.frontier).toBe(3);

      await store.close();
      if (cleanup !== undefined) await cleanup(store);
    });

    it('rejects a duplicate after reopening', async () => {
      // The chain state must be rebuilt on open, not merely the events.
      const store = await makeStore();
      const { key, space, writer } = await fixture();

      const s = await store.open(space, key.publicKey);
      const e = await writer.write(ROOT, ':name', UTF8.encode('x'), 0);
      await s.append([e]);
      await s.close();

      const again = await store.open(space, key.publicKey);
      const result = await again.append([e]);
      expect(result.rejected[0]?.why.kind).toBe('duplicate');

      await store.close();
      if (cleanup !== undefined) await cleanup(store);
    });
  });
}
