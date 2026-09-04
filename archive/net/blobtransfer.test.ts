/**
 * Stage 4: chunking, backpressure, resume, integrity (§6).
 * No PeerJS, no network — a fake channel is the whole dependency.
 */
import { describe, expect, it } from 'vitest';
import { BlobReceiver, type Channel, HIGH_WATER, LOW_WATER, sendBlob } from './blobtransfer.js';
import {
  type ChunkFrame,
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  chunkCount,
  decodeFrame,
  encodeChunkFrame,
  encodeControl,
  type Message,
} from './protocol.js';
import { hex, sha256 } from '../fold/index.js';

/**
 * A channel that records raw frames. Tests decode them, so every assertion is
 * against bytes that would really go on the wire.
 */
class FakeChannel implements Channel {
  frames: ArrayBuffer[] = [];
  bufferedAmount = 0;

  sendFrame(frame: ArrayBuffer): void {
    this.frames.push(frame);
  }

  get blobs(): ChunkFrame[] {
    const out: ChunkFrame[] = [];
    for (const f of this.frames) {
      const d = decodeFrame(f);
      if (d?.kind === 'chunk') out.push(d.chunk);
    }
    return out;
  }
}

const bytesOf = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251; // non-repeating enough to catch offset bugs
  return b;
};

/** Feed every chunk a sender produced into a receiver, in the given order. */
function deliver(ch: FakeChannel, rx: BlobReceiver, order?: number[]): void {
  const msgs = ch.blobs;
  const idx = order ?? msgs.map((_, i) => i);
  for (const i of idx) rx.accept(msgs[i]!);
}

describe('framing (§6)', () => {
  it('round-trips a control message', () => {
    const msg: Message = { type: 'WANT', hash: 'ab'.repeat(32), fromChunk: 3 };
    const d = decodeFrame(encodeControl(msg));
    expect(d?.kind).toBe('control');
    expect(d?.kind === 'control' && d.msg).toEqual(msg);
  });

  it('round-trips a chunk frame with its header intact', () => {
    const hash = 'ab'.repeat(32);
    const payload = bytesOf(500);
    const d = decodeFrame(encodeChunkFrame(hash, 7, 12, 99999, payload));
    expect(d?.kind).toBe('chunk');
    if (d?.kind !== 'chunk') return;
    expect(d.chunk.hash).toBe(hash);
    expect(d.chunk.index).toBe(7);
    expect(d.chunk.chunks).toBe(12);
    expect(d.chunk.total).toBe(99999);
    expect(d.chunk.bytes).toEqual(payload);
  });

  it('carries bytes that are not valid UTF-8', () => {
    const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc0]);
    const d = decodeFrame(encodeChunkFrame('00'.repeat(32), 0, 1, 5, payload));
    expect(d?.kind === 'chunk' && d.chunk.bytes).toEqual(payload);
  });

  it('costs only a fixed header, with no encoding expansion', () => {
    // Raw bytes, not base64: the frame is the payload plus 45 header bytes.
    const frame = encodeChunkFrame('00'.repeat(32), 0, 1, CHUNK_SIZE, bytesOf(CHUNK_SIZE));
    expect(frame.byteLength).toBe(CHUNK_SIZE + CHUNK_HEADER_BYTES);
  });

  it('distinguishes control from chunk by the tag byte alone', () => {
    const control = decodeFrame(encodeControl({ type: 'NOBLOB', hash: 'x' }));
    const chunk = decodeFrame(encodeChunkFrame('00'.repeat(32), 0, 1, 1, bytesOf(1)));
    expect(control?.kind).toBe('control');
    expect(chunk?.kind).toBe('chunk');
  });

  it('returns null for malformed input rather than throwing at a peer', () => {
    expect(decodeFrame(new Uint8Array(0).buffer)).toBeNull();
    expect(decodeFrame(new Uint8Array([0x99, 1, 2]).buffer)).toBeNull();
    expect(decodeFrame(new Uint8Array([0x02, 1, 2]).buffer)).toBeNull(); // short header
    expect(decodeFrame(new Uint8Array([0x01, 0x7b]).buffer)).toBeNull(); // bad JSON
  });
});

describe('chunking (§6)', () => {
  it('splits a blob at CHUNK_SIZE', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 3 + 100);
    const stats = await sendBlob(ch, 'h', bytes);

    expect(stats.chunks).toBe(4);
    expect(ch.blobs).toHaveLength(4);
    expect(ch.blobs[0]!.index).toBe(0);
    expect(ch.blobs[3]!.index).toBe(3);
  });

  it('sends a single chunk for a small blob', async () => {
    const ch = new FakeChannel();
    await sendBlob(ch, 'h', bytesOf(10));
    expect(ch.blobs).toHaveLength(1);
  });

  it('sends one chunk for an empty blob rather than none', async () => {
    const ch = new FakeChannel();
    await sendBlob(ch, 'h', new Uint8Array(0));
    expect(ch.blobs).toHaveLength(1);
    expect(chunkCount(0)).toBe(1);
  });

  it('carries the total length on every chunk, so progress is known early', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 2);
    await sendBlob(ch, 'h', bytes);
    for (const m of ch.blobs) expect(m.total).toBe(bytes.length);
  });
});

describe('reassembly', () => {
  it('reassembles a multi-chunk blob exactly', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 3 + 777);
    await sendBlob(ch, 'h', bytes);

    const rx = new BlobReceiver('h');
    deliver(ch, rx);
    expect(rx.complete).toBe(true);
    expect(rx.bytes()).toEqual(bytes);
  });

  it('reassembles correctly when chunks arrive out of order', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 4 + 10);
    await sendBlob(ch, 'h', bytes);

    const rx = new BlobReceiver('h');
    deliver(ch, rx, [3, 0, 4, 2, 1]);
    expect(rx.bytes()).toEqual(bytes);
  });

  it('is idempotent under duplicate chunks', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 2);
    await sendBlob(ch, 'h', bytes);

    const rx = new BlobReceiver('h');
    deliver(ch, rx, [0, 0, 1, 1, 0]);
    expect(rx.complete).toBe(true);
    expect(rx.bytes()).toEqual(bytes);
  });

  it('reports incomplete until every chunk has landed', async () => {
    const ch = new FakeChannel();
    await sendBlob(ch, 'h', bytesOf(CHUNK_SIZE * 3));

    const rx = new BlobReceiver('h');
    deliver(ch, rx, [0, 2]);
    expect(rx.complete).toBe(false);
    expect(rx.bytes()).toBeNull();
    expect(rx.received).toBe(2);
    expect(rx.total).toBe(3);
  });

  it('verifies integrity over the whole blob (§6)', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE + 500);
    const hash = hex(await sha256(bytes));
    await sendBlob(ch, hash, bytes);

    const rx = new BlobReceiver(hash);
    deliver(ch, rx);
    expect(hex(await sha256(rx.bytes()!))).toBe(hash);
  });

  it('a corrupted chunk changes the reassembled hash', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 2);
    const hash = hex(await sha256(bytes));
    await sendBlob(ch, hash, bytes);

    const rx = new BlobReceiver(hash);
    const msgs = ch.blobs;
    rx.accept(msgs[0]!);
    // Flip a byte in the second chunk.
    const bad = new Uint8Array(msgs[1]!.bytes);
    bad[0] = bad[0]! ^ 0xff;
    rx.accept({ ...msgs[1]!, bytes: bad });

    expect(rx.complete).toBe(true);
    expect(hex(await sha256(rx.bytes()!))).not.toBe(hash);
  });
});

describe('resume (§6)', () => {
  it('reports the first missing chunk as the resume point', async () => {
    const ch = new FakeChannel();
    await sendBlob(ch, 'h', bytesOf(CHUNK_SIZE * 5));

    const rx = new BlobReceiver('h');
    deliver(ch, rx, [0, 1, 2]);
    expect(rx.resumeFrom).toBe(3);
  });

  it('completes a transfer interrupted midway, without re-sending held chunks', async () => {
    const bytes = bytesOf(CHUNK_SIZE * 5 + 42);
    const hash = hex(await sha256(bytes));

    // First attempt drops after three chunks.
    const first = new FakeChannel();
    await sendBlob(first, hash, bytes);
    const rx = new BlobReceiver(hash);
    deliver(first, rx, [0, 1, 2]);
    expect(rx.complete).toBe(false);

    // Resume from where it stopped.
    const second = new FakeChannel();
    await sendBlob(second, hash, bytes, rx.resumeFrom);
    expect(second.blobs[0]!.index).toBe(3);
    expect(second.blobs).toHaveLength(3); // 3,4,5 — nothing re-sent

    deliver(second, rx);
    expect(rx.complete).toBe(true);
    expect(hex(await sha256(rx.bytes()!))).toBe(hash);
  });
});

describe('backpressure (§6)', () => {
  it('does not pause while the buffer stays below the high watermark', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = LOW_WATER;
    const stats = await sendBlob(ch, 'h', bytesOf(CHUNK_SIZE * 4));
    expect(stats.pauses).toBe(0);
  });

  it('pauses above the high watermark and resumes once drained', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = HIGH_WATER + 1;

    // A sleep that drains the buffer, standing in for the channel flushing.
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      ch.bufferedAmount = 0;
    };

    const stats = await sendBlob(ch, 'h', bytesOf(CHUNK_SIZE * 3), 0, sleep);
    expect(stats.pauses).toBeGreaterThan(0);
    expect(sleeps).toBeGreaterThan(0);
    expect(ch.blobs).toHaveLength(3); // every chunk still sent
  });

  it('sends the whole blob even when the buffer repeatedly fills', async () => {
    const ch = new FakeChannel();
    const bytes = bytesOf(CHUNK_SIZE * 6);
    const hash = hex(await sha256(bytes));

    let n = 0;
    const sleep = async (): Promise<void> => {
      ch.bufferedAmount = 0;
    };
    // Refill the buffer after every send, so backpressure engages repeatedly.
    const original = ch.sendFrame.bind(ch);
    ch.sendFrame = (m) => {
      original(m);
      n += 1;
      ch.bufferedAmount = n % 2 === 0 ? HIGH_WATER + 1 : 0;
    };

    await sendBlob(ch, hash, bytes, 0, sleep);
    const rx = new BlobReceiver(hash);
    deliver(ch, rx);
    expect(hex(await sha256(rx.bytes()!))).toBe(hash);
  });
});
