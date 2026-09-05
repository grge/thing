/**
 * Writing a filesystem into a space.
 *
 * Convenience over `Space.write`, and deliberately thin: creating a file is
 * four ordinary attribute writes plus a blob, and nothing here is privileged.
 * The filesystem is the structural model every space already has
 * (ARCHITECTURE.md §4.1), not an application layered on top — so this is a
 * helper, not a subsystem.
 */
import { attr, childrenOf, type Hash, hex, type ObjectState, ROOT, type State, type Uuid, UUID_LEN } from '@thing/core';
import { kindForName } from './mime.js';
import type { Space } from './space.js';

const UTF8 = new TextEncoder();

/**
 * A fresh object identity.
 *
 * Random, never reused (§2.1). Uses the platform CSPRNG because a collision
 * would silently merge two objects — the same reason the identity is 16 bytes
 * rather than a counter that two writers could both increment.
 */
export function newUuid(): Uuid {
  const out = new Uint8Array(UUID_LEN);
  if (crypto === undefined) throw new Error('no crypto.getRandomValues in this runtime');
  crypto.getRandomValues(out);
  return out;
}

export interface FileOptions {
  readonly parent?: Uuid;
  /** A media type. Names the blob rule *and* tells a view what the bytes are. */
  readonly kind?: string;
}

/** Create a folder: a named object with no body. */
export async function makeFolder(
  space: Space,
  name: string,
  parent: Uuid = ROOT,
): Promise<Uuid> {
  const id = newUuid();
  await space.write(id, ':name', UTF8.encode(name));
  await space.write(id, ':parent', parent);
  return id;
}

/**
 * Create a file: a named object whose body is a blob hash.
 *
 * The bytes go to the blob store and the log carries only the hash, because
 * events replicate to everyone while blobs are fetched by whoever wants them
 * (§2.4).
 */
export async function makeFile(
  space: Space,
  name: string,
  content: Uint8Array,
  options: FileOptions = {},
): Promise<{ id: Uuid; hash: Hash }> {
  const id = newUuid();
  const hash = await space.putBlob(content);

  await space.write(id, ':name', UTF8.encode(name));
  await space.write(id, ':parent', options.parent ?? ROOT);
  // A guess from the name beats `application/octet-stream` on every file: a
  // caller that knows better passes `kind`, and a browser always does.
  await space.write(id, ':kind', UTF8.encode(options.kind ?? kindForName(name)));
  await space.write(id, ':body', hash);

  return { id, hash };
}

/** Rename. An ordinary register write. */
export async function rename(space: Space, id: Uuid, name: string): Promise<void> {
  await space.write(id, ':name', UTF8.encode(name));
}

/** Move. Also an ordinary register write — the tree is derived, not stored. */
export async function move(space: Space, id: Uuid, parent: Uuid): Promise<void> {
  await space.write(id, ':parent', parent);
}

/**
 * Delete: a tombstone, not a removal.
 *
 * Events are never deleted (§2.1). The object stays in the log and in the fold,
 * flagged, which is what makes undelete an ordinary write rather than a
 * recovery procedure.
 */
export async function remove(space: Space, id: Uuid): Promise<void> {
  await space.write(id, ':deleted', Uint8Array.of(1));
}

export async function restore(space: Space, id: Uuid): Promise<void> {
  await space.write(id, ':deleted', Uint8Array.of(0));
}

/* ── reading ────────────────────────────────────────────────────────────── */

export interface Entry {
  readonly id: Uuid;
  readonly name: string;
  readonly kind: string | null;
  readonly deleted: boolean;
  readonly isFolder: boolean;
  readonly object: ObjectState;
}

function entryOf(o: ObjectState): Entry {
  const name = attr(o, ':name');
  const kind = attr(o, ':kind');
  return {
    id: o.uuid,
    name: typeof name === 'string' ? name : '(unnamed)',
    kind: typeof kind === 'string' ? kind : null,
    deleted: attr(o, ':deleted') === true,
    // A folder is an object with no body — not a declared type. `:kind` is
    // advisory (§4.2) and a body's absence is the only structural signal.
    isFolder: o.body === undefined && o.bodyRuleMissing === undefined,
    object: o,
  };
}

/** Children of a folder, tombstones excluded unless asked for. */
export function list(
  state: State,
  parent: Uuid = ROOT,
  options: { readonly includeDeleted?: boolean } = {},
): Entry[] {
  return childrenOf(state, parent)
    .map(entryOf)
    .filter((e) => options.includeDeleted === true || !e.deleted)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One entry by id, or null. */
export function entry(state: State, id: Uuid): Entry | null {
  const o = state.objects.get(hex(id));
  return o === undefined ? null : entryOf(o);
}

/** The blob hash an object's body names, or null if it has no blob body. */
export function contentHash(state: State, id: Uuid): Hash | null {
  const o = state.objects.get(hex(id));
  const value = o?.body?.value;
  return value instanceof Uint8Array ? value : null;
}

/** Read a file's bytes, or null if the blob is not held locally. */
export async function read(space: Space, id: Uuid): Promise<Uint8Array | null> {
  const hash = contentHash(space.state, id);
  return hash === null ? null : space.getBlob(hash);
}
