/**
 * The headless peer: disk, sockets, and a command line.
 *
 * Supplies what `@thing/engine` is handed — a `Store` over files, a WebSocket
 * transport, a keyring — and wires them into a peer that holds one space and
 * serves it (`docs/design/MAIN-SPACE.md`).
 */
export { FileStore } from './filestore.js';
export { FileInventory, FileKeyring, FileLocators, fileLocalState } from './local.js';
export { FilePetnames } from './petnames.js';
export { createSpace, Server, type ServerOptions } from './server.js';
export { channelFor, type Connection, dial, PeerServer } from './transport.js';
