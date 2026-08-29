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
import { loadSpaces, saveSpaces, type SpaceMode, type SpaceRecord } from './storage.js';

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
    const rec: SpaceRecord = { id: crypto.randomUUID(), name, mode };
    this.records = [...this.records, rec];
    saveSpaces(this.records);
    await this.openOne(rec);
    return rec;
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
