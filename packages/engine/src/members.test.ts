/**
 * Multi-writer: who may write, and who moderates (§7.2).
 *
 * The fold's half of this was already tested — `fold.test.ts` covers root
 * admission and phase-2 filtering. These cover the half above it: managing a
 * membership list, and the properties §7.2 claims for it.
 */
import { describe, expect, it } from 'vitest';

import {
  generateKeyPair,
  hex,
  type KeyPair,
  keyPairFromSeed,
  list,
  makeFolder,
  ROOT,
  SEED_LEN,
} from './index.js';
import { MemoryStore, type Store } from './store/index.js';
import { Space } from './space.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

async function spaceKey(label = 'space'): Promise<KeyPair> {
  return keyPairFromSeed(labelled(label, SEED_LEN));
}

async function open(store: Store, key: KeyPair, writer: KeyPair = key): Promise<Space> {
  let tick = 0;
  const s = await store.open(hex(key.publicKey), key.publicKey);
  return Space.open(s, { key: key.publicKey, writer, now: () => (tick += 1) });
}

describe('membership', () => {
  it('a space with no declared set admits everyone', async () => {
    // The single-writer case. A set would be ceremony, and "not declared" is a
    // different state from "declared, containing one" — visible to a person.
    const key = await spaceKey();
    const space = await open(new MemoryStore(), key);
    expect(space.writers).toBeNull();
    expect(space.admitted).toBe(true);
  });

  it('naming a writer narrows the set to them and the space key', async () => {
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const space = await open(new MemoryStore(), key);

    await space.addWriter(alice.publicKey);

    expect(space.writers).toEqual([hex(alice.publicKey), hex(key.publicKey)].sort());
  });

  it('adding a writer twice is a no-op, not a second event', async () => {
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const space = await open(new MemoryStore(), key);

    expect(await space.addWriter(alice.publicKey)).not.toBeNull();
    expect(await space.addWriter(alice.publicKey)).toBeNull();
  });

  it('an admitted writer folds; a removed one does not', async () => {
    // §7.2.1: phase 2 admits an event iff its writer is in the set.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const store = new MemoryStore();

    const owner = await open(store, key);
    await owner.addWriter(alice.publicKey);

    const asAlice = await open(store, key, alice);
    expect(asAlice.admitted).toBe(true);
    await makeFolder(asAlice, 'alice-was-here');

    // Reopened, because two Space objects over one store hold separate folds —
    // they are two clients that happen to share a disk, not one.
    const fresh = await open(store, key);
    expect(list(fresh.state).map((e) => e.name)).toContain('alice-was-here');
  });

  it('removal stops future writes and keeps past ones (§7.2.3)', async () => {
    // The property the spec insists on stating rather than apologising for.
    // Unwriting history would make what a peer computes depend on when it
    // heard about the removal — a fork made by the security mechanism itself.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const store = new MemoryStore();

    const owner = await open(store, key);
    await owner.addWriter(alice.publicKey);

    const asAlice = await open(store, key, alice);
    await makeFolder(asAlice, 'before-removal');

    // Reopened so the owner's fold sees Alice's write before the removal.
    const owner2 = await open(store, key);
    await owner2.removeWriter(alice.publicKey);
    expect(owner2.writers).toEqual([hex(key.publicKey)]);

    // What she wrote while admitted is still there.
    expect(list(owner2.state).map((e) => e.name)).toContain('before-removal');

    // What she writes now is stored, signed, and not folded.
    const after = await open(store, key, alice);
    expect(after.admitted).toBe(false);
    await makeFolder(after, 'after-removal');
    const fresh = await open(store, key);
    expect(list(fresh.state).map((e) => e.name)).not.toContain('after-removal');

    // Her *past* writes should survive too, and on a replay they do not — see
    // the failing test below.
  });

  it('a removed writer\'s past events survive a replay (§7.2.3)', async () => {
    // Was a known bug (OPEN.md 8a), now fixed by `deps`. §7.2.3 picks *valid
    // when written* over *valid now*: removing a writer stops their future
    // writes and must not unwrite their past ones.
    //
    // Before `deps` the full fold filtered by the *final* writer set, so a
    // removed writer looked as though they had never been admitted — and the
    // incremental fold kept whatever it had already applied, so the two
    // disagreed and the answer depended on arrival order.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const store = new MemoryStore();

    const owner = await open(store, key);
    await owner.addWriter(alice.publicKey);
    const asAlice = await open(store, key, alice);
    await makeFolder(asAlice, 'before-removal');

    const owner2 = await open(store, key);
    await owner2.removeWriter(alice.publicKey);

    const replayed = await open(store, key);
    expect(list(replayed.state).map((e) => e.name)).toContain('before-removal');
  });

  it('the space key cannot be removed', async () => {
    // It is the authority the set derives from, so removing it would leave a
    // set nobody could ever change again.
    const key = await spaceKey();
    const space = await open(new MemoryStore(), key);
    await space.addWriter((await generateKeyPair()).publicKey);

    expect(await space.removeWriter(key.publicKey)).toBeNull();
    expect(space.writers).toContain(hex(key.publicKey));
  });

  it('only the space key may change membership', async () => {
    // §7.2.1. A writer holding any other key would produce a root event every
    // peer drops, which looks like working and is not — so it throws here
    // rather than failing silently at the fold.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const store = new MemoryStore();

    const owner = await open(store, key);
    await owner.addWriter(alice.publicKey);

    const asAlice = await open(store, key, alice);
    await expect(asAlice.addWriter((await generateKeyPair()).publicKey)).rejects.toThrow(
      /only the space key/,
    );
  });

  it('a forged root event is dropped even though it is validly signed', async () => {
    // The attack §7.2 exists to close: a stranger writing "I am a writer".
    const key = await spaceKey();
    const mallory = await generateKeyPair();
    const store = new MemoryStore();

    const owner = await open(store, key);
    await owner.addWriter(mallory.publicKey);

    // Mallory is a writer, so her ordinary events fold — but the root is not
    // ordinary, and her attempt to widen the set is signed by the wrong key.
    const asMallory = await open(store, key, mallory);
    await asMallory.write(ROOT, ':writers', UTF8.encode(hex(mallory.publicKey)));

    const fresh = await open(store, key);
    expect(fresh.writers).toContain(hex(key.publicKey));
  });
});

describe('moderators', () => {
  it('are ordinary writers with an attribute (§7.2.2)', async () => {
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const space = await open(new MemoryStore(), key);

    await space.addWriter(alice.publicKey);
    await space.addModerator(alice.publicKey);

    expect(space.moderators).toEqual([hex(alice.publicKey)]);
    // Moderating grants nothing the fold enforces; she was already a writer.
    expect(space.writers).toContain(hex(alice.publicKey));
  });

  it('cannot moderate without being a writer', async () => {
    const key = await spaceKey();
    const space = await open(new MemoryStore(), key);
    await space.addWriter((await generateKeyPair()).publicKey);

    const stranger = await generateKeyPair();
    expect(await space.addModerator(stranger.publicKey)).toBeNull();
  });

  it('stop moderating when they stop being writers', async () => {
    // Otherwise removing someone from the writer set would leave them
    // moderating, which is the kind of gap nobody notices until it is used.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const space = await open(new MemoryStore(), key);

    await space.addWriter(alice.publicKey);
    await space.addModerator(alice.publicKey);
    await space.removeWriter(alice.publicKey);

    expect(space.moderators).toEqual([]);
  });
});

describe('the register, and what it costs (§7.4)', () => {
  it('loses one of two concurrent membership edits', async () => {
    // **A known and accepted cost, pinned so it cannot be forgotten.**
    //
    // `:writers` is a whole-list register: each change recomputes the list from
    // the fold it can see and writes it entire. Two administrators editing
    // concurrently do not merge — the later wins and the earlier's addition
    // vanishes.
    //
    // Per-process append points made this *more* likely, not less. §7.2.1
    // reasoned that a register was sufficient because "there is one writer to
    // the root", but one writer now means one identity across several chains,
    // so a server and a CLI holding the same space key can do exactly this.
    //
    // Accepted because the alternative — add/remove operations — needs causal
    // context, and root events must stay self-authorising or §7.2's
    // circularity comes back. Recoverable, too: re-add the missing writer.
    // See OPEN.md question 7.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    // Two processes, one space key, each with its own store and append point.
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    const a = await open(storeA, key);
    const b = await open(storeB, key);

    await a.addWriter(alice.publicKey);
    await b.addWriter(bob.publicKey);

    // Exchange, as syncing would.
    const eventsOf = async (store: MemoryStore): Promise<import('./index.js').Event[]> => {
      const out: import('./index.js').Event[] = [];
      for await (const e of (await store.open(hex(key.publicKey), key.publicKey)).readAll()) {
        out.push(e);
      }
      return out;
    };
    await b.receive(await eventsOf(storeA));
    await a.receive(await eventsOf(storeB));

    // Both converge — and both hold a list with exactly one of the two.
    expect(a.writers).toEqual(b.writers);
    const both = [hex(alice.publicKey), hex(bob.publicKey)];
    const kept = both.filter((k) => a.writers!.includes(k));
    expect(kept).toHaveLength(1);
  });
});
