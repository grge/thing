/**
 * In-memory `LocalState`, and the contract every backend must satisfy.
 *
 * The same shape as `MemoryStore` and its conformance suite: a real
 * implementation used by tests, plus one set of expectations both real backends
 * are checked against — so "remembers a space" means the same thing in a
 * browser and on a filesystem rather than two things that look similar.
 */
import type { KeyPair, ReadingKey } from './core/index.js';
import { generateKeyPair, READING_KEY_LEN } from './core/index.js';
import type { SpaceId } from './store/index.js';
import type { PetnameStore } from './store/naming.js';
import { type Inventory, type Keyring, type LocalState, seedFor } from './local.js';
import { Locators } from './locators.js';

export class MemoryKeyring implements Keyring {
  private readonly keys = new Map<SpaceId, KeyPair>();
  /** Reading keys, kept apart from writing keys: separate capabilities (§6). */
  private readonly reading = new Map<SpaceId, ReadingKey>();

  async mint(): Promise<KeyPair> {
    const key = await generateKeyPair();
    const id = hexOf(key.publicKey);
    this.keys.set(id, key);
    return key;
  }

  async mintFor(space: SpaceId): Promise<KeyPair> {
    // Idempotent, which also protects a space this client owns: the key filed
    // under that id is the space's own identity (§5.1.1).
    const existing = this.keys.get(space);
    if (existing !== undefined) return existing;

    // Filed under the space it is *for*, not under its own public key.
    const key = await generateKeyPair();
    this.keys.set(space, key);
    return key;
  }

  async importFor(space: SpaceId, seed: string): Promise<boolean> {
    const pair = await seedFor(space, seed);
    if (pair === null) return false;
    this.keys.set(space, pair);
    return true;
  }

  async keyFor(space: SpaceId): Promise<KeyPair | null> {
    return this.keys.get(space) ?? null;
  }

  async readingFor(space: SpaceId): Promise<ReadingKey | null> {
    return this.reading.get(space) ?? null;
  }

  async setReading(space: SpaceId, reading: ReadingKey): Promise<void> {
    if (reading.length !== READING_KEY_LEN) {
      throw new Error(`a reading key is ${READING_KEY_LEN} bytes, got ${reading.length}`);
    }
    this.reading.set(space, reading);
  }

  async forget(space: SpaceId): Promise<void> {
    this.keys.delete(space);
    this.reading.delete(space);
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

/** The ranking from `Locators`, over an object that goes nowhere. */
export class MemoryLocators extends Locators {
  constructor(now?: () => number) {
    super({}, () => {}, now);
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
