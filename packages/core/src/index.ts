/**
 * @thing/core — events, canonical encoding, signing, and the fold.
 *
 * No I/O, no platform. `lib` is ES2022 only (tsconfig.base.json) and `types` is
 * empty, so a stray `localStorage` or `document` reference fails to compile
 * rather than failing at run time in the headless peer.
 */

export {
  bytesEqual,
  compareBytes,
  concat,
  fromHex,
  hex,
  Writer as ByteWriter,
} from './bytes.js';

export {
  type ChainFault,
  checkChain,
  checkLink,
  compareKeys,
  greater,
  type Key,
  keyOf,
  type MaybeKey,
  maxKey,
} from './chain.js';

export { Domain } from './domain.js';

export {
  encodeEventBody,
  type Event,
  type EventBody,
  eventId,
  ROOT,
  signEvent,
  sliceKey,
  sliceKeyOf,
  type Uuid,
  UUID_LEN,
  verifyEvent,
} from './event.js';

export { hash, type Hash, HASH_LEN, hashLarge } from './hash.js';

export {
  _setWebCryptoEd25519,
  generateKeyPair,
  hasWebCryptoEd25519,
  type KeyPair,
  keyPairFromSeed,
  PUBLIC_KEY_LEN,
  type PublicKey,
  SEED_LEN,
  sign,
  signedBytes,
  type Signature,
  SIGNATURE_LEN,
  verify,
} from './sign.js';

export { resumeFrom, Writer, type WriterState } from './writer.js';
