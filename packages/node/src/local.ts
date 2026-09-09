/**
 * A headless peer's local state: keys, inventory, petnames, locators.
 *
 * The browser had these as one `Keystore`; `node` had them as three loose
 * functions in `cli.ts`, one class, and — for locators — **nothing at all**,
 * which is why `thing join` has always needed the address typed again. Both are
 * now the four interfaces `engine/local.ts` names, checked against one
 * conformance suite, so "remembers a space" means the same thing here and in a
 * browser.
 *
 * Everything lives beside the spaces it describes. That directory *is* the
 * client — its spaces, its keys, its names — so a client is something you can
 * copy, and there is no separate profile to keep in step.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  generateKeyPair,
  hex,
  type Inventory,
  type KeyPair,
  keyPairFromSeed,
  type Keyring,
  type LocalState,
  Locators,
  READING_KEY_LEN,
  type ReadingKey,
  SEED_LEN,
  seedFor,
  type Stored,
  type SpaceId,
} from '@thing/engine';

import { FilePetnames } from './petnames.js';

/**
 * Keys as files beside their spaces, mode 0600.
 *
 * One file per space rather than one keyring file: a key is the thing §5.1.1
 * says a person must be able to back up and move, and a file they can copy is
 * the simplest form of that. It also means losing one key cannot corrupt the
 * others.
 */
export class FileKeyring implements Keyring {
  constructor(private readonly dir: string) {}

  private path(space: SpaceId): string {
    return join(this.dir, `${space}.key`);
  }

  /**
   * Where a reading key lives: a separate file, beside the writing key.
   *
   * A different extension rather than a different directory, so the two travel
   * together when someone copies a keyring — and so `forget` can remove both
   * without walking anywhere.
   */
  private readingPath(space: SpaceId): string {
    return join(this.dir, `${space}.read`);
  }

  async mint(): Promise<KeyPair> {
    const key = await generateKeyPair();
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(hex(key.publicKey)), key.privateKey, { mode: 0o600 });
    return key;
  }

  async mintFor(space: SpaceId): Promise<KeyPair> {
    // Idempotent, and deliberately so: this is also what protects a client's
    // *own* space, where the key filed under the space id is the space's
    // identity and replacing it would be §5.1.1's unrecoverable loss.
    const existing = await this.keyFor(space);
    if (existing !== null) return existing;

    const key = await generateKeyPair();
    await mkdir(this.dir, { recursive: true });
    // Filed under the space it is *for*, not under its own public key: this is
    // an identity within someone else's space, not a space of its own.
    await writeFile(this.path(space), key.privateKey, { mode: 0o600 });
    return key;
  }

  async importFor(space: SpaceId, seed: string): Promise<boolean> {
    const pair = await seedFor(space, seed);
    if (pair === null) return false;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(space), pair.privateKey, { mode: 0o600 });
    return true;
  }

  async keyFor(space: SpaceId): Promise<KeyPair | null> {
    try {
      const seed = await readFile(this.path(space));
      if (seed.length !== SEED_LEN) return null;
      return await keyPairFromSeed(new Uint8Array(seed));
    } catch {
      // Absent or unreadable is "this peer holds no key", never an error: §6.1
      // says storing and serving without one is an ordinary way to participate.
      return null;
    }
  }

  async readingFor(space: SpaceId): Promise<ReadingKey | null> {
    try {
      const key = await readFile(this.readingPath(space));
      if (key.length !== READING_KEY_LEN) return null;
      return new Uint8Array(key);
    } catch {
      // Absent is "this peer cannot read that space", which §6.1 makes an
      // ordinary state rather than an error.
      return null;
    }
  }

  async setReading(space: SpaceId, reading: ReadingKey): Promise<void> {
    if (reading.length !== READING_KEY_LEN) {
      throw new Error(`a reading key is ${READING_KEY_LEN} bytes, got ${reading.length}`);
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.readingPath(space), reading, { mode: 0o600 });
  }

  async forget(space: SpaceId): Promise<void> {
    await rm(this.path(space), { force: true });
    await rm(this.readingPath(space), { force: true });
  }
}

/**
 * Which spaces this peer holds, read from the store's own directories.
 *
 * **Derived rather than recorded**, unlike the browser's: a directory of spaces
 * already *is* an inventory, and a second list beside it could disagree with
 * what is actually on disk. `remember` therefore only has to ensure the
 * directory exists, and `forget` is deliberately not a delete — removing a
 * space's events is `Store.destroy`, and an inventory should not quietly
 * destroy a log.
 */
export class FileInventory implements Inventory {
  constructor(
    private readonly dir: string,
    private readonly listSpaces: () => Promise<readonly SpaceId[]>,
  ) {}

  async all(): Promise<readonly SpaceId[]> {
    return [...(await this.listSpaces())].sort();
  }

  async remember(space: SpaceId): Promise<void> {
    await mkdir(join(this.dir, space), { recursive: true });
  }

  async forget(space: SpaceId): Promise<void> {
    // Intentionally nothing. A space leaves the inventory when its events are
    // destroyed, which is the store's job and a louder operation than this.
    void space;
  }
}

/**
 * Locators in one JSON file (§5.3).
 *
 * New: `node` had no locator cache, which is why joining a space meant typing
 * its address every time. Synchronous like the browser's, so it is read on
 * reconnect without making callers await — loaded once at construction, which
 * suits a cache that is *"first tried, first discarded"* and never authoritative.
 */
/**
 * The locator cache, on disk.
 *
 * Ranking lives in `Locators`; this supplies only where the JSON goes and how
 * it is loaded. A read failure means an empty cache rather than an error —
 * §5.3: losing it costs a re-typed address, nothing more.
 */
export class FileLocators extends Locators {
  private constructor(
    private readonly dir: string,
    state: Stored,
  ) {
    super(state, (next) => void this.flush(next));
  }

  static async load(dir: string): Promise<FileLocators> {
    let state: Stored = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, 'locators.json'), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) state = parsed as Stored;
    } catch {
      state = {};
    }
    return new FileLocators(dir, state);
  }

  private async flush(state: Stored): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, 'locators.json'), JSON.stringify(state, null, 2));
    } catch {
      // A cache that cannot be written is still a working cache for this
      // process, and losing it costs a re-typed address.
    }
  }
}

/** The four, as a headless peer supplies them. */
export async function fileLocalState(
  dir: string,
  listSpaces: () => Promise<readonly SpaceId[]>,
): Promise<LocalState> {
  return {
    keys: new FileKeyring(dir),
    inventory: new FileInventory(dir, listSpaces),
    petnames: new FilePetnames(dir),
    locators: await FileLocators.load(dir),
  };
}
