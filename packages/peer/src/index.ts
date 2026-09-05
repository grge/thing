/**
 * @thing/peer — a peer: core + net + store, wired together.
 *
 * Everything a participant does that is not transport or presentation. Both
 * clients are this package plus a transport and a way to show things, which is
 * what keeps a headless peer and a browser tab the same kind of participant
 * (ARCHITECTURE.md §5.6).
 */

export {
  contentHash,
  type Entry,
  entry,
  type FileOptions,
  list,
  makeFile,
  makeFolder,
  move,
  newUuid,
  read,
  remove,
  rename,
  restore,
} from './files.js';

export { isTextual, kindForName } from './mime.js';
export { type ChangeListener, Space, type SpaceOptions } from './space.js';
