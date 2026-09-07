/**
 * The browser client.
 *
 * Supplies what `@thing/engine` is handed — IndexedDB, WebRTC, a keyring — and
 * a client that opens spaces as tabs (`docs/design/MAIN-SPACE.md`).
 */
export {
  Client,
  type ClientOptions,
  parsePasted,
  parseShareLink,
  type ShareLink,
  type Tab,
} from './client.js';
export { IdbStore } from './idbstore.js';
export {
  browserLocalState,
  LocalInventory,
  LocalKeyring,
  LocalLocators,
  LocalPetnames,
} from './local.js';
export { WebSocketSignalling } from './signalling.js';
export { connectVia, type RtcConnection, type RtcOptions } from './webrtc.js';
