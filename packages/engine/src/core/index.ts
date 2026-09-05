/**
 * core — an event, and what a set of them means.
 *
 * The data model and the fold: canonical encoding, domain-separated signing,
 * chain rules, and the merge that turns a set of events into state. Pure
 * computation — nothing here reads, writes, or connects to anything.
 */

export {
  bytesEqual,
  compareBytes,
  concat,
  fromHex,
  hex,
  Writer as ByteWriter,
} from './bytes.js';

export { CODE_ALPHABET, CODE_LENGTH, codeFor, isCode } from './code.js';

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

export {
  attr,
  BODY_ATTR,
  childrenOf,
  fold,
  type FoldOptions,
  KIND_ATTR,
  type ObjectState,
  PARENT_ATTR,
  pathOf,
  type Resolved,
  resolveParents,
  type SliceState,
  type State,
  writerSetFrom,
} from './fold.js';

export { Folder } from './incremental.js';

export { hash, type Hash, HASH_LEN, hashLarge } from './hash.js';

export {
  type Acc,
  type Codec,
  type Entry,
  foldSlice,
  type Merge,
  type Rule,
} from './rule.js';

export {
  ATTRIBUTE_RULES,
  attributeRule,
  blob,
  BODY_RULES,
  bodyRule,
  bytesRegister,
  flag,
  type FlagAcc,
  type RegisterAcc,
  stringRegister,
} from './rules.js';

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
