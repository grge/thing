/**
 * @thing/engine — a peer, with no opinion about where it runs.
 *
 * This is the program: it holds spaces, folds their logs, reconciles with other
 * peers, and tracks what is connected. Everything above the substrate and below
 * the screen.
 *
 * **It reaches for nothing.** Storage, connections, somewhere to keep keys, a
 * clock — all of it is *supplied* by whatever embeds the engine, because the
 * same code has to run in a browser tab and in a headless server, and those
 * differ in exactly those places and nowhere else. A browser supplies IndexedDB
 * and a WebSocket; a server supplies a directory and a TCP socket. Neither is a
 * lesser participant for it (ARCHITECTURE.md §5.6).
 *
 * That constraint is enforced rather than intended: this package compiles with
 * `"types": []` and an ES2022-only `lib`, so a stray `localStorage` is a
 * compile error. `platform.d.ts` declares the small surface both runtimes
 * genuinely share, and `boundary.test.ts` guards the configuration itself.
 *
 * The layering inside is a reading order, not a wall:
 *
 * | `core/`  | an event, its signature, and what a set of them means |
 * | `store/` | where events live — an interface, plus what every backend must satisfy |
 * | `net/`   | how two peers reconcile, given something that can `send` |
 * | `fs/`    | the filesystem model over the fold (§4.1) |
 * | `space.ts` | one space: a log, its folded state, and a way to write |
 * | `client/` | many spaces, and the connections that keep them in step |
 *
 * Each layer depends only on those above it.
 */

export * from './core/index.js';
export * from './store/index.js';
export * from './net/index.js';
export * from './fs/files.js';
export {
  degradations,
  isTextual,
  kindForName,
  type ParsedType,
  parseType,
} from './fs/mime.js';
export { isLink, LINK_KIND, links, makeLink, targetOf } from './fs/links.js';
export { type ChangeListener, Space, type SpaceOptions } from './space.js';
export {
  addModerator,
  addWriter,
  isModerator,
  mayWrite,
  type MembershipChange,
  MODERATORS,
  moderators,
  removeModerator,
  removeWriter,
  WRITERS,
  writers,
} from './members.js';
export {
  type Inventory,
  type Keyring,
  type LocalState,
  type LocatorCache,
} from './local.js';
export * from './client/index.js';
