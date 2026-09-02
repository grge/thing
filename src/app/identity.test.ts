/**
 * Space identity is the writer key (DESIGN.md §4.1).
 *
 * This is the claim that makes v1's addressing work: a writer space's id is not
 * a name *for* a key, it is the key. Everything else — read-only enforcement,
 * honest forks, verifiable links — follows from it holding.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { Spaces } = await import('./spaces.js');
const { codeForSpace, defaultLocator, isSpaceId } = await import('./address.js');
const { hex, verifyEvent } = await import('../fold/index.js');

beforeEach(() => store.clear());

describe('a writer space is a keypair', () => {
  it('its id is a public key, and events it writes carry that same key', async () => {
    const m = await Spaces.load();
    const rec = await m.create('photos', 'writer');
    expect(isSpaceId(rec.id)).toBe(true);

    const space = m.get(rec.id)!;
    const { ROOT } = await import('../fold/index.js');
    await space.createDir(ROOT, 'pics');

    expect(space.log.length).toBeGreaterThan(0);
    for (const e of space.log) {
      expect(hex(e.writer)).toBe(rec.id);
      expect(await verifyEvent(e)).toBe(true);
    }
  });

  it('two writer spaces are honestly distinct identities', async () => {
    const m = await Spaces.load();
    const a = await m.create('one', 'writer');
    const b = await m.create('two', 'writer');
    expect(a.id).not.toBe(b.id);
  });

  it('a local space keeps a UUID and does not burn a key', async () => {
    const m = await Spaces.load();
    const rec = await m.create('scratch', 'local');
    expect(isSpaceId(rec.id)).toBe(false);
  });

  it('the locator is derived from identity, and is not the identity', async () => {
    const m = await Spaces.load();
    const rec = await m.create('photos', 'writer');
    const loc = await defaultLocator(rec.id);
    // Where to look is a function of who it is — but the two are different
    // strings, which is the separation v0 did not have (DESIGN.md §4.2).
    expect(loc.address).toBe(`thing-${await codeForSpace(rec.id)}`);
    expect(loc.address).not.toContain(rec.id);
  });
});

describe('joining', () => {
  it('a link resolves to the key it carries, with a derived locator', async () => {
    const m = await Spaces.load();
    const id = (await m.create('photos', 'writer')).id;

    const rec = await m.resolve({ kind: 'key', id, name: 'photos' });
    expect(rec!.id).toBe(id);
    expect(rec!.mode).toBe('reader');
    expect(rec!.host).toBe((await defaultLocator(id)).address);
    // Nothing to pin: the key was known before contact.
    expect(rec!.handle).toBeUndefined();
  });

  it('a typed code resolves to a rendezvous, and records what to pin against', async () => {
    const m = await Spaces.load();
    const rec = await m.resolve({ kind: 'code', code: 'k7mfq2xw' });
    expect(rec!.host).toBe('thing-k7mfq2xw');
    // The identity is not known yet, so the code stands in and the handle is
    // kept for the trust-on-first-use check (ADDRESSING.md §5.5).
    expect(rec!.handle).toBe('k7mfq2xw');
  });

  it('a petname overrides the name a link suggests', async () => {
    const m = await Spaces.load();
    const id = (await m.create('photos', 'writer')).id;
    const rec = await m.resolve({ kind: 'key', id, name: 'their name' }, 'my name');
    expect(rec!.name).toBe('my name');
  });

  it('confirms identity for a code-joined space, and refuses a substitution', async () => {
    const m = await Spaces.load();
    const rec = (await m.resolve({ kind: 'code', code: 'k7mfq2xw' }))!;
    const real = 'a'.repeat(64);
    expect(m.confirmIdentity(rec, real).ok).toBe(true);
    expect(m.confirmIdentity(rec, real).ok).toBe(true);
    expect(m.confirmIdentity(rec, 'b'.repeat(64)).ok).toBe(false);
  });

  it('following a link joins the space its key names, as a reader', async () => {
    const m = await Spaces.load();
    const target = (await m.create('holiday', 'writer')).id;

    // What followLink does: resolve the link's space as a key, with the
    // linking object's name as the petname (DESIGN.md §2.1).
    const rec = await m.resolve({ kind: 'key', id: target, name: '' }, 'a friend');
    expect(rec!.id).toBe(target);
    expect(rec!.mode).toBe('reader');
    expect(rec!.name).toBe('a friend');
    // Verified by key, so nothing to pin.
    expect(rec!.handle).toBeUndefined();
  });

  it('a link-joined space has nothing to confirm', async () => {
    const m = await Spaces.load();
    const id = (await m.create('photos', 'writer')).id;
    const rec = (await m.resolve({ kind: 'key', id, name: '' }))!;
    // Verified before contact; the pin is for the typed path only.
    expect(m.confirmIdentity(rec, 'b'.repeat(64)).ok).toBe(true);
  });
});
