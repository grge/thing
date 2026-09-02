/**
 * One open space: its log, its fold, and the operations the UI performs on it
 * (§7.1, §8.3).
 *
 * Every mutation follows the same shape — append events, persist, re-fold.
 * Re-folding the whole log on every change is deliberately naive; mode 2 spaces
 * are small enough to replay from event zero (§5), and an incremental fold is
 * exactly the kind of optimisation that would quietly break commutativity.
 */
import {
  checkWriterLamports,
  type Event,
  fold,
  type ObjectState,
  type Hash,
  hex,
  type Kind,
  pathOf,
  ROOT,
  sha256,
  type State,
  type Uuid,
} from '../fold/index.js';
import {
  blobCount,
  getBlob,
  loadEvents,
  loadOrMintLocalKey,
  loadSpaceKey,
  putBlob,
  saveEvents,
  type SpaceMode,
  type SpaceRecord,
} from './storage.js';
import { newUuid, Writer } from './writer.js';

export class Space {
  private events: Event[];
  private writer: Writer | null;

  state: State;

  private constructor(
    readonly record: SpaceRecord,
    events: Event[],
    writer: Writer | null,
  ) {
    this.events = events;
    this.writer = writer;
    this.state = fold(events);
  }

  static async open(record: SpaceRecord): Promise<Space> {
    const events = loadEvents(record.id);

    // A log loaded from storage is indistinguishable from one received from a
    // peer, so it gets the same check (§2.2). A violation here means LWW has
    // silently degraded to arrival order.
    try {
      checkWriterLamports(events);
    } catch (err) {
      console.error(`space ${record.id}: ${(err as Error).message}`);
    }

    // How the writer key is found differs by mode, and the difference matters:
    //
    // - `reader`: no private key at all. That is what makes it a reader
    //   (DESIGN.md §4.1), not a convention about which gestures the UI enables.
    // - `writer`: the key *is* the space id, minted at creation. If it is
    //   missing the identity is gone — mint nothing, because a fresh key would
    //   be a different space wearing this one's name. Degrade to read-only and
    //   say so; this is the key-loss case (DESIGN.md §5.4) showing up in the
    //   one place it can be detected.
    // - `local`: the id is a UUID and the key is incidental, so minting on
    //   demand is harmless.
    let writer: Writer | null = null;
    if (record.mode === 'writer') {
      const key = loadSpaceKey(record.id);
      if (key === null) {
        console.error(`space ${record.id}: writer key missing; opening read-only`);
      } else {
        writer = await Writer.resume(key, events);
      }
    } else if (record.mode === 'local') {
      writer = await Writer.resume(await loadOrMintLocalKey(record.id), events);
    }

    return new Space(record, events, writer);
  }

  /** True when this space's UI accepts write gestures (§8.6). */
  get writable(): boolean {
    return this.writer !== null;
  }

  get writerState(): { seq: number; lamport: number } | null {
    return this.writer?.state ?? null;
  }

  get writerId(): Uint8Array | null {
    return this.writer?.id ?? null;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /**
   * The raw log, in insertion order. Read-only, and for inspection only — the
   * fold must never depend on this order (§1.3).
   */
  get log(): readonly Event[] {
    return this.events;
  }

  private commit(newEvents: readonly Event[]): void {
    this.events = [...this.events, ...newEvents];
    saveEvents(this.record.id, this.events);
    this.state = fold(this.events);
  }

  private requireWriter(): Writer {
    if (this.writer === null) {
      // Reader tabs disable write gestures in the UI (§8.6); reaching here is a
      // bug, not a user error.
      throw new Error('space is read-only');
    }
    return this.writer;
  }

  /* ── Operations ──────────────────────────────────────────────────────── */

  async createDir(parent: Uuid, name: string): Promise<Uuid> {
    const w = this.requireWriter();
    const id = newUuid();
    this.commit([await w.setKind(id, 'dir'), await w.setName(id, name), await w.setParent(id, parent)]);
    return id;
  }

  /**
   * Create a file from bytes. The blob is content-addressed by SHA-256 of the
   * plaintext (§4.3, §6) and stored before the event referencing it, so the
   * fold never sees a hash whose blob this peer lacks.
   */
  async createFile(
    parent: Uuid,
    name: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<Uuid> {
    const w = this.requireWriter();
    const hash = await sha256(bytes);
    await putBlob(hash, bytes);

    const id = newUuid();
    const events = [
      await w.setKind(id, 'file'),
      await w.setName(id, name),
      await w.setParent(id, parent),
      await w.setContent(id, hash),
    ];
    // Assert the format so peers agree (§4.7). Previously the browser's MIME
    // was stored beside the blob and never replicated, so a reader disagreed
    // with the writer about what a file was (FINDINGS F10).
    if (mime !== '') events.push(await w.setType(id, mime));
    this.commit(events);
    return id;
  }

  async rename(target: Uuid, name: string): Promise<void> {
    const w = this.requireWriter();
    this.commit([await w.setName(target, name)]);
  }

  /** Re-parenting is one attribute write — that is the point of §4.1. */
  async move(target: Uuid, parent: Uuid): Promise<void> {
    const w = this.requireWriter();
    this.commit([await w.setParent(target, parent)]);
  }

  async setDeleted(target: Uuid, deleted: boolean): Promise<void> {
    const w = this.requireWriter();
    this.commit([await w.setDeleted(target, deleted)]);
  }

  /**
   * Recreate an object from another space here, under a **new UUID** (§8.5).
   *
   * Directories are adopted with their subtree, depth-first, so the structure
   * survives even though every identity in it changes. Tombstoned children are
   * skipped: they are not visible in the source and resurrecting them here
   * would be surprising.
   *
   * The blob is not copied — the store is shared and content-addressed, so the
   * `:content` hash written here already resolves (§8.5).
   */
  async adopt(obj: ObjectState, from: Space, parent: Uuid = ROOT): Promise<Uuid> {
    const w = this.requireWriter();
    const id = newUuid();

    const events: Event[] = [
      await w.setKind(id, obj.kind ?? 'file'),
      await w.setName(id, obj.name ?? 'untitled'),
      await w.setParent(id, parent),
    ];
    if (obj.content !== null) {
      events.push(await w.setContent(id, obj.content));
    }
    if (obj.pos !== null) {
      events.push(await w.setPos(id, obj.pos));
    }
    if (obj.type !== null) {
      events.push(await w.setType(id, obj.type));
    }
    this.commit(events);

    const sourceKey = hex(obj.uuid);
    for (const child of from.state.objects.values()) {
      if (child.deleted) continue;
      if (hex(child.parent) !== sourceKey) continue;
      await this.adopt(child, from, id);
    }

    return id;
  }

  /**
   * Apply events that arrived from a peer (§3.4).
   *
   * They have already passed the hold-aside buffer, so each writer's chain is
   * hole-free. Duplicates are dropped here rather than relied on being absent:
   * the fold tolerates them (§1.3) but storage should not grow for nothing.
   */
  async applyRemote(incoming: readonly Event[]): Promise<Event[]> {
    const seen = new Set<string>();
    for (const e of this.events) seen.add(`${hex(e.writer)}:${e.seq}`);

    const fresh = incoming.filter((e) => !seen.has(`${hex(e.writer)}:${e.seq}`));
    if (fresh.length === 0) return [];

    // §2.2's receive rule: a local write after this must not reuse a stamp.
    for (const e of fresh) this.writer?.observe(e.lamport);

    this.commit(fresh);
    return fresh;
  }

  /**
   * Events created locally since the given count, for broadcast (§3.4).
   * Callers track the count they last sent.
   */
  since(count: number): readonly Event[] {
    return this.events.slice(count);
  }

  /* ── Reads ───────────────────────────────────────────────────────────── */

  path(uuid: Uuid): string {
    return '/' + pathOf(this.state, uuid).join('/');
  }

  /**
   * Blob bytes. The format is an attribute of the *object* (§4.7), not of the
   * blob — the same bytes can legitimately be plain markdown in one object and
   * a todo list in another, and blobs are shared across spaces (§8.5).
   */
  async content(hash: Hash): Promise<Uint8Array | null> {
    return (await getBlob(hash))?.bytes ?? null;
  }

  async blobs(): Promise<number> {
    return blobCount();
  }
}

export { ROOT, hex, type Kind, type SpaceMode, type SpaceRecord, type Uuid };
