/**
 * Blob transfer over a data channel (§6).
 *
 * Chunking, backpressure, resume and integrity live here, deliberately apart
 * from PeerJS: the `Channel` interface below is the whole dependency, so this
 * is testable without a browser or a network (stage 4 of docs/PLAN.md).
 */
import {
  type ChunkFrame,
  CHUNK_SIZE,
  chunkCount,
  encodeChunkFrame,
  encodeControl,
  type Message,
} from './protocol.js';

/** The minimum a transport must provide. PeerJS's DataConnection satisfies it. */
/**
 * The whole transport dependency: send bytes, report how many are queued.
 *
 * Deliberately this small so chunking, backpressure, resume and integrity are
 * testable without a browser or a network — and so the transport underneath can
 * be replaced without touching any of them.
 */
export interface Channel {
  /** Throws if the transport rejects the frame. */
  sendFrame(frame: ArrayBuffer): void;
  /** Bytes queued but not yet sent; the backpressure signal (§6). */
  readonly bufferedAmount: number;
}

/** Convenience for control messages, which are JSON behind a tag byte. */
export function sendControl(channel: Channel, msg: Message): void {
  channel.sendFrame(encodeControl(msg));
}

/** A send that failed partway, naming the chunk it stopped on. */
export class SendFailed extends Error {
  constructor(
    readonly hash: string,
    readonly index: number,
    readonly reason: unknown,
  ) {
    super(`blob ${hash.slice(0, 8)}… failed at chunk ${index}: ${String(reason)}`);
  }
}

/**
 * Backpressure watermarks (§6). Sending is paused above HIGH and resumes below
 * LOW, so a large blob does not queue itself into an unbounded buffer.
 *
 * Untuned — §10.4 records that chunk size and retry granularity are both
 * guesses until real transfers say otherwise.
 */
export const HIGH_WATER = 1 * 1024 * 1024;
export const LOW_WATER = 256 * 1024;

/** How long to wait for the buffer to drain before checking again. */
const DRAIN_POLL_MS = 50;

export interface SendStats {
  readonly hash: string;
  readonly chunks: number;
  readonly bytes: number;
  /** How many times backpressure paused the send. Reported for question 1. */
  readonly pauses: number;
  readonly ms: number;
}

/**
 * Send a blob as chunks, pausing when the channel's buffer is full.
 *
 * `fromChunk` implements resume (§6): the receiver asks for the first index it
 * still needs, and nothing before that is re-sent.
 */
export async function sendBlob(
  channel: Channel,
  hash: string,
  bytes: Uint8Array,
  fromChunk = 0,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<SendStats> {
  const started = Date.now();
  const chunks = chunkCount(bytes.length);
  let pauses = 0;

  for (let i = fromChunk; i < chunks; i++) {
    // Wait for the buffer to drain past the low watermark before queueing more.
    if (channel.bufferedAmount > HIGH_WATER) {
      pauses += 1;
      while (channel.bufferedAmount > LOW_WATER) {
        await sleep(DRAIN_POLL_MS);
      }
    }

    const start = i * CHUNK_SIZE;
    const slice = bytes.subarray(start, Math.min(start + CHUNK_SIZE, bytes.length));
    try {
      channel.sendFrame(encodeChunkFrame(hash, i, chunks, bytes.length, slice));
    } catch (err) {
      // Stop at the first rejected chunk. Continuing would emit one error per
      // remaining chunk while sending nothing useful — the receiver already
      // cannot complete this blob.
      throw new SendFailed(hash, i, err);
    }
  }

  return { hash, chunks, bytes: bytes.length, pauses, ms: Date.now() - started };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type ReceiveState = 'receiving' | 'complete' | 'corrupt';

/**
 * Reassembles one blob from chunks.
 *
 * Chunks may arrive out of order or be re-sent; both are handled by writing at
 * the index's offset and tracking which indices have landed. Integrity is
 * verified over the whole blob before it is accepted (§6) — there are no
 * per-chunk hashes, which makes retry granularity the interesting untuned knob
 * rather than chunk size (§10.4).
 */
export class BlobReceiver {
  private buffer: Uint8Array | null = null;
  private have = new Set<number>();
  private expected = 0;
  readonly started = Date.now();

  constructor(readonly hash: string) {}

  get received(): number {
    return this.have.size;
  }

  get total(): number {
    return this.expected;
  }

  get complete(): boolean {
    return this.expected > 0 && this.have.size === this.expected;
  }

  /** The first index not yet held — where a resume should restart (§6). */
  get resumeFrom(): number {
    for (let i = 0; i < this.expected; i++) {
      if (!this.have.has(i)) return i;
    }
    return this.expected;
  }

  accept(frame: Pick<ChunkFrame, 'total' | 'index' | 'chunks' | 'bytes'>): void {
    if (this.buffer === null) {
      this.buffer = new Uint8Array(frame.total);
      this.expected = frame.chunks;
    }
    this.buffer.set(frame.bytes, frame.index * CHUNK_SIZE);
    this.have.add(frame.index);
  }

  /**
   * The reassembled bytes, or null if still incomplete. The caller must verify
   * the hash before accepting these — this class cannot, since hashing is async.
   */
  bytes(): Uint8Array | null {
    return this.complete ? this.buffer : null;
  }
}
