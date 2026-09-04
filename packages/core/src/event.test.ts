/**
 * Canonical encoding and event identity (ARCHITECTURE.md §2.1).
 *
 * The property that matters: two implementations must produce byte-identical
 * encodings of the same event, or hashing, signing and deduplication all break.
 * These tests pin the things that would let two encoders disagree while both
 * looking correct.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ByteWriter, hex } from './index.js';
import {
  encodeEventBody,
  type EventBody,
  eventId,
  ROOT,
  sliceKey,
  UUID_LEN,
} from './event.js';
import { HASH_LEN } from './hash.js';
import { PUBLIC_KEY_LEN } from './sign.js';
import { labelled } from './testkit.js';

const SPACE = labelled('space', PUBLIC_KEY_LEN);
const ALICE = labelled('alice', PUBLIC_KEY_LEN);
const BOB = labelled('bob', PUBLIC_KEY_LEN);

function body(over: Partial<EventBody> = {}): EventBody {
  return {
    writer: ALICE,
    seq: 0,
    prev: null,
    lamport: 1,
    target: ROOT,
    attr: ':name',
    value: new TextEncoder().encode('hello'),
    wall: 1_700_000_000_000,
    ...over,
  };
}

describe('canonical encoding', () => {
  it('is deterministic', () => {
    expect(hex(encodeEventBody(SPACE, body()))).toBe(hex(encodeEventBody(SPACE, body())));
  });

  it('agrees with an independent encoder, byte for byte', () => {
    // Written from the field order in §2.1 rather than by calling the encoder,
    // so this fails if the layout drifts. A second implementation is exactly
    // what canonical encoding has to survive.
    const e = body({ seq: 3, prev: labelled('prev', HASH_LEN), lamport: 9 });
    const w = new ByteWriter();
    w.bytes(SPACE);
    w.bytes(e.writer);
    w.u32(e.seq);
    w.u8(1);
    w.bytes(e.prev!);
    w.u64(e.lamport);
    w.bytes(e.target);
    w.u32(new TextEncoder().encode(e.attr).length);
    w.bytes(new TextEncoder().encode(e.attr));
    w.u32(e.value.length);
    w.bytes(e.value);
    w.u64(e.wall);

    expect(hex(encodeEventBody(SPACE, e))).toBe(hex(w.finish()));
  });

  it('distinguishes a null prev from a present one', () => {
    // A presence byte rather than a length prefix, so an all-zero hash cannot
    // encode as "absent".
    const withNull = encodeEventBody(SPACE, body({ seq: 0, prev: null }));
    const withZeros = encodeEventBody(SPACE, body({ seq: 1, prev: new Uint8Array(HASH_LEN) }));
    expect(hex(withNull)).not.toBe(hex(withZeros));
  });

  it('length-prefixes attr and value, so neighbours cannot run together', () => {
    // Without prefixes these two would encode identically: "ab" + "c" vs
    // "a" + "bc".
    const enc = new TextEncoder();
    const a = encodeEventBody(SPACE, body({ attr: ':ab', value: enc.encode('c') }));
    const b = encodeEventBody(SPACE, body({ attr: ':a', value: enc.encode('bc') }));
    expect(hex(a)).not.toBe(hex(b));
  });

  it('rejects a wrong-width field rather than encoding it', () => {
    expect(() => encodeEventBody(SPACE, body({ writer: labelled('short', 8) }))).toThrow(/32 bytes/);
    expect(() => encodeEventBody(SPACE, body({ target: labelled('short', 4) }))).toThrow(/16 bytes/);
    expect(() => encodeEventBody(labelled('short', 8), body())).toThrow(/space key/);
  });

  it('encodes the space key, so an event is bound to its space', () => {
    // §2.1: without this an event is portable between any two spaces its
    // writer belongs to, and can be replayed from one into another.
    const other = labelled('other-space', PUBLIC_KEY_LEN);
    expect(hex(encodeEventBody(SPACE, body()))).not.toBe(hex(encodeEventBody(other, body())));
  });
});

describe('event id', () => {
  it('is a full-width hash', () => {
    expect(eventId(SPACE, body())).toHaveLength(HASH_LEN);
  });

  it('differs whenever any field differs', () => {
    const base = hex(eventId(SPACE, body()));
    const variants: Partial<EventBody>[] = [
      { writer: BOB },
      { seq: 1, prev: labelled('p', HASH_LEN) },
      { lamport: 2 },
      { target: labelled('other', UUID_LEN) },
      { attr: ':parent' },
      { value: new TextEncoder().encode('goodbye') },
      { wall: 1_700_000_000_001 },
    ];
    for (const v of variants) {
      expect(hex(eventId(SPACE, body(v))), JSON.stringify(Object.keys(v))).not.toBe(base);
    }
  });

  it('includes wall, so two events differing only in time are different events', () => {
    // wall has no mechanical purpose (§2.1) but is part of identity.
    expect(hex(eventId(SPACE, body({ wall: 1 })))).not.toBe(hex(eventId(SPACE, body({ wall: 2 }))));
  });

  it('is stable across arbitrary field values', () => {
    fc.assert(
      fc.property(
        fc.record({
          seq: fc.integer({ min: 0, max: 1000 }),
          lamport: fc.integer({ min: 0, max: 1_000_000 }),
          attr: fc.string(),
          value: fc.uint8Array({ maxLength: 64 }),
          wall: fc.integer({ min: 0, max: 2_000_000_000_000 }),
        }),
        (over) => {
          const e = body(over);
          expect(hex(eventId(SPACE, e))).toBe(hex(eventId(SPACE, e)));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('slice keys', () => {
  it('separates target from attr unambiguously', () => {
    // Without a separator these would collide: target "ab" + attr "c" against
    // target "a" + attr "bc" — impossible here because targets are fixed width,
    // but the test states the requirement rather than the accident.
    const a = sliceKey(labelled('a', UUID_LEN), ':bc');
    const b = sliceKey(labelled('ab', UUID_LEN), ':c');
    expect(a).not.toBe(b);
  });

  it('is stable for the same target and attr', () => {
    expect(sliceKey(ROOT, ':name')).toBe(sliceKey(ROOT, ':name'));
  });
});
