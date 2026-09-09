/**
 * The Node backend: a directory per space, append-only.
 *
 * ```
 * <root>/<space-id>/
 *   log            length-prefixed events, appended, never rewritten
 *   blobs/<hash>   one file per blob
 * ```
 *
 * **Appending is the hot path**, because that is what a peer serving a space
 * does all day, and a segment file is trivially appendable. The previous
 * implementation of this system re-serialised its whole log on every write,
 * which made each write O(n) and put a hard ceiling on a space's lifetime.
 *
 * Reading is a full scan. That is acceptable now — the log is read on open and
 * on range requests — and it is the thing a SQLite backend would improve, along
 * with making a space a single sendable file (see docs/working/OPEN.md).
 *
 * **Lives in `node` rather than in `store`.** Putting it in `store` would mean
 * widening that package's `types` to include Node's, which would let `process`
 * and `node:fs` compile in the shared code and the browser backend too — the
 * boundary test caught exactly that. The interface and the shared chain logic
 * stay platform-free; each backend lives with the runtime it needs.
 */
import { type AppendRejection, type AppendResult, ChainSet, chainOf, decodeEvent, encodeEvent, type Event, FRAME_HEADER, type Hash, hashLarge, hex, inChainOrder, type PublicKey, type SeqRange, type SpaceId, type SpaceStore, type Store, type VersionVector } from '@thing/engine';
import { appendFile, mkdir, open as openFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

class FileSpaceStore implements SpaceStore {
  private chains: ChainSet;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  private constructor(
    readonly space: SpaceId,
    private readonly dir: string,
    key: PublicKey,
  ) {
    this.chains = new ChainSet(key);
  }

  static async open(space: SpaceId, dir: string, key: PublicKey): Promise<FileSpaceStore> {
    await mkdir(join(dir, 'blobs'), { recursive: true });
    const store = new FileSpaceStore(space, dir, key);
    // Rebuild chain state from the log. One pass on open, not per write.
    await store.chains.load(store.readAll());
    return store;
  }

  private get logPath(): string {
    return join(this.dir, 'log');
  }

  private blobPath(hash: Hash): string {
    return join(this.dir, 'blobs', hex(hash));
  }

  async append(events: readonly Event[]): Promise<AppendResult> {
    if (this.closed) throw new Error('store is closed');

    const appended: Event[] = [];
    const rejected: { event: Event; why: AppendRejection }[] = [];
    const frames: Uint8Array[] = [];

    for (const e of inChainOrder(events)) {
      const why = await this.chains.admit(e);
      if (why !== null) {
        rejected.push({ event: e, why });
        continue;
      }
      frames.push(encodeEvent(e));
      this.chains.advance(e);
      appended.push(e);
    }

    if (frames.length > 0) {
      // One write for the batch: a partial write would leave a truncated frame,
      // which `readAll` treats as the end of the log rather than as corruption.
      let total = 0;
      for (const f of frames) total += f.length;
      const buf = new Uint8Array(total);
      let at = 0;
      for (const f of frames) {
        buf.set(f, at);
        at += f.length;
      }
      await appendFile(this.logPath, buf);
    }

    return { appended, rejected };
  }

  async *readAll(): AsyncIterable<Event> {
    let handle;
    try {
      handle = await openFile(this.logPath, 'r');
    } catch {
      return; // no log yet
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const buf = new Uint8Array(size);
      await handle.read(buf, 0, size, 0);

      let at = 0;
      while (at + FRAME_HEADER <= buf.length) {
        const decoded = decodeEvent(buf, at);
        // A truncated tail means a write was interrupted. Stop rather than
        // throw: the events before it are intact and are what the log holds.
        if (decoded === null) break;
        yield decoded.event;
        at = decoded.next;
      }
    } finally {
      await handle.close();
    }
  }

  async *readRange(range: SeqRange): AsyncIterable<Event> {
    // A scan, since the log is not indexed. Collected and sorted because the
    // file is in append order, which is not seq order across chains.
    const wanted: Event[] = [];
    for await (const e of this.readAll()) {
      if (chainOf(e) !== range.chain) continue;
      if (e.seq < range.from) continue;
      if (range.to !== undefined && e.seq >= range.to) continue;
      wanted.push(e);
    }
    wanted.sort((a, b) => a.seq - b.seq);

    let expect = range.from;
    for (const e of wanted) {
      // **A repeated seq is skipped, not a stop** — the same trap as
      // `ChainSet.load`. A log may hold the same event more than once, and
      // sorting puts the copies adjacent, so `0, 0, 0, 1, ...` yielded one
      // event and returned at the second copy. The peer then received seq 0
      // and nothing else, forever, however many times it asked.
      if (e.seq < expect) continue;
      if (e.seq !== expect) return; // a genuine gap ends the range
      yield e;
      expect += 1;
    }
  }

  async versionVector(): Promise<VersionVector> {
    return this.chains.versionVector();
  }

  async count(): Promise<number> {
    let n = 0;
    for await (const _ of this.readAll()) n += 1;
    return n;
  }

  async putBlob(bytes: Uint8Array): Promise<Hash> {
    const hash = await hashLarge(bytes);
    await writeFile(this.blobPath(hash), bytes);
    return hash;
  }

  async getBlob(hash: Hash): Promise<Uint8Array | null> {
    try {
      const handle = await openFile(this.blobPath(hash), 'r');
      try {
        const { size } = await handle.stat();
        const buf = new Uint8Array(size);
        if (size > 0) await handle.read(buf, 0, size, 0);
        return buf;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  async hasBlob(hash: Hash): Promise<boolean> {
    try {
      await stat(this.blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async *blobHashes(): AsyncIterable<Hash> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, 'blobs'));
    } catch {
      return;
    }
    for (const n of names) {
      if (n.length !== 64) continue;
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = Number.parseInt(n.slice(i * 2, i * 2 + 2), 16);
      yield out;
    }
  }

  async deleteBlob(hash: Hash): Promise<void> {
    await rm(this.blobPath(hash), { force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A directory of spaces. */
export class FileStore implements Store {
  private readonly open_ = new Map<SpaceId, FileSpaceStore>();

  constructor(private readonly root: string) {}

  async open(space: SpaceId, key: PublicKey): Promise<SpaceStore> {
    // A closed space is reopened rather than handed back closed: closing is
    // about releasing this handle, not about the space ceasing to exist. The
    // reopen re-reads the log and rebuilds chain state, which is what makes a
    // duplicate still be recognised as one across a restart.
    const existing = this.open_.get(space);
    if (existing !== undefined && !existing.isClosed) return existing;

    const s = await FileSpaceStore.open(space, join(this.root, space), key);
    this.open_.set(space, s);
    return s;
  }

  async list(): Promise<readonly SpaceId[]> {
    try {
      const names = await readdir(this.root);
      // A space is a directory named by its key. Anything else in here belongs
      // to whoever chose the directory — the CLI keeps key files alongside —
      // and is not a space.
      return names.filter((n) => n.length === 64 && /^[0-9a-f]+$/.test(n));
    } catch {
      return [];
    }
  }

  async destroy(space: SpaceId): Promise<void> {
    const s = this.open_.get(space);
    if (s !== undefined) {
      await s.close();
      this.open_.delete(space);
    }
    await rm(join(this.root, space), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    for (const s of this.open_.values()) await s.close();
    this.open_.clear();
  }
}
