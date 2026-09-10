/**
 * What the cipher must get right (ARCHITECTURE.md §6).
 *
 * Mostly the things that would fail silently: a nonce that repeats, a subkey
 * that does not separate, a blob that turns out to be deterministic after
 * someone "simplifies" the nonce. None of those produce an error at the time —
 * they produce a system that works and does not protect anything.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptBlob,
  decryptValue,
  encryptBlob,
  encryptValue,
  newReadingKey,
  NONCE_LEN,
  type Position,
  READING_KEY_LEN,
  subkeys,
  valueNonce,
} from './cipher.js';
import { hex } from './bytes.js';
import { newPoint } from './event.js';

const UTF8 = new TextEncoder();

function position(overrides: Partial<Position> = {}): Position {
  return {
    writer: new Uint8Array(32).fill(7),
    point: new Uint8Array(16).fill(3),
    seq: 0,
    ...overrides,
  };
}

describe('reading keys', () => {
  it('mints 32 bytes, and two are different', () => {
    const a = newReadingKey();
    const b = newReadingKey();
    expect(a.length).toBe(READING_KEY_LEN);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('refuses a key of the wrong length', () => {
    expect(() => subkeys(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it('separates the value and blob subkeys', () => {
    const keys = subkeys(newReadingKey());
    expect(hex(keys.value)).not.toBe(hex(keys.blob));
  });

  it('derives the same subkeys from the same reading key', () => {
    const reading = newReadingKey();
    expect(hex(subkeys(reading).value)).toBe(hex(subkeys(reading).value));
  });
});

describe('value nonces', () => {
  it('is 24 bytes', () => {
    expect(valueNonce(position()).length).toBe(NONCE_LEN);
  });

  /**
   * The whole triple has to matter. §6 originally derived from `(writer, seq)`
   * and that stopped being unique when append points arrived — so the case that
   * broke, two chains under one identity at one `seq`, is the one to pin.
   */
  it('differs when any of writer, point or seq differs', () => {
    const base = hex(valueNonce(position()));
    expect(hex(valueNonce(position({ seq: 1 })))).not.toBe(base);
    expect(hex(valueNonce(position({ point: new Uint8Array(16).fill(4) })))).not.toBe(base);
    expect(hex(valueNonce(position({ writer: new Uint8Array(32).fill(8) })))).not.toBe(base);
  });

  it('gives one identity at one seq different nonces on different points', () => {
    const writer = new Uint8Array(32).fill(1);
    const a = valueNonce({ writer, point: newPoint(), seq: 4 });
    const b = valueNonce({ writer, point: newPoint(), seq: 4 });
    expect(hex(a)).not.toBe(hex(b));
  });
});

describe('values', () => {
  it('round-trips', () => {
    const keys = subkeys(newReadingKey());
    const at = position();
    const plaintext = UTF8.encode('the quick brown fox');
    const decrypted = decryptValue(keys, at, encryptValue(keys, at, plaintext));
    expect(decrypted).not.toBeNull();
    expect(hex(decrypted!)).toBe(hex(plaintext));
  });

  it('round-trips an empty value', () => {
    const keys = subkeys(newReadingKey());
    const at = position();
    const out = decryptValue(keys, at, encryptValue(keys, at, new Uint8Array()));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(0);
  });

  it('hides the plaintext', () => {
    const keys = subkeys(newReadingKey());
    const plaintext = UTF8.encode('secret');
    const ciphertext = encryptValue(keys, position(), plaintext);
    expect(hex(ciphertext)).not.toContain(hex(plaintext));
  });

  /** Null, not a throw: the fold is total (§3.4) and an unreadable slice is ordinary. */
  it('returns null for the wrong key', () => {
    const at = position();
    const ciphertext = encryptValue(subkeys(newReadingKey()), at, UTF8.encode('hello'));
    expect(decryptValue(subkeys(newReadingKey()), at, ciphertext)).toBeNull();
  });

  it('returns null for the wrong position', () => {
    const keys = subkeys(newReadingKey());
    const ciphertext = encryptValue(keys, position(), UTF8.encode('hello'));
    expect(decryptValue(keys, position({ seq: 1 }), ciphertext)).toBeNull();
  });

  it('returns null for a tampered ciphertext', () => {
    const keys = subkeys(newReadingKey());
    const at = position();
    const ciphertext = encryptValue(keys, at, UTF8.encode('hello'));
    ciphertext[0]! ^= 0xff;
    expect(decryptValue(keys, at, ciphertext)).toBeNull();
  });

  it('returns null for bytes that were never a ciphertext', () => {
    const keys = subkeys(newReadingKey());
    expect(decryptValue(keys, position(), UTF8.encode('not a ciphertext'))).toBeNull();
    expect(decryptValue(keys, position(), new Uint8Array())).toBeNull();
  });
});

describe('blobs', () => {
  it('round-trips', () => {
    const keys = subkeys(newReadingKey());
    const plaintext = UTF8.encode('file contents');
    const out = decryptBlob(keys, encryptBlob(keys, plaintext));
    expect(out).not.toBeNull();
    expect(hex(out!)).toBe(hex(plaintext));
  });

  /**
   * The trade `ENCRYPTION-PLAN.md` made deliberately: deduplication given up to
   * deny a hub operator a confirm-a-known-file attack. It is a property nothing
   * announces when it is lost, so it is a test rather than a comment.
   */
  it('encrypts identical bytes to different ciphertexts', () => {
    const keys = subkeys(newReadingKey());
    const plaintext = UTF8.encode('the same bytes twice');
    expect(hex(encryptBlob(keys, plaintext))).not.toBe(hex(encryptBlob(keys, plaintext)));
  });

  it('still decrypts both of two encryptions of one plaintext', () => {
    const keys = subkeys(newReadingKey());
    const plaintext = UTF8.encode('the same bytes twice');
    expect(hex(decryptBlob(keys, encryptBlob(keys, plaintext))!)).toBe(hex(plaintext));
    expect(hex(decryptBlob(keys, encryptBlob(keys, plaintext))!)).toBe(hex(plaintext));
  });

  it('round-trips an empty blob', () => {
    const keys = subkeys(newReadingKey());
    const out = decryptBlob(keys, encryptBlob(keys, new Uint8Array()));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(0);
  });

  it('round-trips a large blob', () => {
    const keys = subkeys(newReadingKey());
    const plaintext = new Uint8Array(200_000);
    // In chunks: `getRandomValues` refuses more than 65,536 bytes at a time.
    for (let i = 0; i < plaintext.length; i += 65_536) {
      crypto!.getRandomValues(plaintext.subarray(i, Math.min(i + 65_536, plaintext.length)));
    }
    expect(hex(decryptBlob(keys, encryptBlob(keys, plaintext))!)).toBe(hex(plaintext));
  });

  it('returns null for the wrong key', () => {
    const stored = encryptBlob(subkeys(newReadingKey()), UTF8.encode('x'));
    expect(decryptBlob(subkeys(newReadingKey()), stored)).toBeNull();
  });

  it('returns null for a tampered blob', () => {
    const keys = subkeys(newReadingKey());
    const stored = encryptBlob(keys, UTF8.encode('file contents'));
    stored[stored.length - 1]! ^= 0xff;
    expect(decryptBlob(keys, stored)).toBeNull();
  });

  it('returns null for bytes too short to hold a nonce and tag', () => {
    const keys = subkeys(newReadingKey());
    expect(decryptBlob(keys, new Uint8Array(NONCE_LEN))).toBeNull();
    expect(decryptBlob(keys, new Uint8Array())).toBeNull();
  });

  /** The subkeys are separate, so a value's key must not open a blob. */
  it('does not decrypt a blob with the value subkey', () => {
    const keys = subkeys(newReadingKey());
    const crossed = { value: keys.blob, blob: keys.value };
    expect(decryptBlob(crossed, encryptBlob(keys, UTF8.encode('x')))).toBeNull();
  });
});
