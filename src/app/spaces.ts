/**
 * The open spaces (§8.3).
 *
 * All registered spaces are held open simultaneously — N logs folded, N storage
 * keyspaces, and in mode 2 up to N concurrent connections. Switching tabs
 * switches which one the panes show; it does not open or close anything.
 *
 * This matters before transport exists: a cross-space move (§8.5) writes to a
 * space that is not the visible one, so the destination must already be live.
 */
import { Space } from './space.js';
import {
  forgetSpace,
  loadSpaces,
  mintSpaceKey,
  purgeUnreferencedBlobs,
  saveSpaces,
  type SpaceMode,
  type SpaceRecord,
} from './storage.js';
import { defaultLocator, type Parsed, peerIdForCode, type SpaceId } from './address.js';
import { checkOrPin } from './pins.js';
import { hex } from '../fold/index.js';

export class Spaces {
  private open = new Map<string, Space>();

  private constructor(private records: SpaceRecord[]) {}

  /**
   * Load the registry and open every space. A first run gets one local space,
   * which is the mode 1 first-run experience (§7.1).
   */
  static async load(): Promise<Spaces> {
    let records = loadSpaces();
    if (records.length === 0) {
      records = [{ id: crypto.randomUUID(), name: 'scratch', mode: 'local' }];
      saveSpaces(records);
    }
    const spaces = new Spaces(records);
    await Promise.all(records.map((r) => spaces.openOne(r)));
    return spaces;
  }

  private async openOne(rec: SpaceRecord): Promise<void> {
    this.open.set(rec.id, await Space.open(rec));
  }

  get list(): readonly SpaceRecord[] {
    return this.records;
  }

  get(id: string): Space | null {
    return this.open.get(id) ?? null;
  }

  async create(name: string, mode: SpaceMode): Promise<SpaceRecord> {
    // A writer space *is* a keypair: its id is the public key, which is also the
    // WriterId in every event it produces (DESIGN.md §4.1). Minting the key here
    // rather than lazily in Space.open is what lets the id be the key at all —
    // the id has to exist before the record does.
    //
    // A local space never leaves the device and needs no verifiable identity,
    // so it keeps a UUID and does not burn a keypair.
    const id = mode === 'writer' ? hex((await mintSpaceKey()).publicKey) : crypto.randomUUID();
    const rec: SpaceRecord = { id, name, mode };
    this.records = [...this.records, rec];
    saveSpaces(this.records);
    await this.openOne(rec);
    return rec;
  }

  /**
   * Turn parsed share input into a joinable record (DESIGN.md §4.4).
   *
   * The two input kinds get honestly different treatment, because they carry
   * honestly different guarantees:
   *
   * - **A link** carries the key, so identity is known before contact and the
   *   locator is derived from it. Every event will be verified against it.
   * - **A typed code** carries a rendezvous hint only. There is no key yet, so
   *   there is nothing to key storage by and nothing to verify against until a
   *   peer answers and its events name a writer. `handle` records what was
   *   typed so the pin can be checked once that happens (`pins.ts`).
   *
   * Returns null for a code whose pinned key is known to have changed — the
   * caller must warn rather than silently accept a substitution.
   */
  async resolve(parsed: Parsed, petname?: string): Promise<SpaceRecord | null> {
    if (parsed.kind === 'key') {
      const locator = await defaultLocator(parsed.id);
      return {
        id: parsed.id,
        name: petname ?? (parsed.name === '' ? 'shared' : parsed.name),
        mode: 'reader',
        host: locator.address,
      };
    }
    // A typed code names a rendezvous slot, not a space. The id is not known
    // until a peer answers, so the code stands in as the storage key for now.
    return {
      id: parsed.code,
      name: petname ?? 'shared',
      mode: 'reader',
      host: peerIdForCode(parsed.code),
      handle: parsed.code,
    };
  }

  /**
   * Confirm the key a peer actually presented against what this handle resolved
   * to before (ADDRESSING.md §5.5). Called once a joined-by-code space has seen
   * events, which is the first moment its real identity is knowable.
   */
  confirmIdentity(rec: SpaceRecord, presented: SpaceId): { ok: boolean; expected?: SpaceId } {
    if (rec.handle === undefined) return { ok: true };
    const result = checkOrPin(rec.handle, presented);
    return result.ok ? { ok: true } : { ok: false, expected: result.expected };
  }

  /**
   * Adopt a space from a share URL (§7.2, §8.6). Idempotent: reopening the same
   * link finds the existing local log rather than starting from zero.
   */
  async join(rec: SpaceRecord): Promise<SpaceRecord> {
    const existing = this.records.find((r) => r.id === rec.id);
    if (existing !== undefined) return existing;
    this.records = [...this.records, rec];
    saveSpaces(this.records);
    await this.openOne(rec);
    return rec;
  }

  /**
   * Forget a space: its log, its writer identity, its registry entry.
   *
   * Then reclaim blobs nothing references any more — the store is shared across
   * spaces (§8.5), so a blob is only garbage once no *remaining* space points at
   * it. Returns how many were freed.
   */
  async forget(spaceId: string): Promise<{ blobsFreed: number }> {
    this.open.delete(spaceId);
    this.records = this.records.filter((r) => r.id !== spaceId);
    forgetSpace(spaceId);

    // Everything still referenced by a surviving space.
    const referenced = new Set<string>();
    for (const space of this.open.values()) {
      for (const obj of space.state.objects.values()) {
        if (obj.content !== null) referenced.add(hex(obj.content));
      }
    }
    const blobsFreed = await purgeUnreferencedBlobs(referenced);
    return { blobsFreed };
  }

  /**
   * Move an object to another space (§8.5).
   *
   * **This is not a `:parent` write.** Spaces share no log, no UUID space, and
   * no writer identity, so the object is recreated in the destination under a
   * new UUID, and the source is tombstoned. The UUID changes and no source
   * history follows — a real difference from an in-space move, which is one
   * attribute write (§4.1).
   *
   * The blob needs no copying: the blob store is shared across spaces and
   * content-addressed (§8.5), so the destination's `:content` hash already
   * resolves. That sharing leaks blob existence between spaces (§10.9).
   */
  async moveAcross(
    fromId: string,
    toId: string,
    uuid: Uint8Array,
    opts: { copy?: boolean } = {},
  ): Promise<void> {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (from === null || to === null) throw new Error('space not open');
    if (fromId === toId) return;

    // Asymmetric by design (§8.5): you can move *out of* a reader tab, because
    // you are only writing to the destination — but never *into* one.
    if (!to.writable) throw new Error('destination space is read-only');

    const obj = from.state.objects.get(hexOf(uuid));
    if (obj === undefined) throw new Error('object not found');

    await to.adopt(obj, from);

    // Tombstone the source only for a move, and only if we may write there.
    if (opts.copy !== true && from.writable) {
      await from.setDeleted(obj.uuid, true);
    }
  }
}

function hexOf(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

export { type SpaceMode, type SpaceRecord };
