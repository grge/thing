/**
 * Byte primitives and the canonical writer.
 *
 * Everything hashed or signed is built with `Writer`, because two
 * implementations must produce byte-identical output or hashing, signing and
 * deduplication all break (ARCHITECTURE.md §2.1). The rules it enforces are the
 * ones that make that achievable: fixed widths, big-endian throughout,
 * length-prefixed variable data, and no floating point anywhere.
 */

/** Lowercase hex. For logs, map keys and legible test failures. */
export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex string has odd length: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`not hex: ${s.slice(i * 2, i * 2 + 2)}`);
    out[i] = byte;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Lexicographic byte comparison. Total, so it can break ties in a comparison
 * key (§2.2) where the alternative would be arrival order.
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const UTF8 = new TextEncoder();

/**
 * Builds canonical byte strings.
 *
 * Deliberately offers no way to write a float, and no way to write variable-
 * length data without a length prefix — the two mistakes that would make two
 * implementations disagree while both looking correct.
 */
export class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;

  bytes(b: Uint8Array): this {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }

  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`u8 out of range: ${n}`);
    return this.bytes(Uint8Array.of(n));
  }

  u32(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`u32 out of range: ${n}`);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return this.bytes(b);
  }

  /**
   * A u64, written from a JS number.
   *
   * Numbers are exact to 2^53, which bounds what may be passed here: a lamport
   * clock or a wall-clock millisecond never approaches it, and anything that
   * might should be a bigint before it reaches this.
   */
  u64(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`u64 out of range: ${n}`);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
    return this.bytes(b);
  }

  /** Length-prefixed bytes, so no value can run into its neighbour. */
  lenPrefixed(b: Uint8Array): this {
    return this.u32(b.length).bytes(b);
  }

  /**
   * Length-prefixed UTF-8. No normalisation: the bytes the writer chose are the
   * bytes that get hashed, everywhere. Normalising here would mean two clients
   * disagreeing about a hash whenever their Unicode versions differed.
   */
  string(s: string): this {
    return this.lenPrefixed(UTF8.encode(s));
  }

  /** Fixed-width bytes, asserted. Use where the width is part of the format. */
  fixed(b: Uint8Array, width: number, what: string): this {
    if (b.length !== width) {
      throw new Error(`${what} must be ${width} bytes, got ${b.length}`);
    }
    return this.bytes(b);
  }

  finish(): Uint8Array {
    return concat(this.parts);
  }
}
