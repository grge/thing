/**
 * An encrypted space (ARCHITECTURE.md §6).
 *
 * Three properties, and they are the ones `ENCRYPTION-PLAN.md` asks to be
 * checked while building:
 *
 * - **An encrypted space and an unencrypted one fold identically** given the
 *   key. The exemption is about what is encrypted, never about what is
 *   admitted, so the fold above the cipher must not know it exists.
 * - **A keyless peer stores, verifies, serves and folds structure** — §6.1's
 *   table — and reads nothing.
 * - **The root is in clear** (`docs/design/ROOT-IN-CLEAR.md`), which is what
 *   lets that keyless peer evaluate membership at all.
 */
import { describe, expect, it } from 'vitest';
import {
  type Event,
  generateKeyPair,
  hex,
  type KeyPair,
  keyPairFromSeed,
  newReadingKey,
  type ReadingKey,
  ROOT,
  SEED_LEN,
  verifyEvent,
} from './core/index.js';
import { MemoryStore, type Store } from './store/index.js';
import { entry, list, makeFile, makeFolder, read } from './fs/files.js';
import { Space } from './space.js';

const UTF8 = new TextEncoder();
const UTF8D = new TextDecoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

async function spaceKey(): Promise<KeyPair> {
  return keyPairFromSeed(labelled('space', SEED_LEN));
}

/** A space over a store, with a deterministic clock so two runs are comparable. */
async function openSpace(
  store: Store,
  key: KeyPair,
  reading?: ReadingKey,
  writer: KeyPair = key,
): Promise<Space> {
  let tick = 0;
  const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
  return Space.open(spaceStore, {
    key: key.publicKey,
    writer,
    now: () => (tick += 1),
    ...(reading === undefined ? {} : { reading }),
  });
}

/** Write the same small filesystem into whatever space it is given. */
async function populate(space: Space): Promise<void> {
  const docs = await makeFolder(space, 'docs');
  await makeFile(space, 'readme.md', UTF8.encode('# hello'), { parent: docs });
  await makeFile(space, 'notes.txt', UTF8.encode('some notes'));
}

/**
 * State reduced to what a reader would see, for comparing two folds.
 *
 * Names, kinds, tree position and body — everything encryption is meant to be
 * invisible to. **Uuids are deliberately not in it**: they are minted randomly
 * per object (§2.1), so two spaces holding the same filesystem disagree on them
 * for reasons that have nothing to do with encryption. The tree is expressed by
 * the parent's *name* instead, which is stable across both.
 */
function summarise(space: Space): string {
  const state = space.state;
  const nameOf = (id: string): string => {
    const o = state.objects.get(id);
    return o === undefined ? '/' : (entry(state, o.uuid)?.name ?? '?');
  };
  const lines: string[] = [];
  for (const object of state.objects.values()) {
    const e = entry(state, object.uuid);
    lines.push(`${e?.name ?? '?'} ${e?.kind ?? '-'} in ${nameOf(hex(object.parent))}`);
  }
  return lines.sort().join('\n');
}

describe('an encrypted space', () => {
  it('folds identically to an unencrypted one, given the key', async () => {
    const key = await spaceKey();
    const reading = newReadingKey();

    const clear = await openSpace(new MemoryStore(), key);
    const secret = await openSpace(new MemoryStore(), key, reading);
    await populate(clear);
    await populate(secret);

    expect(summarise(secret)).toBe(summarise(clear));
  });

  it('round-trips a file through a reopen', async () => {
    const key = await spaceKey();
    const reading = newReadingKey();
    const store = new MemoryStore();

    const space = await openSpace(store, key, reading);
    const { id } = await makeFile(space, 'notes.txt', UTF8.encode('some notes'));
    await space.close();

    // Reopening replays the log, so this is the full fold rather than the
    // incremental one — and the two must agree (§3.6).
    const reopened = await openSpace(store, key, reading);
    const bytes = await read(reopened, id);
    expect(bytes).not.toBeNull();
    expect(UTF8D.decode(bytes!)).toBe('some notes');
  });

  it('puts ciphertext in the log', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const space = await openSpace(store, key, newReadingKey());
    await makeFile(space, 'secret.txt', UTF8.encode('the plaintext'));

    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    const values: string[] = [];
    for await (const e of spaceStore.readAll()) values.push(hex(e.value));
    const log = values.join('');

    expect(log).not.toContain(hex(UTF8.encode('secret.txt')));
    expect(log).not.toContain(hex(UTF8.encode('the plaintext')));
  });

  it('puts ciphertext in blobs', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const reading = newReadingKey();
    const space = await openSpace(store, key, reading);

    const plaintext = UTF8.encode('the file contents');
    const hash = await space.putBlob(plaintext);

    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    const stored = await spaceStore.getBlob(hash);
    expect(stored).not.toBeNull();
    expect(hex(stored!)).not.toContain(hex(plaintext));

    // And the space itself still reads it back.
    expect(hex((await space.getBlob(hash))!)).toBe(hex(plaintext));
  });

  /**
   * The trade taken in `ENCRYPTION-PLAN.md`: §2.4's deduplication is given up so
   * that a hub operator cannot confirm a guessed file. Deterministic ciphertext
   * must not creep back in, and nothing else would notice if it did.
   */
  it('stores one plaintext twice as two blobs', async () => {
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key, newReadingKey());
    const bytes = UTF8.encode('identical content');
    expect(hex(await space.putBlob(bytes))).not.toBe(hex(await space.putBlob(bytes)));
  });

  it('deduplicates blobs when there is no reading key', async () => {
    const key = await spaceKey();
    const space = await openSpace(new MemoryStore(), key);
    const bytes = UTF8.encode('identical content');
    expect(hex(await space.putBlob(bytes))).toBe(hex(await space.putBlob(bytes)));
  });

  it('leaves root-targeted events in clear', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const space = await openSpace(store, key, newReadingKey());
    await space.write(ROOT, ':name', UTF8.encode('laptop docs'));

    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    let found: Event | null = null;
    for await (const e of spaceStore.readAll()) {
      if (hex(e.target) === hex(ROOT) && e.attr === ':name') found = e;
    }
    expect(found).not.toBeNull();
    // In clear, and deliberately so: `:name` is the one real cost of the root
    // exemption (`ROOT-IN-CLEAR.md`).
    expect(UTF8D.decode(found!.value)).toBe('laptop docs');
  });

  /**
   * The invariant `ROOT-IN-CLEAR.md` says a peer can check without knowing what
   * any of it says: ciphertext in every event whose target is not the root,
   * cleartext in every event whose target is.
   */
  it('encrypts everything that is not root-targeted', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const space = await openSpace(store, key, newReadingKey());
    await space.write(ROOT, ':name', UTF8.encode('laptop docs'));
    await populate(space);

    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    for await (const e of spaceStore.readAll()) {
      if (hex(e.target) === hex(ROOT)) continue;
      // Nothing written above is empty, so every non-root value must have grown
      // by the AEAD tag rather than passing through untouched.
      expect(e.value.length).toBeGreaterThan(0);
      expect(UTF8D.decode(e.value)).not.toMatch(/readme\.md|notes\.txt|docs|hello/);
    }
  });
});

/** §6.1's table, which is the specification for a peer that holds no key. */
describe('a peer without the reading key', () => {
  it('stores, verifies and serves the log', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const reading = newReadingKey();

    const owner = await openSpace(store, key, reading);
    await populate(owner);

    // The same store, opened by a peer that was given no key at all.
    const keyless = await openSpace(store, key);
    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);

    let count = 0;
    for await (const e of spaceStore.readAll()) {
      expect(await verifyEvent(key.publicKey, e)).toBe(true);
      count += 1;
    }
    expect(count).toBeGreaterThan(0);
    // It holds every event the owner does, which is what serving requires.
    expect((await keyless.versionVector()).size).toBe((await owner.versionVector()).size);
  });

  it('folds the root, and so can evaluate membership', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const other = await generateKeyPair();

    const owner = await openSpace(store, key, newReadingKey());
    await owner.write(ROOT, ':name', UTF8.encode('laptop docs'));
    await owner.addWriter(other.publicKey);

    const keyless = await openSpace(store, key);
    // The whole point of the root exemption: this is computable without reading.
    expect(keyless.writers).toContain(hex(other.publicKey));
    expect(keyless.state.root.get(':name')?.value).toBe('laptop docs');
  });

  it('reads no names, kinds or bodies', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const owner = await openSpace(store, key, newReadingKey());
    await populate(owner);

    const keyless = await openSpace(store, key);
    for (const object of keyless.state.objects.values()) {
      const e = entry(keyless.state, object.uuid);
      expect(e?.name ?? null).not.toBe('readme.md');
      expect(e?.name ?? null).not.toBe('notes.txt');
    }
  });

  /**
   * §6.1: `:kind` is encrypted, so such a peer cannot pick a body rule at all.
   * That is deliberate, and the UI must not read it as corruption — which is
   * what step 5 of the plan is about.
   */
  it('reports every body as an unreadable rule rather than as damage', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const owner = await openSpace(store, key, newReadingKey());
    await makeFile(owner, 'notes.txt', UTF8.encode('some notes'));

    const keyless = await openSpace(store, key);
    const withBodies = [...keyless.state.objects.values()].filter(
      (o) => o.bodyRuleMissing !== undefined,
    );
    expect(withBodies.length).toBeGreaterThan(0);
    for (const o of withBodies) expect(o.body).toBeUndefined();
  });

  it('serves a blob it cannot read', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const reading = newReadingKey();

    const owner = await openSpace(store, key, reading);
    const plaintext = UTF8.encode('the file contents');
    const hash = await owner.putBlob(plaintext);

    // A keyless peer holds the bytes — that is what serving means.
    const spaceStore = await store.open(hex(key.publicKey), key.publicKey);
    expect(await spaceStore.getBlob(hash)).not.toBeNull();

    // What it hands back is the ciphertext, and **not** the plaintext. It
    // cannot report "unreadable" instead, because it has no way to know that it
    // is holding ciphertext at all: a space with no reading key and a space
    // whose key this peer lacks are the same thing from here (§6.1). Serving is
    // what it is for, and serving is passing bytes on unexamined.
    const keyless = await openSpace(store, key);
    const served = await keyless.getBlob(hash);
    expect(served).not.toBeNull();
    expect(hex(served!)).not.toBe(hex(plaintext));

    // And a peer that does hold the key reads it through the same store.
    const reader = await openSpace(store, key, reading);
    expect(hex((await reader.getBlob(hash))!)).toBe(hex(plaintext));
  });

  /** A wrong key is not corruption either: it reads nothing and folds fine. */
  it('reads nothing with the wrong reading key', async () => {
    const key = await spaceKey();
    const store = new MemoryStore();
    const owner = await openSpace(store, key, newReadingKey());
    await populate(owner);
    const objects = owner.state.objects.size;

    const wrong = await openSpace(store, key, newReadingKey());
    expect(list(wrong.state).map((e) => e.name)).not.toContain('notes.txt');
    // Still folded: the objects are all there, only unreadable. Counted before
    // the second open, because both write into one store and a second
    // `populate` would be a second filesystem.
    expect(wrong.state.objects.size).toBe(objects);
  });
});
