/**
 * Trust on first use (ADDRESSING.md §5.5).
 *
 * The claim being tested: an impostor can fool someone **once**, on a typed
 * code, for a space they have never visited — and never again, and never for a
 * space they already know.
 */
import { beforeEach, describe, expect, it } from 'vitest';

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { checkOrPin, pinnedFor, unpin } = await import('./pins.js');

const REAL = 'a'.repeat(64);
const IMPOSTOR = 'b'.repeat(64);

beforeEach(() => localStorage.clear());

describe('pinning', () => {
  it('pins on first sight and reports it as the first', () => {
    expect(checkOrPin('k7mfq2xw', REAL)).toEqual({ ok: true, first: true });
    expect(pinnedFor('k7mfq2xw')).toBe(REAL);
  });

  it('accepts the same key again without complaint', () => {
    checkOrPin('k7mfq2xw', REAL);
    expect(checkOrPin('k7mfq2xw', REAL)).toEqual({ ok: true, first: false });
  });

  it('refuses a different key for a handle already known', () => {
    checkOrPin('k7mfq2xw', REAL);
    const result = checkOrPin('k7mfq2xw', IMPOSTOR);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.expected).toBe(REAL);
  });

  it('does not re-pin on mismatch — a rejected key must not become the pin', () => {
    // If a mismatch silently re-pinned, the pin would be decorative: an
    // impostor would simply overwrite it and be trusted from then on.
    checkOrPin('k7mfq2xw', REAL);
    checkOrPin('k7mfq2xw', IMPOSTOR);
    expect(pinnedFor('k7mfq2xw')).toBe(REAL);
  });

  it('keeps handles independent of one another', () => {
    checkOrPin('aaaaaaaa', REAL);
    expect(checkOrPin('bbbbbbbb', IMPOSTOR)).toEqual({ ok: true, first: true });
    expect(pinnedFor('aaaaaaaa')).toBe(REAL);
  });

  it('unpins only when explicitly told to', () => {
    checkOrPin('k7mfq2xw', REAL);
    unpin('k7mfq2xw');
    expect(pinnedFor('k7mfq2xw')).toBeNull();
    expect(checkOrPin('k7mfq2xw', IMPOSTOR)).toEqual({ ok: true, first: true });
  });

  it('an unknown handle is not pinned', () => {
    expect(pinnedFor('never-seen')).toBeNull();
  });
});
