/**
 * An in-memory store.
 *
 * Not a third platform backend: it is what tests above this package run
 * against, and what the conformance suite checks its own expectations against.
 * Everything durable-specific — segments, transactions, eviction — is absent by
 * design, so a conformance failure here is a failure of the shared rules rather
 * than of persistence.
 */
import { chainOf, type Event, type Hash, hashLarge, hex, type PublicKey } from '../core/index.js';
import { ChainSet, inChainOrder } from './chainstate.js';
import type {
  AppendResult,
  SeqRange,
  ChainId,
  SpaceId,
  SpaceStore,
  Store,
  VersionVector,
} from './types.js';

class MemorySpaceStore implements SpaceStore {
  /** chain -> seq -> event. Append-only; nothing is ever removed. */
  private readonly events = new Map<ChainId, Map<number, Event>>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly chains: ChainSet;
  /** Serialises `append`, so no two overlap between `admit` and `advance`. */
  private appending: Promise<void> = Promise.resolve();

  constructor(
    readonly space: SpaceId,
    key: PublicKey,
  ) {
    this.chains = new ChainSet(key);
  }

  async append(events: readonly Event[]): Promise<AppendResult> {
    // Serialised for the same reason as the file store: `admit` awaits, so two
    // overlapping appends can both decide one event is new. The map keying here
    // hides the duplicate *storage*, but both callers would still be told the
    // event was appended and would refold it twice.
    const mine = this.appending.then(() => this.appendSerially(events));
    this.appending = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  private async appendSerially(events: readonly Event[]): Promise<AppendResult> {
    const appended: Event[] = [];
    const rejected: { event: Event; why: NonNullable<Awaited<ReturnType<ChainSet['admit']>>> }[] = [];

    for (const e of inChainOrder(events)) {
      const why = await this.chains.admit(e);
      if (why !== null) {
        rejected.push({ event: e, why });
        continue;
      }
      const w = chainOf(e);
      let byseq = this.events.get(w);
      if (byseq === undefined) {
        byseq = new Map();
        this.events.set(w, byseq);
      }
      byseq.set(e.seq, e);
      this.chains.advance(e);
      appended.push(e);
    }

    return { appended, rejected };
  }

  async *readAll(): AsyncIterable<Event> {
    for (const byseq of this.events.values()) {
      for (const e of byseq.values()) yield e;
    }
  }

  async *readRange(range: SeqRange): AsyncIterable<Event> {
    const byseq = this.events.get(range.chain);
    if (byseq === undefined) return;
    const to = range.to ?? Number.MAX_SAFE_INTEGER;
    for (let seq = range.from; seq < to; seq++) {
      const e = byseq.get(seq);
      if (e === undefined) return; // a gap ends the range
      yield e;
    }
  }

  async versionVector(): Promise<VersionVector> {
    return this.chains.versionVector();
  }

  async count(): Promise<number> {
    let n = 0;
    for (const byseq of this.events.values()) n += byseq.size;
    return n;
  }

  async putBlob(bytes: Uint8Array): Promise<Hash> {
    // Hashed here rather than trusted from the caller, so a mislabelled blob
    // cannot enter the store.
    const hash = await hashLarge(bytes);
    this.blobs.set(hex(hash), new Uint8Array(bytes));
    return hash;
  }

  async getBlob(hash: Hash): Promise<Uint8Array | null> {
    return this.blobs.get(hex(hash)) ?? null;
  }

  async hasBlob(hash: Hash): Promise<boolean> {
    return this.blobs.has(hex(hash));
  }

  async *blobHashes(): AsyncIterable<Hash> {
    for (const h of this.blobs.keys()) yield fromHexLocal(h);
  }

  async deleteBlob(hash: Hash): Promise<void> {
    this.blobs.delete(hex(hash));
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

function fromHexLocal(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class MemoryStore implements Store {
  private readonly spaces = new Map<SpaceId, MemorySpaceStore>();

  async open(space: SpaceId, key: PublicKey): Promise<SpaceStore> {
    let s = this.spaces.get(space);
    if (s === undefined) {
      s = new MemorySpaceStore(space, key);
      this.spaces.set(space, s);
    }
    return s;
  }

  async list(): Promise<readonly SpaceId[]> {
    return [...this.spaces.keys()];
  }

  async destroy(space: SpaceId): Promise<void> {
    this.spaces.delete(space);
  }

  async close(): Promise<void> {
    this.spaces.clear();
  }
}
