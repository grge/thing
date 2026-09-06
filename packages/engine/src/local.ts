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
import type { KeyPair } from './core/index.js';
import type { SpaceId } from './store/index.js';

export type { PetnameStore } from './store/naming.js';

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
  /** This client's writing key for a space, or null if it holds none. */
  keyFor(space: SpaceId): Promise<KeyPair | null>;
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
 * Where a space was last reached (§5.3).
 *
 * **First tried, first discarded.** A locator is stale by default and must
 * never be the reason a space is reported gone — it exists so reopening a
 * client does not mean pasting an address again. Nothing should treat a miss
 * here as an error.
 *
 * Synchronous, because it is read on every reconnect and a cache that makes
 * callers await is a cache that gets skipped.
 */
export interface LocatorCache {
  get(space: SpaceId): string | null;
  set(space: SpaceId, url: string): void;
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
