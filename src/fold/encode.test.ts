import { describe, expect, it } from 'vitest';
import { encodeEvent } from './encode.js';
import { bytesEqual, eventId, hex } from './hash.js';
import { contentHash, TestWriter, uuid, writer } from './testkit.js';
import type { Event } from './types.js';
import { ROOT } from './types.js';

/** A structurally identical copy, to prove encoding depends on values not identity. */
function clone(e: Event): Event {
  return {
    ...e,
    writer: new Uint8Array(e.writer),
    target: new Uint8Array(e.target),
    prev: e.prev === null ? null : new Uint8Array(e.prev),
  };
}

describe('canonical encoding (§2.1)', () => {
  it('is deterministic across structurally equal events', () => {
    const a = new TestWriter(writer('alice'));
    const e = a.name(uuid('file'), 'notes.txt');
    expect(hex(encodeEvent(e))).toBe(hex(encodeEvent(clone(e))));
  });

  it('distinguishes events differing in any single field', () => {
    const a = new TestWriter(writer('alice'));
    const base = a.name(uuid('file'), 'notes.txt');

    const variants: Event[] = [
      { ...base, writer: writer('bob') },
      { ...base, seq: base.seq + 1 },
      { ...base, lamport: base.lamport + 1 },
      { ...base, target: uuid('other') },
      { ...base, value: { t: 'string', v: 'other.txt' } },
      { ...base, wall: base.wall + 1 },
      { ...base, prev: new Uint8Array(16).fill(7) },
    ];

    const baseHex = hex(encodeEvent(base));
    for (const v of variants) {
      expect(hex(encodeEvent(v))).not.toBe(baseHex);
    }
  });

  it('length-prefixes strings so neighbouring fields cannot be confused', () => {
    // Without a length prefix, ("ab","c") and ("a","bc") could collide.
    const a = new TestWriter(writer('alice'));
    const t = uuid('file');
    const x = hex(encodeEvent(a.name(t, 'ab')));
    const b = new TestWriter(writer('alice'));
    const y = hex(encodeEvent(b.name(t, 'a')));
    expect(x).not.toBe(y);
  });

  it('encodes :parent ROOT distinctly from a named parent', () => {
    const a = new TestWriter(writer('alice'));
    const t = uuid('file');
    const toRoot = hex(encodeEvent(a.parent(t, ROOT)));
    const b = new TestWriter(writer('alice'));
    const toDir = hex(encodeEvent(b.parent(t, uuid('dir'))));
    expect(toRoot).not.toBe(toDir);
  });

  it('rejects a mis-sized writer id rather than encoding it', () => {
    const a = new TestWriter(writer('alice'));
    const bad: Event = { ...a.name(uuid('f'), 'x'), writer: new Uint8Array(8) };
    expect(() => encodeEvent(bad)).toThrow(/writer must be 16 bytes/);
  });

  it('rejects a truncated content hash (:content is full SHA-256)', () => {
    const a = new TestWriter(writer('alice'));
    const bad: Event = {
      ...a.content(uuid('f'), contentHash('h')),
      value: { t: 'hash', v: new Uint8Array(16) },
    };
    expect(() => encodeEvent(bad)).toThrow(/content hash must be 32 bytes/);
  });

  it('encodes :pos as two fixed-point i32s, negatives included', () => {
    const a = new TestWriter(writer('alice'));
    const t = uuid('card');
    const neg = hex(encodeEvent(a.pos(t, { x: -1000, y: -2000 })));
    const b = new TestWriter(writer('alice'));
    const pos = hex(encodeEvent(b.pos(t, { x: 1000, y: 2000 })));
    expect(neg).not.toBe(pos);
    expect(neg.length).toBe(pos.length); // fixed width, no varint surprises
  });
});

describe('EventId (§2.1)', () => {
  it('is SHA-256 truncated to 16 bytes', async () => {
    const a = new TestWriter(writer('alice'));
    const id = await eventId(a.name(uuid('file'), 'x'));
    expect(id.length).toBe(16);
  });

  it('is stable for structurally equal events, and differs otherwise', async () => {
    const a = new TestWriter(writer('alice'));
    const e = a.content(uuid('file'), contentHash('v1'));
    const same = await eventId(clone(e));
    const orig = await eventId(e);
    expect(bytesEqual(orig, same)).toBe(true);

    const other = await eventId({ ...e, value: { t: 'hash', v: contentHash('v2') } });
    expect(bytesEqual(orig, other)).toBe(false);
  });
});
