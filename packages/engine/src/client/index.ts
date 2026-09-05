/**
 * client — being a peer.
 *
 * One implementation of holding spaces and syncing them, with the platform
 * supplied rather than assumed. See `client.ts` for why it is one and not two.
 */
export { Client, type Held, type PeerStatus, spaceFromHello } from './client.js';
export {
  type Activity,
  type ClientCapabilities,
  type ClientObserver,
  type Connection,
  keyFromId,
  NO_LOCK,
  type PeerKind,
  type WriteLock,
  type WriterSource,
} from './types.js';
