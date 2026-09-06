/**
 * Links: an object that is a reference to another space (`docs/MAIN-SPACE.md`).
 *
 * ```
 * :kind    'link'        this object is a reference to a space
 * :body    <32 bytes>    the target's public key — a register
 * :name    'notes'       what this peer calls it
 * :parent  <uuid>        which folder it sits in, like any object
 * ```
 *
 * **The key is in the body, not an attribute.** A link *is* its target, the way
 * a file *is* its bytes. An attribute would make the key a property of some
 * other thing and leave the object bodyless, which §4.2 reserves for folders —
 * and it would break the uniformity that makes a link and a file the same
 * shape.
 *
 * **The key is an identity, never an address.** Verification is against it and
 * it never changes; where a space is *served* is said by that space's own root,
 * by peers on the ephemeral channel, and by a client-side cache — never by a
 * stored link, because a rotted address in replicated data is worse than no
 * address at all (§5.3, `docs/LOCATORS.md`).
 *
 * A client that has never heard of `link` still folds the tree, sees an object
 * with a name and an unrecognised kind, and shows it (§3.1). It simply cannot
 * follow it.
 */
import { hex, PUBLIC_KEY_LEN, type PublicKey, ROOT, type Space, type State, type Uuid } from '../index.js';
import { attr } from '../core/fold.js';
import { entry, type FileEntry, newUuid } from './files.js';

const UTF8 = new TextEncoder();

/** The `:kind` naming a link. Set once and never changed (§4.2). */
export const LINK_KIND = 'link';

/** Create a link to another space. */
export async function makeLink(
  space: Space,
  name: string,
  target: PublicKey,
  parent: Uuid = ROOT,
): Promise<Uuid> {
  if (target.length !== PUBLIC_KEY_LEN) {
    throw new Error(`a space key is ${PUBLIC_KEY_LEN} bytes, got ${target.length}`);
  }
  const id = newUuid();
  await space.write(id, ':name', UTF8.encode(name));
  await space.write(id, ':parent', parent);
  await space.write(id, ':kind', UTF8.encode(LINK_KIND));
  await space.write(id, ':body', target);
  return id;
}

/**
 * The space a link points at, or null if this object is not a link.
 *
 * Null rather than throwing for anything malformed: the fold is total (§3.4),
 * and an object claiming to be a link without a readable key is one this client
 * shows and cannot follow.
 */
export function targetOf(state: State, id: Uuid): PublicKey | null {
  const object = state.objects.get(hex(id));
  if (object === undefined) return null;
  if (attr(object, ':kind') !== LINK_KIND) return null;
  const body = object.body?.value;
  if (!(body instanceof Uint8Array) || body.length !== PUBLIC_KEY_LEN) return null;
  return body;
}

/** Whether an entry is a link. */
export function isLink(e: FileEntry): boolean {
  return e.kind === LINK_KIND;
}

/**
 * Every link in a space, with what it points at.
 *
 * Walks the whole object set rather than one folder, because "what does this
 * peer know about" is a question about the space and not about a position in
 * its tree.
 */
export function links(state: State): { entry: FileEntry; target: PublicKey }[] {
  const out: { entry: FileEntry; target: PublicKey }[] = [];
  for (const [id, object] of state.objects) {
    if (attr(object, ':kind') !== LINK_KIND) continue;
    const e = entry(state, object.uuid);
    if (e === null || e.deleted) continue;
    const target = targetOf(state, object.uuid);
    if (target !== null) out.push({ entry: e, target });
    void id;
  }
  return out.sort((a, b) => (a.entry.name < b.entry.name ? -1 : 1));
}
