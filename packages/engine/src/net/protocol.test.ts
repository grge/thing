/**
 * Framing, and the event wire codec.
 *
 * The framing's job is to keep three channels apart on one connection, and to
 * survive whatever a peer sends — a malformed frame is a peer being broken or
 * hostile, and neither should be able to stop this one.
 */
import { generateKeyPair, hex, keyPairFromSeed, ROOT, SEED_LEN, Writer } from '../core/index.js';
import { describe, expect, it } from 'vitest';

/** Every control frame names its space (`design/CONNECTIONS.md`). */
const SPACE = 'aa'.repeat(32);
import {
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  chunkCount,
  decodeFrame,
  encodeChunk,
  encodeControl,
  encodeEphemeral,
  PROTOCOL_VERSION,
  TAG_CHUNK,
  TAG_CONTROL,
  TAG_EPHEMERAL,
} from './protocol.js';
import { fromWire, toWire } from './wire.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

describe('framing', () => {
  it('round-trips a control message', () => {
    const frame = encodeControl({ space: SPACE, type: 'WANT', chain: 'aa', from: 3 });
    expect(frame[0]).toBe(TAG_CONTROL);

    const decoded = decodeFrame(frame);
    expect(decoded?.kind).toBe('control');
    // The space rides along: every control frame names it, so a receiver can
    // route it to the right session on a connection carrying several.
    expect(decoded?.kind === 'control' && decoded.msg).toEqual({
      space: SPACE,
      type: 'WANT',
      chain: 'aa',
      from: 3,
    });
  });

  it('round-trips an ephemeral message', () => {
    const frame = encodeEphemeral({ type: 'HAVE', hashes: ['ab', 'cd'] });
    expect(frame[0]).toBe(TAG_EPHEMERAL);
    const decoded = decodeFrame(frame);
    expect(decoded?.kind).toBe('ephemeral');
  });

  it('keeps the channels apart', () => {
    // The whole point of the tag: a receiver must never mistake something that
    // expires for something that enters the log (§10).
    const control = decodeFrame(encodeControl({ space: SPACE, type: 'NO_BLOB', hash: 'ff' }));
    const ephemeral = decodeFrame(encodeEphemeral({ type: 'HAVE', hashes: [] }));
    expect(control?.kind).toBe('control');
    expect(ephemeral?.kind).toBe('ephemeral');
  });

  it('round-trips a chunk with its header', () => {
    const hash = hex(labelled('h', 32));
    const payload = UTF8.encode('some bytes');
    const frame = encodeChunk(hash, 2, 5, 1234, payload);

    expect(frame[0]).toBe(TAG_CHUNK);
    expect(frame.length).toBe(CHUNK_HEADER_BYTES + payload.length);

    const decoded = decodeFrame(frame);
    expect(decoded?.kind).toBe('chunk');
    if (decoded?.kind !== 'chunk') return;
    expect(decoded.chunk.hash).toBe(hash);
    expect(decoded.chunk.index).toBe(2);
    expect(decoded.chunk.chunks).toBe(5);
    expect(decoded.chunk.total).toBe(1234);
    expect(hex(decoded.chunk.bytes)).toBe(hex(payload));
  });

  it('never throws at a malformed frame', () => {
    // Each of these is something a broken or hostile peer could send.
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(Uint8Array.of(0x09, 1, 2))).toBeNull(); // unknown tag
    expect(decodeFrame(Uint8Array.of(TAG_CONTROL, 0x7b, 0x7b))).toBeNull(); // bad JSON
    expect(decodeFrame(Uint8Array.of(TAG_CHUNK, 1, 2))).toBeNull(); // truncated header
  });

  it('rejects JSON that is not a message', () => {
    const notAMessage = new Uint8Array([TAG_CONTROL, ...UTF8.encode('[1,2,3]')]);
    expect(decodeFrame(notAMessage)).toBeNull();
    const noType = new Uint8Array([TAG_CONTROL, ...UTF8.encode('{"x":1}')]);
    expect(decodeFrame(noType)).toBeNull();
  });

  it('counts chunks, including for an empty blob', () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_SIZE)).toBe(1);
    expect(chunkCount(CHUNK_SIZE + 1)).toBe(2);
  });

  it('has a protocol version', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('the event wire codec', () => {
  it('round-trips a real signed event', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const e = await w.write(ROOT, ':name', UTF8.encode('hello'), 1234);

    const back = fromWire(toWire(e));
    expect(back).not.toBeNull();
    expect(hex(back!.writer)).toBe(hex(e.writer));
    expect(back!.seq).toBe(e.seq);
    expect(back!.prev).toBeNull();
    expect(back!.lamport).toBe(e.lamport);
    expect(hex(back!.target)).toBe(hex(e.target));
    expect(back!.attr).toBe(e.attr);
    expect(hex(back!.value)).toBe(hex(e.value));
    expect(back!.wall).toBe(e.wall);
    expect(hex(back!.sig)).toBe(hex(e.sig));
  });

  it('round-trips an event with a prev', async () => {
    const key = await generateKeyPair();
    const w = new Writer(key.publicKey, key);
    await w.write(ROOT, ':name', UTF8.encode('first'), 1);
    const second = await w.write(ROOT, ':name', UTF8.encode('second'), 2);

    const back = fromWire(toWire(second))!;
    expect(back.prev).not.toBeNull();
    expect(hex(back.prev!)).toBe(hex(second.prev!));
  });

  it('rejects a malformed wire event rather than throwing', () => {
    expect(fromWire(null)).toBeNull();
    expect(fromWire({})).toBeNull();
    expect(fromWire({ w: 'aa', s: 'not a number' })).toBeNull();
    expect(fromWire({ w: 'not hex!', s: 0, l: 0, t: 'aa', a: ':x', v: '', wall: 0, sig: '', p: null })).toBeNull();
  });
});
