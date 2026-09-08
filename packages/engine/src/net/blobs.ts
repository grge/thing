/**
 * Blob transfer (ARCHITECTURE.md §2.4).
 *
 * Chunking, backpressure, resume and whole-blob integrity. The entire transport
 * dependency is `Channel` — two methods — so all of it is testable without a
 * browser or a network, which is where the interesting cases are.
 *
 * **Integrity is whole-blob.** The reassembly is hashed before it is accepted;
 * there are no per-chunk hashes, so a transfer failing near its end is refetched
 * entirely. §2.4 records this as a deliberate limit rather than an oversight:
 * the retry frequency that would justify per-chunk hashing is unmeasured.
 */
import { hashLarge, hex } from '../core/index.js';
import { CHUNK_SIZE, chunkCount, encodeChunk } from './protocol.js';

/**
 * The whole transport dependency: send bytes, say how many are queued.
 *
 * Deliberately this small. A data channel, a WebSocket and a test double all
 * satisfy it, so nothing below has to know which it is talking to.
 */
export interface Channel {
  /** Throws if the transport rejects the frame. */
  send(frame: Uint8Array): void;
  /** Bytes queued but not yet sent — the backpressure signal. */
  readonly bufferedAmount: number;
}

/**
 * Stop sending above this, resume below it.
 *
 * A single threshold would thrash: the sender pauses, one byte drains, it sends
 * one chunk, pauses again. Two levels give the buffer room to empty.
 */
export const HIGH_WATER = 1 << 20;
export const LOW_WATER = 1 << 18;

/** Wait until the channel has drained enough to accept more. */
async function drain(channel: Channel, wait: (ms: number) => Promise<void>): Promise<void> {
  while (channel.bufferedAmount > HIGH_WATER) await wait(10);
}

/**
 * Send a blob, from `fromChunk` onwards.
 *
 * Resuming from an index rather than restarting is what makes a dropped
 * connection cost the remainder instead of the whole transfer.
 */
export async function sendBlob(
  channel: Channel,
  space: string,
  hash: Uint8Array,
  bytes: Uint8Array,
  fromChunk = 0,
  wait: (ms: number) => Promise<void> = defaultWait,
): Promise<void> {
  const hashHex = hex(hash);
  const chunks = chunkCount(bytes.length);

  for (let i = fromChunk; i < chunks; i++) {
    await drain(channel, wait);
    const start = i * CHUNK_SIZE;
    const slice = bytes.subarray(start, Math.min(start + CHUNK_SIZE, bytes.length));
    channel.send(encodeChunk(space, hashHex, i, chunks, bytes.length, slice));
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A transfer in progress. */
interface Incoming {
  readonly total: number;
  readonly chunks: number;
  readonly parts: (Uint8Array | undefined)[];
  received: number;
}

export type BlobResult =
  | { readonly kind: 'complete'; readonly hash: Uint8Array; readonly bytes: Uint8Array }
  | { readonly kind: 'corrupt'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'partial'; readonly received: number; readonly chunks: number };

/**
 * Reassembles incoming chunks.
 *
 * One instance per connection; several blobs may be in flight at once, which is
 * why chunks carry their hash rather than relying on a current transfer.
 */
export class BlobReceiver {
  private readonly incoming = new Map<string, Incoming>();

  /**
   * Take one chunk.
   *
   * Returns `complete` with verified bytes, `corrupt` if the reassembly does not
   * hash to what was asked for, or `partial` while more is expected.
   */
  async accept(chunk: {
    hash: string;
    index: number;
    chunks: number;
    total: number;
    bytes: Uint8Array;
  }): Promise<BlobResult> {
    let entry = this.incoming.get(chunk.hash);
    if (entry === undefined) {
      entry = {
        total: chunk.total,
        chunks: chunk.chunks,
        parts: new Array<Uint8Array | undefined>(chunk.chunks),
        received: 0,
      };
      this.incoming.set(chunk.hash, entry);
    }

    if (chunk.index >= entry.chunks) {
      return { kind: 'partial', received: entry.received, chunks: entry.chunks };
    }
    // A repeated chunk is not an error — a resume may overlap what was already
    // received — but it must not be counted twice.
    if (entry.parts[chunk.index] === undefined) entry.received += 1;
    entry.parts[chunk.index] = chunk.bytes;

    if (entry.received < entry.chunks) {
      return { kind: 'partial', received: entry.received, chunks: entry.chunks };
    }

    const bytes = new Uint8Array(entry.total);
    let at = 0;
    for (const part of entry.parts) {
      if (part === undefined) {
        return { kind: 'partial', received: entry.received, chunks: entry.chunks };
      }
      bytes.set(part, at);
      at += part.length;
    }

    this.incoming.delete(chunk.hash);

    // Verified before acceptance: content addressing is only worth anything if
    // the address is checked (§2.4).
    const actual = await hashLarge(bytes);
    if (hex(actual) !== chunk.hash) {
      return { kind: 'corrupt', expected: chunk.hash, actual: hex(actual) };
    }
    return { kind: 'complete', hash: actual, bytes };
  }

  /** Where a transfer should resume, so an interrupted one is not restarted. */
  resumeFrom(hash: string): number {
    const entry = this.incoming.get(hash);
    if (entry === undefined) return 0;
    for (let i = 0; i < entry.chunks; i++) {
      if (entry.parts[i] === undefined) return i;
    }
    return entry.chunks;
  }

  /** Abandon a transfer, freeing what it had buffered. */
  cancel(hash: string): void {
    this.incoming.delete(hash);
  }

  get pending(): number {
    return this.incoming.size;
  }
}
