/**
 * A browser's local state: keys, inventory, petnames, locators.
 *
 * These were one class — `LocalKeystore` — implementing one `Keystore`
 * interface. They are four here because the engine now names them separately
 * (`engine/local.ts`), and the reason is not tidiness: **three of them can be
 * replicated to another client and the fourth must never be.** A secret and a
 * stale-by-default cache had been sharing a storage backend, a lifetime and a
 * backup story, and should share none of those.
 *
 * All four sit in `localStorage`, which suits things read on every open: keys
 * are small, and the *spaces* live in IndexedDB where size belongs.
 *
 * **Keys are stored as raw seeds and are extractable by design** (§5.1). The
 * tempting alternative is a non-extractable platform key, on the grounds that
 * injected script could not then steal it — but such a key can still be *used*
 * by injected script to sign anything, so it is not protected, only
 * unstealable. Meanwhile the cost is total: no backup, and no way to move an
 * identity to another device.
 *
 * **This is the largest unresolved risk in the design** (§5.1.1). Clearing site
 * data destroys the ability to write to your own space, permanently, with no
 * recovery and no way to tell readers. Nothing here solves that; what it does
 * is keep the key in a form a person could export, which is the precondition
 * for any answer.
 */
import {
  generateKeyPair,
  type Inventory,
  type KeyPair,
  keyPairFromSeed,
  type Keyring,
  type LocalState,
  type LocatorCache,
  type PetnameStore,
  SEED_LEN,
} from '@thing/engine';

const KEY_PREFIX = 'thing:key:';
const SPACES = 'thing:spaces';
const PETNAMES = 'thing:petnames';
const LOCATORS = 'thing:locators';
const SETTINGS = 'thing:settings';

/**
 * What this browser has been configured to do (`docs/WEB.md`, stage 8).
 *
 * Local, like everything else here, and for the same reason: it is about this
 * client rather than any space, so it is in no log and replicates nowhere.
 * Absent fields mean "use the default" rather than "empty" — the difference
 * matters for ICE, where an empty list is a legitimate choice (no STUN, local
 * network only) and must not be confused with never having been set.
 */
export interface Settings {
  /** Where to meet peers by short code (§5.4). Absent uses the build default. */
  readonly signallingUrl?: string;
  /** STUN/TURN servers. Absent uses the default; empty is a real choice. */
  readonly iceServers?: readonly RTCIceServer[];
}

export function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Settings;
  } catch {
    // Unreadable settings are settings this browser does not have. Failing to
    // start because a preference is corrupt would be the worse outcome.
    return {};
  }
}

export function writeSettings(next: Settings): void {
  localStorage.setItem(SETTINGS, JSON.stringify(next));
}

export class LocalKeyring implements Keyring {
  async mint(): Promise<KeyPair> {
    const key = await generateKeyPair();
    localStorage.setItem(KEY_PREFIX + hexOf(key.publicKey), hexOf(key.privateKey));
    return key;
  }

  async mintFor(space: string): Promise<KeyPair> {
    // Idempotent, and deliberately so: this is also what protects a client's
    // *own* space, where the key filed under the space id is the space's
    // identity and replacing it would be §5.1.1's unrecoverable loss.
    const existing = await this.keyFor(space);
    if (existing !== null) return existing;

    const key = await generateKeyPair();
    // Filed under the space it is *for*, not under its own public key: this is
    // an identity within someone else's space, not a space of its own.
    localStorage.setItem(KEY_PREFIX + space, hexOf(key.privateKey));
    return key;
  }

  async keyFor(space: string): Promise<KeyPair | null> {
    const seed = localStorage.getItem(KEY_PREFIX + space);
    if (seed === null) return null;
    try {
      const bytes = fromHex(seed);
      if (bytes.length !== SEED_LEN) return null;
      return await keyPairFromSeed(bytes);
    } catch {
      // A key that cannot be read is a key this browser does not have. §5.1.1:
      // the space opens read-only rather than minting a replacement, because a
      // fresh key would be a different space wearing the old one's name.
      return null;
    }
  }

  async forget(space: string): Promise<void> {
    localStorage.removeItem(KEY_PREFIX + space);
  }

  /**
   * Export a key, so an identity can be backed up or moved (§5.1.1).
   *
   * Not part of `Keyring`: it is the one operation that deliberately hands a
   * secret to a caller, so it stays a property of *this* backend rather than
   * something every implementation is obliged to offer.
   */
  exportKey(space: string): string | null {
    return localStorage.getItem(KEY_PREFIX + space);
  }
}

export class LocalInventory implements Inventory {
  async all(): Promise<readonly string[]> {
    return read(SPACES);
  }

  async remember(space: string): Promise<void> {
    const held = read(SPACES);
    if (!held.includes(space)) localStorage.setItem(SPACES, JSON.stringify([...held, space]));
  }

  async forget(space: string): Promise<void> {
    localStorage.setItem(SPACES, JSON.stringify(read(SPACES).filter((s) => s !== space)));
  }
}

/**
 * Petnames, keyed name → space, matching the engine's contract.
 *
 * The browser's old interface was the other way round — `petname(id)` — and a
 * view still wants that direction. `nameFor` provides it over the same store
 * rather than keeping a second map, which is what would drift.
 */
export class LocalPetnames implements PetnameStore {
  async all(): Promise<ReadonlyMap<string, string>> {
    return new Map(Object.entries(map(PETNAMES)));
  }

  /**
   * Give a space a name, taking it from whatever held it.
   *
   * The store is keyed by *name*, so one name points at one space — that is
   * the contract (`PetnameStore` in the engine), and it means naming a second
   * space `notes` moves the name rather than duplicating it. Dropping the old
   * space's entry is what keeps `nameFor` honest: without it, that space would
   * still report a name that now belongs to something else.
   *
   * A caller that does not want to take a name should ask `available` first.
   */
  async set(name: string, space: string): Promise<void> {
    const names = map(PETNAMES);
    for (const [existing, id] of Object.entries(names)) {
      if (id === space && existing !== name) delete names[existing];
    }
    names[name] = space;
    localStorage.setItem(PETNAMES, JSON.stringify(names));
  }

  /** Whether a name is free, or already this space's own. */
  available(name: string, space: string): boolean {
    const held = map(PETNAMES)[name];
    return held === undefined || held === space;
  }

  /** `name`, `name 2`, `name 3` — the first that is free. */
  free(name: string, space: string): string {
    if (this.available(name, space)) return name;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${name} ${n}`;
      if (this.available(candidate, space)) return candidate;
    }
    return `${name} ${space.slice(0, 6)}`;
  }

  async remove(name: string): Promise<void> {
    const names = map(PETNAMES);
    delete names[name];
    localStorage.setItem(PETNAMES, JSON.stringify(names));
  }

  /** What this browser calls a space, if anything. The view's direction. */
  nameFor(space: string): string | null {
    for (const [name, id] of Object.entries(map(PETNAMES))) if (id === space) return name;
    return null;
  }
}

export class LocalLocators implements LocatorCache {
  get(space: string): string | null {
    return map(LOCATORS)[space] ?? null;
  }

  set(space: string, url: string): void {
    const all = map(LOCATORS);
    all[space] = url;
    localStorage.setItem(LOCATORS, JSON.stringify(all));
  }

  forget(space: string): void {
    const all = map(LOCATORS);
    delete all[space];
    localStorage.setItem(LOCATORS, JSON.stringify(all));
  }
}

/** The four, as a browser supplies them. */
export function browserLocalState(): LocalState & { keys: LocalKeyring; petnames: LocalPetnames } {
  return {
    keys: new LocalKeyring(),
    inventory: new LocalInventory(),
    petnames: new LocalPetnames(),
    locators: new LocalLocators(),
  };
}

function map(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
