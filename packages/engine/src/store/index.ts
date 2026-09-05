/**
 * store — where events live.
 *
 * An interface and what every backend must satisfy, not a database. Storage is
 * the one layer where a browser and a server genuinely differ, so the engine
 * names what it needs and is handed an implementation: a directory of
 * append-only segments in a server, IndexedDB in a browser.
 *
 * `conformanceTests` is the contract in executable form — 22 cases every
 * backend runs, so "it stores events" means the same thing in both. A new
 * backend (SQLite, say) is correct when it passes them, and needs no other
 * argument.
 */

export { ChainSet, type ChainState, emptyChain, inChainOrder } from './chainstate.js';
export { decodeEvent, encodeEvent, FRAME_HEADER } from './framing.js';
export { conformanceTests } from './conformance.js';
export { MemoryStore } from './memory.js';
export {
  namesFor,
  type PetnameStore,
  type Resolution,
  type ResolveFailure,
  resolveName,
  type SpaceNames,
} from './naming.js';
export type {
  AppendRejection,
  AppendResult,
  SeqRange,
  SpaceId,
  SpaceStore,
  Store,
  VersionVector,
  WriterFrontier,
  WriterId,
} from './types.js';
