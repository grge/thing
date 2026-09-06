/**
 * In-memory `LocalState`, and the contract every backend must satisfy.
 *
 * The same shape as `MemoryStore` and its conformance suite: a real
 * implementation used by tests, plus one set of expectations both real backends
 * are checked against — so "remembers a space" means the same thing in a
 * browser and on a filesystem rather than two things that look similar.
 */
import type { KeyPair } from './core/index.js';
import { generateKeyPair } from './core/index.js';
import type { SpaceId } from './store/index.js';
import type { PetnameStore } from './store/naming.js';
import type { Inventory, Keyring, LocalState, LocatorCache } from './local.js';

export class MemoryKeyring implements Keyring {
  private readonly keys = new Map<SpaceId, KeyPair>();

  async mint(): Promise<KeyPair> {
    const key = await generateKeyPair();
    const id = hexOf(key.publicKey);
    this.keys.set(id, key);
    return key;
  }

  async keyFor(space: SpaceId): Promise<KeyPair | null> {
    return this.keys.get(space) ?? null;
  }

  async forget(space: SpaceId): Promise<void> {
    this.keys.delete(space);
  }
}

export class MemoryInventory implements Inventory {
  private readonly held = new Set<SpaceId>();

  async all(): Promise<readonly SpaceId[]> {
    return [...this.held].sort();
  }

  async remember(space: SpaceId): Promise<void> {
    this.held.add(space);
  }

  async forget(space: SpaceId): Promise<void> {
    this.held.delete(space);
  }
}

export class MemoryPetnames implements PetnameStore {
  private readonly names = new Map<string, SpaceId>();

  async all(): Promise<ReadonlyMap<string, SpaceId>> {
    return new Map(this.names);
  }

  async set(name: string, space: SpaceId): Promise<void> {
    this.names.set(name, space);
  }

  async remove(name: string): Promise<void> {
    this.names.delete(name);
  }
}

export class MemoryLocators implements LocatorCache {
  private readonly urls = new Map<SpaceId, string>();

  get(space: SpaceId): string | null {
    return this.urls.get(space) ?? null;
  }

  set(space: SpaceId, url: string): void {
    this.urls.set(space, url);
  }

  forget(space: SpaceId): void {
    this.urls.delete(space);
  }
}

export function memoryLocalState(): LocalState {
  return {
    keys: new MemoryKeyring(),
    inventory: new MemoryInventory(),
    petnames: new MemoryPetnames(),
    locators: new MemoryLocators(),
  };
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
