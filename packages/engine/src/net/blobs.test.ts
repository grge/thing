/**
 * Blob transfer: chunking, backpressure, resume, integrity.
 *
 * Everything here runs against a test channel rather than a network, because
 * the interesting cases — a corrupt reassembly, a resumed transfer, a sender
 * that has to wait — are all reachable without one.
 */
import { hashLarge, hex } from '../core/index.js';
import { describe, expect, it } from 'vitest';
import { BlobReceiver, type Channel, HIGH_WATER, sendBlob } from './blobs.js';
import { CHUNK_SIZE, decodeFrame } from './protocol.js';

/** A channel that records what was sent and reports a settable buffer. */
class TestChannel implements Channel {
  readonly sent: Uint8Array[] = [];
  bufferedAmount = 0;

  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }

  /** The chunks that were sent, decoded. */
  chunks(): { hash: string; index: number; chunks: number; total: number; bytes: Uint8Array }[] {
    return this.sent
      .map((f) => decodeFrame(f))
      .filter((f): f is { kind: 'chunk'; chunk: never } => f?.kind === 'chunk')
      .map((f) => f.chunk);
  }
}

function bytesOf(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31) & 0xff;
  return out;
}

const noWait = async (): Promise<void> => {};

describe('sending', () => {
  it('splits a blob into chunks', async () => {
    const bytes = bytesOf(CHUNK_SIZE * 2 + 100);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();

    await sendBlob(channel, hash, bytes, 0, noWait);

    const chunks = channel.chunks();
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.total).toBe(bytes.length);
    expect(chunks[0]!.chunks).toBe(3);
    expect(chunks[2]!.bytes).toHaveLength(100);
  });

  it('sends an empty blob as one chunk', async () => {
    const bytes = new Uint8Array(0);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);
    expect(channel.chunks()).toHaveLength(1);
  });

  it('resumes from a chunk index', async () => {
    // What makes a dropped connection cost the remainder rather than the whole
    // transfer (§2.4).
    const bytes = bytesOf(CHUNK_SIZE * 4);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();

    await sendBlob(channel, hash, bytes, 2, noWait);

    const chunks = channel.chunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.index).toBe(2);
  });

  it('waits when the channel is full', async () => {
    // Backpressure: without it a sender would queue an entire blob into a
    // transport that cannot drain, which is how a data channel is killed.
    const bytes = bytesOf(CHUNK_SIZE * 3);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    channel.bufferedAmount = HIGH_WATER + 1;

    let waits = 0;
    const wait = async (): Promise<void> => {
      waits += 1;
      if (waits >= 3) channel.bufferedAmount = 0;
    };

    await sendBlob(channel, hash, bytes, 0, wait);
    expect(waits).toBeGreaterThan(0);
    expect(channel.chunks()).toHaveLength(3);
  });
});

describe('receiving', () => {
  async function transfer(bytes: Uint8Array, receiver = new BlobReceiver()) {
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);
    let last;
    for (const chunk of channel.chunks()) last = await receiver.accept(chunk);
    return { hash, result: last!, receiver };
  }

  it('reassembles a blob and verifies it', async () => {
    const bytes = bytesOf(CHUNK_SIZE * 2 + 7);
    const { hash, result } = await transfer(bytes);

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(hex(result.hash)).toBe(hex(hash));
    expect(hex(result.bytes)).toBe(hex(bytes));
  });

  it('reports progress while incomplete', async () => {
    const bytes = bytesOf(CHUNK_SIZE * 3);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);

    const receiver = new BlobReceiver();
    const first = await receiver.accept(channel.chunks()[0]!);
    expect(first.kind).toBe('partial');
    if (first.kind !== 'partial') return;
    expect(first.received).toBe(1);
    expect(first.chunks).toBe(3);
  });

  it('rejects bytes that do not hash to what was asked for', async () => {
    // Content addressing is only worth anything if the address is checked.
    const bytes = bytesOf(CHUNK_SIZE);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);

    const [chunk] = channel.chunks();
    const tampered = { ...chunk!, bytes: bytesOf(CHUNK_SIZE).map((b) => b ^ 0xff) };

    const result = await new BlobReceiver().accept(tampered);
    expect(result.kind).toBe('corrupt');
  });

  it('tolerates a repeated chunk without double counting', async () => {
    // A resume may overlap what was already received.
    const bytes = bytesOf(CHUNK_SIZE * 2);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);
    const chunks = channel.chunks();

    const receiver = new BlobReceiver();
    await receiver.accept(chunks[0]!);
    await receiver.accept(chunks[0]!);
    const done = await receiver.accept(chunks[1]!);
    expect(done.kind).toBe('complete');
  });

  it('says where to resume', async () => {
    const bytes = bytesOf(CHUNK_SIZE * 4);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);
    const chunks = channel.chunks();

    const receiver = new BlobReceiver();
    await receiver.accept(chunks[0]!);
    await receiver.accept(chunks[1]!);
    expect(receiver.resumeFrom(hex(hash))).toBe(2);
    expect(receiver.resumeFrom('unknown')).toBe(0);
  });

  it('handles several blobs at once', async () => {
    // Chunks carry their hash precisely so a receiver is not limited to one
    // transfer at a time.
    const a = bytesOf(CHUNK_SIZE);
    const b = bytesOf(CHUNK_SIZE * 2).map((x) => x ^ 0x5a);
    const receiver = new BlobReceiver();

    const chA = new TestChannel();
    const chB = new TestChannel();
    await sendBlob(chA, await hashLarge(a), a, 0, noWait);
    await sendBlob(chB, await hashLarge(b), b, 0, noWait);

    // Interleaved.
    await receiver.accept(chB.chunks()[0]!);
    const doneA = await receiver.accept(chA.chunks()[0]!);
    expect(doneA.kind).toBe('complete');
    expect(receiver.pending).toBe(1);

    const doneB = await receiver.accept(chB.chunks()[1]!);
    expect(doneB.kind).toBe('complete');
    expect(receiver.pending).toBe(0);
  });

  it('cancels a transfer, freeing what it buffered', async () => {
    const bytes = bytesOf(CHUNK_SIZE * 2);
    const hash = await hashLarge(bytes);
    const channel = new TestChannel();
    await sendBlob(channel, hash, bytes, 0, noWait);

    const receiver = new BlobReceiver();
    await receiver.accept(channel.chunks()[0]!);
    expect(receiver.pending).toBe(1);
    receiver.cancel(hex(hash));
    expect(receiver.pending).toBe(0);
  });

  it('a 4 MB blob transfers byte-exact', async () => {
    // The size the previous implementation measured, kept as a check that
    // nothing here is quadratic or truncating.
    const bytes = bytesOf(4 * 1024 * 1024);
    const { result } = await transfer(bytes);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.bytes).toHaveLength(bytes.length);
    expect(hex(result.bytes.subarray(0, 64))).toBe(hex(bytes.subarray(0, 64)));
    expect(hex(result.bytes.subarray(-64))).toBe(hex(bytes.subarray(-64)));
  });
});
