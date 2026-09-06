/**
 * The browser backend: one IndexedDB database per space.
 *
 * ```
 * database  thing:<space-id>
 *   events   key [chain, seq]      the log
 *   blobs    key hash              content, by its own hash
 * ```
 *
 * **A database per space rather than one shared** (ARCHITECTURE.md §2.4). A
 * single store keyed by content answers a request for bytes regardless of which
 * space the requester belongs to, so a peer would learn whether this device
 * holds given content without being able to see the space referencing it.
 * Separate databases make that leak structurally impossible rather than a rule
 * something has to remember.
 *
 * **Lives in `web` rather than in `store`.** Putting it in `store` would mean
 * widening that package's `lib` to include DOM, which would let `document` and
 * `localStorage` compile in the shared code and the Node backend too. The
 * interface and the shared chain logic stay platform-free; each backend lives
 * with the runtime it needs.
 */
import { type AppendRejection, type AppendResult, ChainSet, chainOf, type Event, type Hash, hashLarge, hex, inChainOrder, type PublicKey, type SeqRange, type SpaceId, type SpaceStore, type Store, type VersionVector } from '@thing/engine';

const EVENTS = 'events';
const BLOBS = 'blobs';

/** Promisify one IndexedDB request. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

/** Resolve once a transaction commits, so a caller can rely on durability. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
  });
}

/**
 * How an event is stored.
 *
 * Byte arrays are stored as `Uint8Array`, which IndexedDB's structured clone
 * handles natively — so unlike the file backend there is no framing to define,
 * and no second encoding that could drift from the signed one.
 */
interface StoredEvent {
  chain: string;
  seq: number;
  prev: Uint8Array | null;
  lamport: number;
  target: Uint8Array;
  attr: string;
  value: Uint8Array;
  wall: number;
  sig: Uint8Array;
  writerBytes: Uint8Array;
  pointBytes: Uint8Array;
}

function toStored(e: Event): StoredEvent {
  return {
    chain: chainOf(e),
    seq: e.seq,
    prev: e.prev,
    lamport: e.lamport,
    target: e.target,
    attr: e.attr,
    value: e.value,
    wall: e.wall,
    sig: e.sig,
    writerBytes: e.writer,
    pointBytes: e.point,
  };
}

function fromStored(s: StoredEvent): Event {
  return {
    writer: s.writerBytes,
    point: s.pointBytes,
    seq: s.seq,
    prev: s.prev,
    lamport: s.lamport,
    target: s.target,
    attr: s.attr,
    value: s.value,
    wall: s.wall,
    sig: s.sig,
  };
}

class IdbSpaceStore implements SpaceStore {
  private closed = false;

  private constructor(
    readonly space: SpaceId,
    private readonly db: IDBDatabase,
    private readonly chains: ChainSet,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  static async open(space: SpaceId, dbName: string, key: PublicKey): Promise<IdbSpaceStore> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(EVENTS)) {
          d.createObjectStore(EVENTS, { keyPath: ['chain', 'seq'] });
        }
        if (!d.objectStoreNames.contains(BLOBS)) d.createObjectStore(BLOBS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
    });

    const chains = new ChainSet(key);
    const tx = db.transaction(EVENTS, 'readonly');
    const stored = (await request(tx.objectStore(EVENTS).getAll())) as StoredEvent[];
    await chains.load(stored.map(fromStored));

    return new IdbSpaceStore(space, db, chains);
  }

  async append(events: readonly Event[]): Promise<AppendResult> {
    if (this.closed) throw new Error('store is closed');

    const appended: Event[] = [];
    const rejected: { event: Event; why: AppendRejection }[] = [];
    const admitted: Event[] = [];

    // Admission first, outside the transaction: it awaits signature
    // verification, and an IndexedDB transaction closes if it ever goes a turn
    // of the event loop without a pending request.
    for (const e of inChainOrder(events)) {
      const why = await this.chains.admit(e);
      if (why !== null) {
        rejected.push({ event: e, why });
        continue;
      }
      admitted.push(e);
      this.chains.advance(e);
    }

    if (admitted.length > 0) {
      const tx = this.db.transaction(EVENTS, 'readwrite');
      const store = tx.objectStore(EVENTS);
      for (const e of admitted) {
        store.put(toStored(e));
        appended.push(e);
      }
      await committed(tx);
    }

    return { appended, rejected };
  }

  async *readAll(): AsyncIterable<Event> {
    const tx = this.db.transaction(EVENTS, 'readonly');
    const stored = (await request(tx.objectStore(EVENTS).getAll())) as StoredEvent[];
    for (const s of stored) yield fromStored(s);
  }

  async *readRange(range: SeqRange): AsyncIterable<Event> {
    const tx = this.db.transaction(EVENTS, 'readonly');
    const to = range.to ?? Number.MAX_SAFE_INTEGER;
    // The compound key is [chain, seq], so a range over it is exactly one
    // chain in order — no scan and no sort.
    const bound = IDBKeyRange.bound([range.chain, range.from], [range.chain, to], false, true);
    const stored = (await request(tx.objectStore(EVENTS).getAll(bound))) as StoredEvent[];

    let expect = range.from;
    for (const s of stored) {
      if (s.seq !== expect) return; // a gap ends the range
      yield fromStored(s);
      expect += 1;
    }
  }

  async versionVector(): Promise<VersionVector> {
    return this.chains.versionVector();
  }

  async count(): Promise<number> {
    const tx = this.db.transaction(EVENTS, 'readonly');
    return request(tx.objectStore(EVENTS).count());
  }

  async putBlob(bytes: Uint8Array): Promise<Hash> {
    const hash = await hashLarge(bytes);
    const tx = this.db.transaction(BLOBS, 'readwrite');
    tx.objectStore(BLOBS).put(bytes, hex(hash));
    await committed(tx);
    return hash;
  }

  async getBlob(hash: Hash): Promise<Uint8Array | null> {
    const tx = this.db.transaction(BLOBS, 'readonly');
    const found = (await request(tx.objectStore(BLOBS).get(hex(hash)))) as Uint8Array | undefined;
    return found ?? null;
  }

  async hasBlob(hash: Hash): Promise<boolean> {
    const tx = this.db.transaction(BLOBS, 'readonly');
    return (await request(tx.objectStore(BLOBS).count(hex(hash)))) > 0;
  }

  async *blobHashes(): AsyncIterable<Hash> {
    const tx = this.db.transaction(BLOBS, 'readonly');
    const keys = (await request(tx.objectStore(BLOBS).getAllKeys())) as string[];
    for (const k of keys) {
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = Number.parseInt(k.slice(i * 2, i * 2 + 2), 16);
      yield out;
    }
  }

  async deleteBlob(hash: Hash): Promise<void> {
    const tx = this.db.transaction(BLOBS, 'readwrite');
    tx.objectStore(BLOBS).delete(hex(hash));
    await committed(tx);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.db.close();
  }
}

/** Spaces in IndexedDB, one database each. */
export class IdbStore implements Store {
  private readonly open_ = new Map<SpaceId, IdbSpaceStore>();

  constructor(private readonly prefix = 'thing') {}

  private dbName(space: SpaceId): string {
    return `${this.prefix}:${space}`;
  }

  async open(space: SpaceId, key: PublicKey): Promise<SpaceStore> {
    const existing = this.open_.get(space);
    if (existing !== undefined && !existing.isClosed) return existing;

    const s = await IdbSpaceStore.open(space, this.dbName(space), key);
    this.open_.set(space, s);
    return s;
  }

  async list(): Promise<readonly SpaceId[]> {
    // `databases()` is not universally available; where it is missing the
    // caller's own record of which spaces it holds is the answer, and that
    // lives above this layer.
    const names = (await indexedDB.databases?.()) ?? [];
    const prefix = `${this.prefix}:`;
    const found = names
      .map((d) => d.name)
      .filter((n): n is string => n !== undefined && n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
    return found.length > 0 ? found : [...this.open_.keys()];
  }

  async destroy(space: SpaceId): Promise<void> {
    const s = this.open_.get(space);
    if (s !== undefined) {
      await s.close();
      this.open_.delete(space);
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.dbName(space));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('indexeddb delete failed'));
      req.onblocked = () => resolve();
    });
  }

  async close(): Promise<void> {
    for (const s of this.open_.values()) await s.close();
    this.open_.clear();
  }
}
