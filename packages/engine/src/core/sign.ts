/**
 * Ed25519 keys and domain-separated signing.
 *
 * The primitive is `sign(domain, preimage, key)` rather than `signEvent`,
 * because a key signs more than one kind of thing: log events now, ephemeral
 * channel messages later (ARCHITECTURE.md §10.2). Building an event's preimage
 * is one caller's job, not this module's.
 *
 * **Two backends, chosen once at first use.** WebCrypto where the runtime does
 * Ed25519; `@noble/ed25519` otherwise, because platform support arrived late
 * enough that a fallback is not optional. They are byte-compatible in both
 * directions — either verifies the other's signatures — which is what makes
 * choosing at run time safe, and is asserted in `sign.test.ts` rather than
 * assumed.
 *
 * **The private key is always the raw 32-byte seed.** A seed persists and moves
 * between devices as bytes regardless of which backend signs with it, and
 * WebCrypto will not export an Ed25519 private key as `raw` — so owning the seed
 * is what keeps a key genuinely extractable (§5.1), which the design requires.
 */
import * as noble from '@noble/ed25519';
import { concat } from './bytes.js';
import type { Domain } from './domain.js';

/** An Ed25519 public key: 32 bytes. Also a writer's identity, and a space's. */
export type PublicKey = Uint8Array;

/** An Ed25519 signature: 64 bytes. */
export type Signature = Uint8Array;

export const PUBLIC_KEY_LEN = 32;
export const SIGNATURE_LEN = 64;
export const SEED_LEN = 32;

const ALG = 'Ed25519';

/**
 * A keypair. The private half is the seed, never a platform key object, so it
 * can be exported, backed up and moved (§5.1.1).
 */
export interface KeyPair {
  readonly publicKey: PublicKey;
  readonly privateKey: Uint8Array;
}

/* ── backend selection ──────────────────────────────────────────────────── */

/**
 * WebCrypto's subtle interface, or undefined.
 *
 * `crypto` is declared in platform.d.ts as possibly absent, because this package
 * compiles without DOM or Node typings and must run in both. Narrowing once here
 * keeps the assertion out of every call site.
 */
function subtleOrNull(): SubtleCrypto | null {
  return crypto?.subtle ?? null;
}

let webcryptoOk: Promise<boolean> | null = null;

/**
 * Does this runtime's WebCrypto do Ed25519?
 *
 * Probed by generating a key rather than by feature-sniffing, because some
 * runtimes expose the algorithm name and then reject the operation. Cached: the
 * answer cannot change within a session.
 */
export function hasWebCryptoEd25519(): Promise<boolean> {
  if (webcryptoOk === null) {
    webcryptoOk = (async () => {
      const subtle = subtleOrNull();
      if (subtle === null) return false;
      try {
        await subtle.generateKey({ name: ALG }, true, ['sign', 'verify']);
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

/* ── keys ───────────────────────────────────────────────────────────────── */

/**
 * A fresh keypair.
 *
 * The seed is generated here rather than by `subtle.generateKey`, so that both
 * backends produce the same shape and the seed is available as bytes. See the
 * module note on extractability.
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const seed = new Uint8Array(SEED_LEN);
  if (crypto === undefined) throw new Error('no crypto.getRandomValues in this runtime');
  crypto.getRandomValues(seed);
  return keyPairFromSeed(seed);
}

export async function keyPairFromSeed(seed: Uint8Array): Promise<KeyPair> {
  if (seed.length !== SEED_LEN) {
    throw new Error(`seed must be ${SEED_LEN} bytes, got ${seed.length}`);
  }
  const publicKey = await noble.getPublicKeyAsync(seed);
  return { publicKey, privateKey: new Uint8Array(seed) };
}

/* ── signing ────────────────────────────────────────────────────────────── */

/**
 * The bytes actually signed: the domain tag, then the caller's preimage.
 *
 * Exported because verification needs the same construction, and because a test
 * asserting that two domains cannot collide needs to see it.
 */
export function signedBytes(domain: Domain, preimage: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(domain), preimage]);
}

/**
 * Sign `preimage` under `domain`.
 *
 * The domain tag is prepended here rather than by the caller, so a caller
 * cannot forget it — which is the whole protection (§2.1).
 */
export async function sign(
  domain: Domain,
  preimage: Uint8Array,
  key: KeyPair,
): Promise<Signature> {
  const message = signedBytes(domain, preimage);

  const subtle = subtleOrNull();
  if (subtle !== null && (await hasWebCryptoEd25519())) {
    const pkcs8 = pkcs8FromSeed(key.privateKey);
    const cryptoKey = await subtle.importKey('pkcs8', pkcs8, { name: ALG }, false, ['sign']);
    return new Uint8Array(await subtle.sign(ALG, cryptoKey, message));
  }

  return noble.signAsync(message, key.privateKey);
}

/** Verify a signature made by `sign` under the same domain. */
export async function verify(
  domain: Domain,
  preimage: Uint8Array,
  signature: Signature,
  publicKey: PublicKey,
): Promise<boolean> {
  if (signature.length !== SIGNATURE_LEN) return false;
  if (publicKey.length !== PUBLIC_KEY_LEN) return false;

  const message = signedBytes(domain, preimage);

  const subtle = subtleOrNull();
  if (subtle !== null && (await hasWebCryptoEd25519())) {
    try {
      const cryptoKey = await subtle.importKey('raw', publicKey, { name: ALG }, false, ['verify']);
      return await subtle.verify(ALG, cryptoKey, signature, message);
    } catch {
      return false;
    }
  }

  try {
    return await noble.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Wrap a raw seed as PKCS#8, which is the only private-key format WebCrypto
 * will import for Ed25519. A fixed 16-byte prefix; nothing here varies.
 */
const PKCS8_PREFIX = Uint8Array.of(
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
);

function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  return concat([PKCS8_PREFIX, seed]);
}
