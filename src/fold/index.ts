/**
 * The fold (§1–§4). Pure: no networking, no storage, no browser APIs beyond
 * WebCrypto for hashing. Stage 1 of docs/PLAN.md.
 */
export { encodeEvent } from './encode.js';
export { fold, pathOf } from './fold.js';
export { bytesEqual, compareBytes, eventId, fromHex, hex, sha256 } from './hash.js';
export { compareKeys, greater, type Key, keyOf, type MaybeKey, maxKey } from './key.js';
export {
  generateKeyPair,
  hasWebCryptoEd25519,
  type KeyPair,
  keyPairFromSeed,
  SEED_LEN,
  type Signature,
  signEvent,
  verifyEvent,
  _setWebCryptoEd25519,
} from './sign.js';
export type { ObjectState, State } from './state.js';
export {
  type AttrName,
  CONTENT_HASH_LEN,
  type Event,
  type Hash,
  type Kind,
  type Link,
  type Pos,
  ROOT,
  SHORT_HASH_LEN,
  SIG_LEN,
  type Uuid,
  UUID_LEN,
  type Value,
  WRITER_LEN,
  type WriterId,
} from './types.js';
export { checkWriterLamports, InvalidEvent, validateEvent } from './validate.js';
