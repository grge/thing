/**
 * Signing (DESIGN.md §5). Ed25519 over the canonical encoding.
 *
 * A space is a keypair and the public key *is* the `WriterId` (§4.1), so every
 * event carries what verifies it — there is no key distribution step and no
 * "held but unverifiable" state.
 *
 * The signature is deliberately **not** part of the signing input: `encodeEvent`
 * covers the envelope through `wall`, and `sig` travels beside it. `EventId`
 * therefore stays a hash of the same preimage it has always been, and an event's
 * identity does not depend on which of two valid signatures a writer produced
 * (Ed25519 is deterministic, but nothing here needs to rely on that).
 *
 * Two backends, chosen once at first use:
 *
 * - **WebCrypto**, when the runtime implements Ed25519. Keys stay as
 *   `CryptoKey`, and the private key never has to exist as bytes in JS.
 * - **@noble/ed25519** otherwise. Safari's Ed25519 support arrived late enough
 *   that a fallback is not optional, and NEXT.md's risk section already puts
 *   Safari squarely in scope.
 *
 * The two are byte-compatible in both directions — a signature from either
 * verifies under the other — which is what makes picking at runtime safe. That
 * property is asserted in sign.test.ts rather than assumed.
 */
import * as noble from '@noble/ed25519';
import { type Event, SIG_LEN, WRITER_LEN, type WriterId } from './types.js';
import { encodeEvent } from './encode.js';

/** An Ed25519 signature: 64 bytes. */
export type Signature = Uint8Array;

/** An Ed25519 private seed: 32 bytes. */
export const SEED_LEN = 32;

const ALG = 'Ed25519';

/**
 * A keypair. The private half is always the raw 32-byte seed, so it persists
 * and moves between devices as bytes regardless of which backend signs with it.
 */
export interface KeyPair {
  /** The public key — 32 bytes. This is the space id and the WriterId. */
  readonly publicKey: WriterId;
  /** The 32-byte seed. Extractable by design (ADDRESSING.md). */
  readonly privateKey: Uint8Array;
}

/**
 * Does this runtime's WebCrypto do Ed25519?
 *
 * Probed by actually generating a key rather than by feature-sniffing: some
 * runtimes expose the name and reject the operation. Cached — the answer cannot
 * change within a session.
 */
let webcryptoOk: Promise<boolean> | null = null;

export function hasWebCryptoEd25519(): Promise<boolean> {
  if (webcryptoOk === null) {
    webcryptoOk = (async () => {
      try {
        await globalThis.crypto.subtle.generateKey({ name: ALG }, true, ['sign', 'verify']);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return webcryptoOk;
}

/** Test seam: force a backend, or pass null to restore probing. */
export function _setWebCryptoEd25519(value: boolean | null): void {
  webcryptoOk = value === null ? null : Promise.resolve(value);
}

/**
 * Mint a space identity from a fresh 32-byte seed.
 *
 * **The seed is generated here rather than by WebCrypto's `generateKey`**, and
 * that is deliberate. Keys must be extractable (ADDRESSING.md) so the user can
 * move an identity between devices — key loss is the largest risk in this
 * design (DESIGN.md §5.3), and an identity that cannot be backed up is one that
 * is eventually lost. But WebCrypto will not export an Ed25519 *private* key as
 * `raw`; only `pkcs8` or `jwk`. Owning the seed keeps one storage format across
 * both backends and avoids parsing DER to get 32 bytes back out.
 */
export async function generateKeyPair(): Promise<KeyPair> {
  return keyPairFromSeed(noble.utils.randomSecretKey());
}

/** Rebuild a keypair from a stored seed. The inverse of what storage persists. */
export async function keyPairFromSeed(seed: Uint8Array): Promise<KeyPair> {
  if (seed.length !== SEED_LEN) {
    throw new Error(`ed25519 seed must be ${SEED_LEN} bytes, got ${seed.length}`);
  }
  return { publicKey: await noble.getPublicKeyAsync(seed), privateKey: seed };
}

/**
 * Sign an event's canonical encoding. The event's own `sig` field is ignored,
 * so an unsigned placeholder is fine to pass in.
 */
export async function signEvent(e: Event, key: KeyPair): Promise<Signature> {
  const msg = encodeEvent(e);
  if (await hasWebCryptoEd25519()) {
    const pk = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      pkcs8(key.privateKey) as unknown as BufferSource,
      { name: ALG },
      false,
      ['sign'],
    );
    const buf = await globalThis.crypto.subtle.sign({ name: ALG }, pk, msg as unknown as BufferSource);
    return new Uint8Array(buf);
  }
  return noble.signAsync(msg, key.privateKey);
}

/**
 * Wrap a raw seed as PKCS#8, the only private-key format WebCrypto imports for
 * Ed25519. The prefix is the fixed DER header for an Ed25519 PrivateKeyInfo:
 * version 0, AlgorithmIdentifier 1.3.101.112, then the seed in an OCTET STRING.
 * Constant for every Ed25519 key, so it is a literal rather than a DER encoder.
 */
const PKCS8_PREFIX = Uint8Array.of(
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
);

function pkcs8(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(PKCS8_PREFIX.length + seed.length);
  out.set(PKCS8_PREFIX, 0);
  out.set(seed, PKCS8_PREFIX.length);
  return out;
}

/**
 * Verify an event against the key that is its own `writer` field.
 *
 * Never throws — a bad signature, a malformed key and a wrong-length signature
 * are all just `false`. Callers treat unverified events as events they do not
 * have, which is the only safe reading.
 */
export async function verifyEvent(e: Event): Promise<boolean> {
  if (e.sig.length !== SIG_LEN) return false;
  if (e.writer.length !== WRITER_LEN) return false;
  const msg = encodeEvent(e);
  try {
    if (await hasWebCryptoEd25519()) {
      const pub = await globalThis.crypto.subtle.importKey(
        'raw',
        e.writer as unknown as BufferSource,
        { name: ALG },
        false,
        ['verify'],
      );
      return await globalThis.crypto.subtle.verify(
        { name: ALG },
        pub,
        e.sig as unknown as BufferSource,
        msg as unknown as BufferSource,
      );
    }
    return await noble.verifyAsync(e.sig, msg, e.writer);
  } catch {
    // A key that will not import is not a key that verifies.
    return false;
  }
}
