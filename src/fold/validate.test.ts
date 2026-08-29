import { describe, expect, it } from 'vitest';
import { checkWriterLamports, InvalidEvent, validateEvent } from './validate.js';
import { contentHash, TestWriter, uuid, writer } from './testkit.js';
import type { Event } from './types.js';

describe('validateEvent (§2, §4)', () => {
  const t = uuid('file');

  /**
   * A fresh writer per call, so every event is seq 0 with prev = null. Sharing
   * one writer advances seq and trips the prev check before the assertion
   * under test is reached.
   */
  const first = () => new TestWriter(writer('alice'));

  it('accepts well-formed events for every attribute', () => {
    const w = new TestWriter(writer('alice'));
    const ok: Event[] = [
      w.parent(t, uuid('dir')),
      w.name(t, 'notes.txt'),
      w.content(t, contentHash('h')),
      w.content(t, null),
      w.pos(t, { x: -1000, y: 2000 }),
      w.deleted(t, true),
      w.kind(t, 'dir'),
    ];
    // seq 0 is the only one with prev === null; give the rest a stand-in prev.
    for (const e of ok) {
      const fixed = e.seq === 0 ? e : { ...e, prev: new Uint8Array(16) };
      expect(() => validateEvent(fixed)).not.toThrow();
    }
  });

  it('requires prev to be null exactly at seq 0 (§2)', () => {
    const e = first().name(t, 'x');
    expect(() => validateEvent({ ...e, prev: new Uint8Array(16) })).toThrow(InvalidEvent);
    expect(() => validateEvent({ ...e, seq: 3, prev: null })).toThrow(/must have a prev/);
  });

  it('rejects a value variant that does not match the attr', () => {
    const e = first().name(t, 'x');
    expect(() => validateEvent({ ...e, attr: ':deleted' })).toThrow(/:deleted takes a bool/);
  });

  it('rejects non-integer :pos (floats are not permitted, §4.4)', () => {
    const e = first().pos(t, { x: 1, y: 1 });
    expect(() => validateEvent({ ...e, value: { t: 'pos', v: { x: 1.5, y: 0 } } })).toThrow(
      /fixed point/,
    );
  });

  it('rejects :pos outside i32 range', () => {
    const e = first().pos(t, { x: 1, y: 1 });
    expect(() =>
      validateEvent({ ...e, value: { t: 'pos', v: { x: 2 ** 31, y: 0 } } }),
    ).toThrow(/out of i32 range/);
  });
});

describe('checkWriterLamports (§2.2)', () => {
  it('passes for normally generated writers', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const t = uuid('file');
    expect(() =>
      checkWriterLamports([a.name(t, 'x'), b.name(t, 'y'), a.content(t, contentHash('h'))]),
    ).not.toThrow();
  });

  it('allows different writers to share a lamport (that is what ties are)', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const t = uuid('file');
    expect(() => checkWriterLamports([a.name(t, 'x', 5), b.name(t, 'y', 5)])).not.toThrow();
  });

  it('catches a writer reusing a lamport across two events', () => {
    const a = new TestWriter(writer('alice'));
    const t = uuid('file');
    // The exact shape the property test found: same writer, same stamp,
    // two different assertions. No total order can resolve these.
    expect(() => checkWriterLamports([a.parent(t, uuid('a'), 11), a.parent(t, uuid('c'), 11)])).toThrow(
      /no longer a total order/,
    );
  });
});
