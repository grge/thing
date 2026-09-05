/**
 * @thing/web — the browser client.
 *
 * WebRTC transport, browser storage, and a view over folded state. A browser is
 * an ordinary peer that cannot be dialled (ARCHITECTURE.md §5.6), so it dials
 * peers with addresses and is introduced to those without.
 */

export {
  Client,
  type ClientOptions,
  type PeerKind,
  type PeerStatus,
  parseShareLink,
  type ShareLink,
  type SpaceStatus,
} from './client.js';

export { IdbStore } from './idbstore.js';
export { type Keystore, LocalKeystore } from './keystore.js';

export {
  type Signalling,
  type SignalMessage,
  type SignalPayload,
  type SignalWire,
  WebSocketSignalling,
} from './signalling.js';

export {
  connectVia,
  DEFAULT_ICE,
  type RtcConnection,
  type RtcOptions,
} from './webrtc.js';

export { acquireWriteLock, type WriteLock } from './writelock.js';
