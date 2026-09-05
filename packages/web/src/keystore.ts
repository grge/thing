/**
 * Where a browser keeps its keys, and what it calls its spaces.
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
import { generateKeyPair, type KeyPair, keyPairFromSeed, SEED_LEN } from '@thing/engine';

const KEY_PREFIX = 'thing:key:';
const SPACES = 'thing:spaces';
const PETNAMES = 'thing:petnames';
const LOCATORS = 'thing:locators';

export interface Keystore {
  /** Mint a space: a fresh keypair, stored. */
  mint(): Promise<KeyPair>;
  /** This browser's writing key for a space, or null for a replica. */
  keyFor(id: string): Promise<KeyPair | null>;
  /** Spaces this browser has a record of. */
  spaces(): Promise<readonly string[]>;
  /** Note that this browser holds a space, whether or not it can write. */
  remember(id: string): Promise<void>;
  /** Forget a space: its record, its key, its name. */
  forget(id: string): Promise<void>;
  /** What this browser calls a space (§5.5). Local, never replicated. */
  petname(id: string): string | null;
  setPetname(id: string, name: string): void;
  /**
   * Where a space was last reached.
   *
   * A cached locator, in §5.3's sense: **first tried, first discarded**. It is
   * stale by default and must never be the reason a space is reported gone —
   * it exists so reopening a tab does not mean pasting an address again.
   */
  locator(id: string): string | null;
  rememberLocator(id: string, url: string): void;
}

/**
 * Keys in `localStorage`.
 *
 * Synchronous and simple, which suits something read on every open. The keys
 * are small; the *spaces* live in IndexedDB, which is where size belongs.
 */
export class LocalKeystore implements Keystore {
  async mint(): Promise<KeyPair> {
    const key = await generateKeyPair();
    const id = hexOf(key.publicKey);
    localStorage.setItem(KEY_PREFIX + id, hexOf(key.privateKey));
    await this.remember(id);
    return key;
  }

  async keyFor(id: string): Promise<KeyPair | null> {
    const seed = localStorage.getItem(KEY_PREFIX + id);
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

  async spaces(): Promise<readonly string[]> {
    return this.read(SPACES);
  }

  async remember(id: string): Promise<void> {
    const all = new Set(this.read(SPACES));
    all.add(id);
    localStorage.setItem(SPACES, JSON.stringify([...all]));
  }

  async forget(id: string): Promise<void> {
    localStorage.removeItem(KEY_PREFIX + id);
    localStorage.setItem(SPACES, JSON.stringify(this.read(SPACES).filter((s) => s !== id)));
    const names = this.petnames();
    delete names[id];
    localStorage.setItem(PETNAMES, JSON.stringify(names));
    const locators = this.map(LOCATORS);
    delete locators[id];
    localStorage.setItem(LOCATORS, JSON.stringify(locators));
  }

  petname(id: string): string | null {
    return this.petnames()[id] ?? null;
  }

  locator(id: string): string | null {
    return this.map(LOCATORS)[id] ?? null;
  }

  rememberLocator(id: string, url: string): void {
    const all = this.map(LOCATORS);
    all[id] = url;
    localStorage.setItem(LOCATORS, JSON.stringify(all));
  }

  setPetname(id: string, name: string): void {
    const names = this.petnames();
    if (name === '') delete names[id];
    else names[id] = name;
    localStorage.setItem(PETNAMES, JSON.stringify(names));
  }

  /** Export a key, so an identity can be backed up or moved (§5.1.1). */
  exportKey(id: string): string | null {
    return localStorage.getItem(KEY_PREFIX + id);
  }

  private petnames(): Record<string, string> {
    return this.map(PETNAMES);
  }

  private map(key: string): Record<string, string> {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '{}');
      return typeof raw === 'object' && raw !== null ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private read(key: string): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
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
