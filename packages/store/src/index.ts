/**
 * @thing/store — the storage interface, with browser and Node backends.
 *
 * One interface, two platform backends, one conformance suite. Storage is the
 * only genuinely platform-bound layer: `core` and `net` compile with no DOM and
 * no Node types, so this is where a browser and a headless peer diverge.
 *
 * Backends live in their own entry points, because importing this one must not
 * drag a platform dependency in:
 *
 * Backends live with the runtime they need, not here: the Node one in
 * `@thing/node`, the browser one in `@thing/web`. This package stays
 * platform-free so both can depend on it.
 */

export { ChainSet, type ChainState, emptyChain, inChainOrder } from './chainstate.js';
export { decodeEvent, encodeEvent, FRAME_HEADER } from './framing.js';
export { conformanceTests } from './conformance.js';
export { MemoryStore } from './memory.js';
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
