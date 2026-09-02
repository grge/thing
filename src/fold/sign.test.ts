import { describe, expect, it } from 'vitest';
import { encodeEvent } from './encode.js';
import { eventId, hex } from './hash.js';
import {
  _setWebCryptoEd25519,
  generateKeyPair,
  hasWebCryptoEd25519,
  keyPairFromSeed,
  SEED_LEN,
  signEvent,
  verifyEvent,
} from './sign.js';
import { TestWriter, uuid, writer } from './testkit.js';
import type { Event } from './types.js';
import { SIG_LEN, WRITER_LEN } from './types.js';

/** Sign an event under a key, returning the signed event. */
async function sign(e: Event, key: Awaited<ReturnType<typeof generateKeyPair>>): Promise<Event> {
  const unsigned: Event = { ...e, writer: key.publicKey };
  return { ...unsigned, sig: await signEvent(unsigned, key) };
}

/** Run a body under both backends, so neither path is left untested. */
function bothBackends(name: string, body: () => Promise<void>): void {
  it(`${name} (webcrypto)`, async () => {
    _setWebCryptoEd25519(null);
    if (!(await hasWebCryptoEd25519())) return; // not available here; noble case still runs
    _setWebCryptoEd25519(true);
    try {
      await body();
    } finally {
      _setWebCryptoEd25519(null);
    }
  });
  it(`${name} (noble)`, async () => {
    _setWebCryptoEd25519(false);
    try {
      await body();
    } finally {
      _setWebCryptoEd25519(null);
    }
  });
}

describe('signing (DESIGN.md §5)', () => {
  it('a public key is the WriterId width', async () => {
    const k = await generateKeyPair();
    expect(k.publicKey.length).toBe(WRITER_LEN);
    expect(k.privateKey.length).toBe(SEED_LEN);
  });

  bothBackends('signs and verifies a real event', async () => {
    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'notes.txt'), k);
    expect(e.sig.length).toBe(SIG_LEN);
    expect(await verifyEvent(e)).toBe(true);
  });

  bothBackends('rejects an event whose value was altered after signing', async () => {
    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'notes.txt'), k);
    const tampered: Event = { ...e, value: { t: 'string', v: 'invoice.txt' } };
    expect(await verifyEvent(tampered)).toBe(false);
  });

  bothBackends('rejects an event re-stamped with a higher lamport', async () => {
    // This is I5: without signing, a peer wins every conflict by inflating its
    // clock. With signing the inflated event no longer verifies.
    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'notes.txt'), k);
    expect(await verifyEvent({ ...e, lamport: e.lamport + 1000 })).toBe(false);
  });

  bothBackends('rejects an event claiming another writer id', async () => {
    // This is I6: a peer claiming someone else's writer id. The signature is
    // checked against the `writer` field itself, so the claim fails on its own.
    const mine = await generateKeyPair();
    const theirs = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'notes.txt'), mine);
    expect(await verifyEvent({ ...e, writer: theirs.publicKey })).toBe(false);
  });

  bothBackends('rejects a wrong-length signature without throwing', async () => {
    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'x'), k);
    expect(await verifyEvent({ ...e, sig: new Uint8Array(8) })).toBe(false);
    expect(await verifyEvent({ ...e, sig: new Uint8Array(SIG_LEN) })).toBe(false);
  });

  bothBackends('rejects a writer id that is not a valid public key', async () => {
    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'x'), k);
    // All-zero is the right width but not a point on the curve.
    expect(await verifyEvent({ ...e, writer: new Uint8Array(WRITER_LEN) })).toBe(false);
  });

  it('the signature is not part of the signing input', async () => {
    // Load-bearing: `sig` cannot be inside its own preimage, so encodeEvent —
    // and therefore EventId — must be blind to it.
    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const e = await sign(a.name(uuid('f'), 'x'), k);
    const other: Event = { ...e, sig: new Uint8Array(SIG_LEN).fill(7) };
    expect(hex(encodeEvent(e))).toBe(hex(encodeEvent(other)));
    expect(hex(await eventId(e))).toBe(hex(await eventId(other)));
  });

  it('a seed round-trips to the same public key', async () => {
    const k = await generateKeyPair();
    const again = await keyPairFromSeed(k.privateKey);
    expect(hex(again.publicKey)).toBe(hex(k.publicKey));
  });

  it('rejects a mis-sized seed rather than deriving from it', async () => {
    await expect(keyPairFromSeed(new Uint8Array(8))).rejects.toThrow(/seed must be 32 bytes/);
  });

  it('the two backends are byte-compatible in both directions', async () => {
    // This is what makes choosing a backend at runtime safe: a space signed on
    // a browser without WebCrypto Ed25519 must verify on one that has it.
    _setWebCryptoEd25519(null);
    if (!(await hasWebCryptoEd25519())) return;

    const k = await generateKeyPair();
    const a = new TestWriter(writer('alice'));
    const base: Event = { ...a.name(uuid('f'), 'shared.txt'), writer: k.publicKey };

    _setWebCryptoEd25519(true);
    const webSig = await signEvent(base, k);
    _setWebCryptoEd25519(false);
    const nobleSig = await signEvent(base, k);

    // Ed25519 is deterministic, so the same seed over the same message agrees.
    expect(hex(webSig)).toBe(hex(nobleSig));

    // And each verifies under the other backend.
    _setWebCryptoEd25519(false);
    expect(await verifyEvent({ ...base, sig: webSig })).toBe(true);
    _setWebCryptoEd25519(true);
    expect(await verifyEvent({ ...base, sig: nobleSig })).toBe(true);
    _setWebCryptoEd25519(null);
  });
});
