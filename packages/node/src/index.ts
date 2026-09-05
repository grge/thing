/**
 * @thing/node — a peer outside the browser.
 *
 * A WebSocket transport in both directions, disk storage, and a CLI. Not a
 * privileged role: it speaks the same protocol as a browser tab and differs
 * only in reachability (ARCHITECTURE.md §5.6).
 */

export { FileStore } from './filestore.js';
export { Peer, type PeerOptions } from './peer.js';
export { FilePetnames } from './petnames.js';
export {
  channelFor,
  type Connection,
  dial,
  PeerServer,
  type ServerOptions,
} from './transport.js';
