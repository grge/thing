/**
 * Signing: the dual backend, and domain separation (ARCHITECTURE.md §2.1).
 *
 * Two properties carry real weight here. The backends must be byte-compatible,
 * or choosing one at run time would mean two clients disagreeing about whether
 * a signature is valid. And domains must not collide, or a message signed for
 * one protocol could be replayed as another.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from './bytes.js';
import { Domain } from './domain.js';
import { encodeEventBody, type EventBody, ROOT, signEvent, verifyEvent } from './event.js';
import {
  _setWebCryptoEd25519,
  generateKeyPair,
  hasWebCryptoEd25519,
  type KeyPair,
  keyPairFromSeed,
  PUBLIC_KEY_LEN,
  SEED_LEN,
  sign,
  signedBytes,
  SIGNATURE_LEN,
  verify,
} from './sign.js';
import { labelled } from './testkit.js';

afterEach(() => _setWebCryptoEd25519(null));

const SPACE = labelled('space', PUBLIC_KEY_LEN);
const MESSAGE = new TextEncoder().encode('the quick brown fox');

async function keys(): Promise<KeyPair> {
  return keyPairFromSeed(labelled('seed', SEED_LEN));
}

describe('keys', () => {
  it('derives deterministically from a seed', async () => {
    const a = await keys();
    const b = await keys();
    expect(hex(a.publicKey)).toBe(hex(b.publicKey));
    expect(a.publicKey).toHaveLength(PUBLIC_KEY_LEN);
  });

  it('keeps the private half as a raw seed, so it can be exported', async () => {
    // §5.1: a key that cannot be exported cannot be backed up or moved, and
    // WebCrypto will not export an Ed25519 private key as raw.
    const k = await keys();
    expect(k.privateKey).toHaveLength(SEED_LEN);
    expect(hex(k.privateKey)).toBe(hex(labelled('seed', SEED_LEN)));
  });

  it('generates distinct keypairs', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
  });

  it('rejects a wrong-length seed', async () => {
    await expect(keyPairFromSeed(new Uint8Array(8))).rejects.toThrow(/32 bytes/);
  });
});

describe('signing', () => {
  it('round-trips', async () => {
    const k = await keys();
    const sig = await sign(Domain.Event, MESSAGE, k);
    expect(sig).toHaveLength(SIGNATURE_LEN);
    expect(await verify(Domain.Event, MESSAGE, sig, k.publicKey)).toBe(true);
  });

  it('rejects a tampered message', async () => {
    const k = await keys();
    const sig = await sign(Domain.Event, MESSAGE, k);
    const tampered = new TextEncoder().encode('the quick brown fix');
    expect(await verify(Domain.Event, tampered, sig, k.publicKey)).toBe(false);
  });

  it('rejects another key', async () => {
    const k = await keys();
    const other = await generateKeyPair();
    const sig = await sign(Domain.Event, MESSAGE, k);
    expect(await verify(Domain.Event, MESSAGE, sig, other.publicKey)).toBe(false);
  });

  it('rejects malformed signatures and keys without throwing', async () => {
    const k = await keys();
    expect(await verify(Domain.Event, MESSAGE, new Uint8Array(10), k.publicKey)).toBe(false);
    const sig = await sign(Domain.Event, MESSAGE, k);
    expect(await verify(Domain.Event, MESSAGE, sig, new Uint8Array(10))).toBe(false);
  });
});

describe('domain separation', () => {
  it('tags the preimage, so two domains cannot produce the same bytes', () => {
    // The protection is that no preimage under one domain equals any preimage
    // under another (§2.1). With a one-byte prefix that holds by construction.
    const a = signedBytes(1 as Domain, MESSAGE);
    const b = signedBytes(2 as Domain, MESSAGE);
    expect(hex(a)).not.toBe(hex(b));
    expect(a[0]).toBe(1);
    expect(b[0]).toBe(2);
  });

  it('a signature under one domain does not verify under another', async () => {
    // This is the cross-protocol replay §2.1 exists to prevent: an ephemeral
    // message must never be presentable as a log event.
    const k = await keys();
    const sig = await sign(1 as Domain, MESSAGE, k);
    expect(await verify(1 as Domain, MESSAGE, sig, k.publicKey)).toBe(true);
    expect(await verify(2 as Domain, MESSAGE, sig, k.publicKey)).toBe(false);
  });
});

describe('backend compatibility', () => {
  it('reports whether WebCrypto is usable', async () => {
    expect(typeof (await hasWebCryptoEd25519())).toBe('boolean');
  });

  it('each backend verifies the other, in both directions', async () => {
    // What makes choosing a backend at run time safe. If this ever fails, two
    // clients on different runtimes disagree about validity — which would be
    // indistinguishable from a forgery.
    const k = await keys();

    _setWebCryptoEd25519(true);
    const webSig = await sign(Domain.Event, MESSAGE, k);

    _setWebCryptoEd25519(false);
    const nobleSig = await sign(Domain.Event, MESSAGE, k);

    // Ed25519 is deterministic, so the signatures should also be identical.
    expect(hex(webSig)).toBe(hex(nobleSig));

    expect(await verify(Domain.Event, MESSAGE, webSig, k.publicKey)).toBe(true);
    _setWebCryptoEd25519(true);
    expect(await verify(Domain.Event, MESSAGE, nobleSig, k.publicKey)).toBe(true);
  });
});

describe('event signing', () => {
  function body(over: Partial<EventBody> = {}): EventBody {
    return {
      writer: labelled('alice', PUBLIC_KEY_LEN),
      seq: 0,
      prev: null,
      lamport: 1,
      target: ROOT,
      attr: ':name',
      value: new TextEncoder().encode('hello'),
      wall: 1_700_000_000_000,
      ...over,
    };
  }

  it('signs and verifies against the writer key', async () => {
    const k = await keys();
    const e = await signEvent(SPACE, body({ writer: k.publicKey }), k);
    expect(await verifyEvent(SPACE, e)).toBe(true);
  });

  it('fails verification in a different space', async () => {
    // The replay §2.1 describes: a valid event lifted into another space must
    // not verify there, or it presents as a fork from that writer.
    const k = await keys();
    const e = await signEvent(SPACE, body({ writer: k.publicKey }), k);
    const elsewhere = labelled('other-space', PUBLIC_KEY_LEN);
    expect(await verifyEvent(elsewhere, e)).toBe(false);
  });

  it('fails verification if any field is altered', async () => {
    const k = await keys();
    const e = await signEvent(SPACE, body({ writer: k.publicKey }), k);
    expect(await verifyEvent(SPACE, { ...e, lamport: e.lamport + 1 })).toBe(false);
    expect(await verifyEvent(SPACE, { ...e, attr: ':parent' })).toBe(false);
    expect(await verifyEvent(SPACE, { ...e, wall: e.wall + 1 })).toBe(false);
  });

  it('does not sign over its own signature', async () => {
    // The preimage covers the envelope only, so an event's identity does not
    // depend on which valid signature a writer produced (§2.1).
    const k = await keys();
    const b = body({ writer: k.publicKey });
    const e = await signEvent(SPACE, b, k);
    expect(hex(encodeEventBody(SPACE, e))).toBe(hex(encodeEventBody(SPACE, b)));
  });
});
