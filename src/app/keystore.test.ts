/**
 * Key persistence (DESIGN.md §5). Keys are extractable on purpose
 * (ADDRESSING.md): an identity that cannot be exported cannot be backed up, and
 * key loss is the largest risk in this design (§5.3).
 */
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * A localStorage stand-in. Nothing else in src/app tests needs one, so this is
 * local rather than a global test environment — the storage module only uses
 * getItem/setItem/clear.
 */
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;
import { hex, keyPairFromSeed, SEED_LEN, verifyEvent, WRITER_LEN } from '../fold/index.js';
import { loadOrMintLocalKey, loadSpaceKey, mintSpaceKey } from './storage.js';
import { newUuid, Writer } from './writer.js';

beforeEach(() => localStorage.clear());

describe('space keys', () => {
  it('mints a key of the right shape and keeps it across loads', async () => {
    const first = await loadOrMintLocalKey('s1');
    expect(first.publicKey.length).toBe(WRITER_LEN);
    expect(first.privateKey.length).toBe(SEED_LEN);

    const again = await loadOrMintLocalKey('s1');
    expect(hex(again.publicKey)).toBe(hex(first.publicKey));
    expect(hex(again.privateKey)).toBe(hex(first.privateKey));
  });

  it('gives different spaces different identities', async () => {
    const a = await loadOrMintLocalKey('s1');
    const b = await loadOrMintLocalKey('s2');
    expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
  });

  it('the stored seed is enough to rebuild a working signer', async () => {
    // This is what "extractable" has to mean in practice: the bytes on disk can
    // be carried to another device and still sign for the same identity.
    const minted = await loadOrMintLocalKey('s1');
    const restored = await keyPairFromSeed(minted.privateKey);
    expect(hex(restored.publicKey)).toBe(hex(minted.publicKey));

    const w = await Writer.resume(restored, []);
    const e = await w.setName(newUuid(), 'from-another-device.txt');
    expect(await verifyEvent(e)).toBe(true);
    expect(hex(e.writer)).toBe(hex(minted.publicKey));
  });

  it('a minted space key is stored under its own public key', async () => {
    // For a writer space the id *is* the key, so this is what makes the record
    // and the keystore agree without a second identifier (DESIGN.md §4.1).
    const kp = await mintSpaceKey();
    const found = loadSpaceKey(hex(kp.publicKey));
    expect(found).not.toBeNull();
    expect(hex(found!.privateKey)).toBe(hex(kp.privateKey));
  });

  it('a space with no stored key returns null rather than minting one', () => {
    // A writer space whose key is gone must not silently get a fresh identity —
    // that would be a different space wearing the old one's name.
    expect(loadSpaceKey('deadbeef')).toBeNull();
  });

  it('persists as plain hex, so an export path is possible at all', async () => {
    const k = await loadOrMintLocalKey('s1');
    const raw = localStorage.getItem('thing:writer:s1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { pk: string; sk: string };
    expect(parsed.pk).toBe(hex(k.publicKey));
    expect(parsed.sk).toBe(hex(k.privateKey));
  });
});
