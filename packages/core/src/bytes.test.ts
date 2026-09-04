/**
 * The canonical writer and byte primitives.
 *
 * `Writer` is what every hashed or signed byte string is built with, so its
 * refusals matter as much as its output: a float or an unprefixed variable
 * field is how two implementations disagree while both look correct.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ByteWriter, bytesEqual, compareBytes, concat, fromHex, hex } from './index.js';

describe('hex', () => {
  it('round-trips', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(fromHex(hex(bytes))).toEqual(bytes);
      }),
      { numRuns: 200 },
    );
  });

  it('pads single digits', () => {
    expect(hex(Uint8Array.of(0, 1, 15, 16, 255))).toBe('00010f10ff');
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => fromHex('abc')).toThrow(/odd length/);
    expect(() => fromHex('zz')).toThrow(/not hex/);
  });
});

describe('compareBytes', () => {
  it('is a total order', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 8 }),
        fc.uint8Array({ maxLength: 8 }),
        (a, b) => {
          const ab = compareBytes(a, b);
          const ba = compareBytes(b, a);
          expect(Math.sign(ab)).toBe(-Math.sign(ba));
          expect(ab === 0).toBe(bytesEqual(a, b));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('orders a prefix before what extends it', () => {
    expect(compareBytes(Uint8Array.of(1), Uint8Array.of(1, 0))).toBeLessThan(0);
  });

  it('is transitive', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 4 }),
        fc.uint8Array({ maxLength: 4 }),
        fc.uint8Array({ maxLength: 4 }),
        (a, b, c) => {
          if (compareBytes(a, b) <= 0 && compareBytes(b, c) <= 0) {
            expect(compareBytes(a, c)).toBeLessThanOrEqual(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('Writer', () => {
  it('writes fixed widths big-endian', () => {
    expect(hex(new ByteWriter().u8(0xab).finish())).toBe('ab');
    expect(hex(new ByteWriter().u32(1).finish())).toBe('00000001');
    expect(hex(new ByteWriter().u64(1).finish())).toBe('0000000000000001');
  });

  it('refuses out-of-range integers rather than truncating', () => {
    expect(() => new ByteWriter().u8(256)).toThrow(/out of range/);
    expect(() => new ByteWriter().u32(-1)).toThrow(/out of range/);
    expect(() => new ByteWriter().u64(-1)).toThrow(/out of range/);
    // Beyond 2^53 a JS number is no longer exact, so the value written would
    // not be the value meant.
    expect(() => new ByteWriter().u64(Number.MAX_VALUE)).toThrow(/out of range/);
  });

  it('refuses non-integers, which is how a float would arrive', () => {
    // §3.6: no floating point in a hashed position, ever.
    expect(() => new ByteWriter().u32(1.5)).toThrow(/out of range/);
    expect(() => new ByteWriter().u64(Number.NaN)).toThrow(/out of range/);
  });

  it('length-prefixes so concatenation is unambiguous', () => {
    const a = new ByteWriter().lenPrefixed(Uint8Array.of(1, 2)).lenPrefixed(Uint8Array.of(3));
    const b = new ByteWriter().lenPrefixed(Uint8Array.of(1)).lenPrefixed(Uint8Array.of(2, 3));
    expect(hex(a.finish())).not.toBe(hex(b.finish()));
  });

  it('encodes strings as length-prefixed UTF-8 without normalising', () => {
    // Two Unicode spellings of the same glyph stay distinct: normalising here
    // would mean two clients disagreeing whenever their Unicode versions did.
    const composed = new ByteWriter().string('é').finish();
    const decomposed = new ByteWriter().string('é').finish();
    expect(hex(composed)).not.toBe(hex(decomposed));
  });

  it('checks fixed-width fields', () => {
    expect(() => new ByteWriter().fixed(Uint8Array.of(1), 4, 'thing')).toThrow(/thing must be 4/);
  });

  it('is order-sensitive and deterministic', () => {
    const one = new ByteWriter().u8(1).u8(2).finish();
    const two = new ByteWriter().u8(2).u8(1).finish();
    expect(hex(one)).not.toBe(hex(two));
    expect(hex(new ByteWriter().u8(1).u8(2).finish())).toBe(hex(one));
  });
});

describe('concat', () => {
  it('joins in order', () => {
    expect(hex(concat([Uint8Array.of(1), Uint8Array.of(2, 3)]))).toBe('010203');
    expect(concat([])).toHaveLength(0);
  });
});
