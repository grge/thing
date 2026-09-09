/**
 * What a client knows that is not in any space (ARCHITECTURE.md §5.1, §5.3, §5.5).
 *
 * A space's log is replicated and identical everywhere. These four are the
 * opposite: per-client, never in a log, and lost with the client's storage.
 * They were one interface — `Keystore` in `packages/web` — and are four here,
 * because they differ in the ways that matter:
 *
 * | | what it is | replicable? | losing it means |
 * | --- | --- | --- | --- |
 * | `Keyring` | writing keys | **never** | you cannot write, permanently (§5.1.1) |
 * | `Inventory` | which spaces are held | yes | you must be re-told what you have |
 * | `PetnameStore` | what you call them (§5.5) | yes | names revert to codes |
 * | `LocatorCache` | where they were last reached (§5.3) | yes | you paste an address again |
 *
 * **The right-hand columns are why this is four interfaces and not one.** A
 * secret and a stale-by-default cache had been sharing a storage backend, a
 * lifetime and a backup story, and they should share none of those. The
 * `replicable?` column became load-bearing once an interface needed to mirror a
 * peer's state: three of these belong in that sync and the fourth must never
 * cross a wire.
 *
 * `PetnameStore` already lived in `store/naming.ts` and is re-exported here so
 * the four read as a set.
 */
import { hex, type KeyPair, keyPairFromSeed, type ReadingKey, SEED_LEN } from './core/index.js';
import type { Locator } from './net/locator.js';
import type { SpaceId } from './store/index.js';

export type { PetnameStore } from './store/naming.js';

/**
 * A seed that really is this space's key, or null.
 *
 * Shared so three backends cannot disagree about what they will accept. A
 * space *is* its public key (§5.1), so the check is that deriving the public
 * key from the seed reproduces the space id — anything else would install a
 * different space's identity under this one's name.
 */
export async function seedFor(space: SpaceId, seed: string): Promise<KeyPair | null> {
  const clean = seed.trim().toLowerCase();
  if (clean.length !== SEED_LEN * 2 || !/^[0-9a-f]+$/.test(clean)) return null;
  const bytes = new Uint8Array(SEED_LEN);
  for (let i = 0; i < SEED_LEN; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  try {
    const pair = await keyPairFromSeed(bytes);
    return hex(pair.publicKey) === space.toLowerCase() ? pair : null;
  } catch {
    return null;
  }
}

/**
 * Where a client keeps its writing keys (§5.1).
 *
 * **Never replicated, and the interface should make that obvious.** §5.1.1
 * calls losing a key the largest unresolved risk in the design — clearing site
 * data destroys the ability to write to your own space, permanently, with no
 * recovery and no way to tell readers. Nothing here solves that; keeping keys
 * separate from the three replicable things is the precondition for any answer,
 * because a backup story for keys looks nothing like one for a locator cache.
 *
 * Keys are raw seeds and deliberately extractable. A non-extractable platform
 * key sounds safer and is not: injected script could still *use* it to sign
 * anything, so it would be unstealable rather than protected — at the cost of
 * no backup and no way to move an identity to another device.
 */
export interface Keyring {
  /** A fresh keypair, stored. The public key becomes a space's id. */
  mint(): Promise<KeyPair>;
  /**
   * A fresh writing key **for a space this client does not own**.
   *
   * `mint` files a key under its own public key, so it can only ever produce
   * the key that *is* a space (§5.1). Joining someone else's space needs the
   * other thing: an identity to sign with, filed under the space it is for.
   * The two are different keys with different jobs, and the engine has always
   * kept them apart — `Space.open` takes `key` and `writer` separately, and
   * multi-writer convergence is tested on exactly that split.
   *
   * Idempotent: a client that already has an identity here keeps it, because a
   * second key would be a second writer wearing the same person's name and
   * would leave the first one's events orphaned.
   *
   * §5.1: identity is per-space rather than global — "we create new writer ids
   * for every space we touch" — so this mints rather than reusing anything.
   */
  mintFor(space: SpaceId): Promise<KeyPair>;
  /**
   * Install a key someone handed over, as a hex seed.
   *
   * The other half of `exportKey`, and §5.1.1 lists "an explicit export the
   * user is prompted to keep" among its candidate answers to key loss — an
   * export nobody can restore is half a mechanism.
   *
   * **Checked against the space it claims to be for.** A space *is* its public
   * key (§5.1), so a seed whose public key is not this space would install a
   * different space's identity under this one's name — the exact failure the
   * read-only fallback exists to prevent. Returns false rather than throwing:
   * a pasted seed is ordinary input and being wrong is an ordinary outcome.
   *
   * Only for a key that *is* the space. A writing identity within someone
   * else's space is minted, never handed over (`design/CAPABILITIES.md`).
   */
  importFor(space: SpaceId, seed: string): Promise<boolean>;
  /** This client's writing key for a space, or null if it holds none. */
  keyFor(space: SpaceId): Promise<KeyPair | null>;
  /**
   * The reading key for a space, or null if this client holds none (§6).
   *
   * **Beside the writing keys, not among them.** A space may have a reading key
   * or not, and a client may hold one for a space it cannot write, or a writing
   * key for a space it cannot read — `docs/design/CAPABILITIES.md` makes these
   * three separate capabilities, and a keyring that stored them together would
   * make "hold one but not the other" the awkward case rather than the ordinary
   * one it is.
   *
   * Null is not a failure. §6.1: replicating without reading is a first-class
   * way to participate.
   */
  readingFor(space: SpaceId): Promise<ReadingKey | null>;
  /**
   * Keep a reading key someone shared, normally out of an `r=` link fragment.
   *
   * Not minted here the way a writing key is: a reading key belongs to the
   * *space*, so every reader must hold the same one, and a client that minted
   * its own would produce a space only it could read (§6).
   */
  setReading(space: SpaceId, reading: ReadingKey): Promise<void>;
  /** Destroy a key. Irreversible, and §5.1.1 is why that matters. */
  forget(space: SpaceId): Promise<void>;
}

/**
 * Which spaces a client holds, whether or not it can write to them.
 *
 * Separate from `Keyring` because holding a space and being able to write to it
 * are different (§6.1): a replica stores, verifies and serves without ever
 * holding a key. It is also separate from storage, which knows what it *has* —
 * an inventory is what a client means to hold, and a client can intend to hold
 * a space whose events have not arrived.
 */
export interface Inventory {
  all(): Promise<readonly SpaceId[]>;
  remember(space: SpaceId): Promise<void>;
  forget(space: SpaceId): Promise<void>;
}

/**
 * Where a space has been reached, and how well (§5.3).
 *
 * **First tried, first discarded.** A locator is stale by default and must
 * never be the reason a space is reported gone — it exists so reopening a
 * client does not mean pasting an address again. Nothing should treat a miss
 * here as an error.
 *
 * **This carries more weight than it looks.** §5.3 once ranked a signed list on
 * a space's root the best locator source of all; it was dropped, because the
 * peer that knows a serving address usually cannot write the root and because
 * reachability is a fact about a *pair* of peers. So for "returning to a space
 * you already hold", this cache is the whole answer — announce and query need a
 * live peer who knows, and a share link is a one-shot introduction.
 *
 * **A list, not one entry, and ordered by what worked.** A space may be
 * reachable at a LAN address *and* through a hub, and which one works is
 * exactly the per-client fact that made a replicated list wrong. `succeeded`
 * and `failed` are what turn "first tried, first discarded" into an order
 * rather than a slogan.
 *
 * Synchronous, because it is read on every reconnect and a cache that makes
 * callers await is a cache that gets skipped.
 */
export interface LocatorCache {
  /** Candidates for a space, best first. Empty is ordinary, never an error. */
  get(space: SpaceId): readonly Locator[];
  /** Remember a candidate, from anywhere: a peer, a share link, a person. */
  remember(space: SpaceId, locator: Locator): void;
  /** This one worked. It sorts first from now on. */
  succeeded(space: SpaceId, locator: Locator): void;
  /** This one did not. It sinks, and is dropped once it has only ever failed. */
  failed(space: SpaceId, locator: Locator): void;
  forget(space: SpaceId): void;
}

/**
 * The four together, for a client that wants all of them.
 *
 * A convenience, not a new concept — anything needing only one should take only
 * that one, which is the point of having split them.
 */
export interface LocalState {
  readonly keys: Keyring;
  readonly inventory: Inventory;
  readonly petnames: import('./store/naming.js').PetnameStore;
  readonly locators: LocatorCache;
}
