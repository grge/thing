/**
 * @thing/net — protocol, sync, blob transfer, and the ephemeral channel.
 *
 * Platform-free by construction: transports arrive through the two-method
 * `Channel` interface, so the same protocol runs over WebRTC in a browser and
 * WebSockets in Node (ARCHITECTURE.md §5.6).
 */

export {
  type BlobResult,
  BlobReceiver,
  type Channel,
  HIGH_WATER,
  LOW_WATER,
  sendBlob,
} from './blobs.js';

export {
  DEFAULT_TTL,
  EphemeralState,
  haveMessage,
  presenceMessage,
} from './ephemeral.js';

export {
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  chunkCount,
  type ChunkFrame,
  type ControlMessage,
  decodeFrame,
  encodeChunk,
  encodeControl,
  encodeEphemeral,
  type EphemeralMessage,
  type Events,
  type Forked,
  type Frame,
  type Have,
  type Hello,
  type NoBlob,
  type Presence,
  PROTOCOL_VERSION,
  TAG_CHUNK,
  TAG_CONTROL,
  TAG_EPHEMERAL,
  type Want,
  type WantBlob,
  type WireEvent,
  type WireFrontier,
  type WireVersionVector,
} from './protocol.js';

export { Session, type SessionOptions } from './session.js';

export {
  type Divergence,
  frontiersOf,
  inSync,
  PendingEvents,
  reconcile,
  type Reconciliation,
  type SendRange,
} from './sync.js';

export { fromWire, toWire, vvToWire } from './wire.js';
