/**
 * The sequence rule (§3.8) — the bet.
 *
 * Tests are written as **transcripts** rather than as raw operations: "A types
 * hello, B concurrently types world at the start". Convergence is a property
 * the code either has or does not, but whether it converges to something a
 * person would *accept* is a judgement, and these are legible enough to
 * disagree with. That is the most a test can do without an interface.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { hex } from './bytes.js';
import type { Key } from './chain.js';
import { permutation, reorder } from './testkit.js';
import { elementIdOf, encodeSeqAcc, sequence, type SeqOp } from './sequence.js';
import type { Entry } from './rule.js';

const UTF8 = new TextEncoder();
const text = (xs: readonly Uint8Array[]): string =>
  xs.map((b) => new TextDecoder().decode(b)).join('');

/** A writer in a transcript: a name, a lamport clock, and a chain of ids. */
class Scribe {
  private lamport = 0;
  private n = 0;
  constructor(
    readonly name: string,
    private readonly writerByte: number,
  ) {}

  /** Raise this scribe's clock past what it has seen (§2.2). */
  sees(...entries: readonly Entry<SeqOp>[]): void {
    for (const e of entries) if (e.key.lamport > this.lamport) this.lamport = e.key.lamport;
  }

  private key(): Key {
    this.lamport += 1;
    this.n += 1;
    const writer = new Uint8Array(32).fill(this.writerByte);
    const id = new Uint8Array(32);
    id[0] = this.writerByte;
    id[1] = this.n;
    return { lamport: this.lamport, writer, id };
  }

  insert(after: Entry<SeqOp> | null, body: string): Entry<SeqOp> {
    const key = this.key();
    const anchor = after === null ? null : elementIdOf(after.key);
    return { key, value: { op: 'ins', after: anchor, body: UTF8.encode(body) } };
  }

  remove(target: Entry<SeqOp>): Entry<SeqOp> {
    return { key: this.key(), value: { op: 'del', target: elementIdOf(target.key) } };
  }
}

function play(entries: readonly Entry<SeqOp>[]): string {
  const { empty, step, render } = sequence.merge;
  return text(render(step(empty(), entries).acc));
}

describe('a sequence', () => {
  it('keeps one writer\'s insertions in order', () => {
    const a = new Scribe('A', 1);
    const h = a.insert(null, 'h');
    const e = a.insert(h, 'e');
    const y = a.insert(e, 'y');
    expect(play([h, e, y])).toBe('hey');
  });

  it('does not care what order the events arrive in', () => {
    const a = new Scribe('A', 1);
    const h = a.insert(null, 'h');
    const e = a.insert(h, 'e');
    const y = a.insert(e, 'y');
    const events = [h, e, y];

    fc.assert(
      fc.property(permutation(events.length), (order) => {
        expect(play(reorder(events, order))).toBe('hey');
      }),
      { numRuns: 30 },
    );
  });

  it('deletes leave nothing behind in the reading', () => {
    const a = new Scribe('A', 1);
    const c = a.insert(null, 'c');
    const a2 = a.insert(c, 'a');
    const t = a.insert(a2, 't');
    expect(play([c, a2, t, a.remove(a2)])).toBe('ct');
  });

  it('a delete that arrives before its target still applies', () => {
    // §3.4: held, never discarded. Dropping it would make the result depend on
    // arrival order, which is the one thing the fold may not do.
    const a = new Scribe('A', 1);
    const x = a.insert(null, 'x');
    const y = a.insert(x, 'y');
    const gone = a.remove(y);
    expect(play([x, gone, y])).toBe('x');
    expect(play([x, y, gone])).toBe('x');
  });

  it('an insert whose anchor is missing waits, and the rest still reads', () => {
    const a = new Scribe('A', 1);
    const one = a.insert(null, 'one ');
    const two = a.insert(one, 'two');
    // `two` arrives without `one`: it cannot be placed, and must not break the
    // slice or appear in the wrong position.
    expect(play([two])).toBe('');
    expect(play([two, one])).toBe('one two');
  });

  it('two writers inserting at the same place both survive', () => {
    // The case a register cannot do, and the reason this rule exists.
    const a = new Scribe('A', 1);
    const b = new Scribe('B', 2);
    const start = a.insert(null, '|');
    b.sees(start);

    const fromA = a.insert(start, 'A');
    const fromB = b.insert(start, 'B');

    const result = play([start, fromA, fromB]);
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result.startsWith('|')).toBe(true);
    // Deterministic, whichever way round they arrived.
    expect(play([start, fromB, fromA])).toBe(result);
  });

  it('concurrent typing interleaves deterministically, not randomly', () => {
    // A transcript worth reading as an outcome: A writes "hello" and B writes
    // "world" at the same anchor, neither having seen the other. Both survive
    // whole — RGA keeps each run together rather than shuffling characters.
    const a = new Scribe('A', 1);
    const b = new Scribe('B', 2);
    const anchor = a.insert(null, '>');
    b.sees(anchor);

    const write = (s: Scribe, word: string): Entry<SeqOp>[] => {
      const out: Entry<SeqOp>[] = [];
      let prev: Entry<SeqOp> = anchor;
      for (const ch of word) {
        prev = s.insert(prev, ch);
        out.push(prev);
      }
      return out;
    };

    const fromA = write(a, 'hello');
    const fromB = write(b, 'world');
    const result = play([anchor, ...fromA, ...fromB]);

    // **Each writer's run stays contiguous.** This is the property that makes
    // concurrent typing readable rather than a shuffle — the characters of
    // "hello" are not scattered through "world". Which run comes first is
    // arbitrary but deterministic; that it is one run then the other is not
    // arbitrary, and is what a person would accept.
    expect(['>helloworld', '>worldhello']).toContain(result);
  });

  it('is idempotent: the same event twice changes nothing', () => {
    const a = new Scribe('A', 1);
    const x = a.insert(null, 'x');
    const y = a.insert(x, 'y');
    expect(play([x, y, x, y])).toBe('xy');
  });

  it('satisfies the homomorphism: folding in parts equals folding at once', () => {
    // §3.2's actual contract, and what snapshots and incremental folding need.
    const a = new Scribe('A', 1);
    const b = new Scribe('B', 2);
    const one = a.insert(null, '1');
    b.sees(one);
    const two = a.insert(one, '2');
    const alt = b.insert(one, 'X');
    const events = [one, two, alt];

    const { empty, step, render } = sequence.merge;
    const atOnce = render(step(empty(), events).acc);
    const inParts = render(step(step(empty(), [one]).acc, [two, alt]).acc);
    expect(text(inParts)).toBe(text(atOnce));
  });
});

describe('canonical form (§3.6)', () => {
  it('serialises identically regardless of arrival order', () => {
    // The requirement that is stronger than convergence: agreeing on the state
    // is not the same as agreeing on the bytes.
    const a = new Scribe('A', 1);
    const b = new Scribe('B', 2);
    const start = a.insert(null, '>');
    b.sees(start);
    const events = [start, a.insert(start, 'a'), b.insert(start, 'b')];

    const { empty, step } = sequence.merge;
    const reference = hex(encodeSeqAcc(step(empty(), events).acc));

    fc.assert(
      fc.property(permutation(events.length), (order) => {
        const got = hex(encodeSeqAcc(step(empty(), reorder(events, order)).acc));
        expect(got).toBe(reference);
      }),
      { numRuns: 40 },
    );
  });

  it('a tombstone changes the bytes but not the reading', () => {
    // Which is exactly why §3.6 says to hash the observable state: two peers
    // that agree on the list must agree on its hash even if one still carries
    // a tombstone.
    const a = new Scribe('A', 1);
    const x = a.insert(null, 'x');
    const y = a.insert(x, 'y');
    const gone = a.remove(y);

    const { empty, step, render } = sequence.merge;
    const withTomb = step(empty(), [x, y, gone]).acc;
    const withoutY = step(empty(), [x]).acc;

    expect(text(render(withTomb))).toBe(text(render(withoutY)));
    expect(hex(encodeSeqAcc(withTomb))).not.toBe(hex(encodeSeqAcc(withoutY)));
  });
});

describe('the codec', () => {
  it('round-trips both operations', () => {
    const ins: SeqOp = { op: 'ins', after: 'aa/bb', body: UTF8.encode('hi') };
    const del: SeqOp = { op: 'del', target: 'cc/dd' };
    expect(sequence.codec.decode(sequence.codec.encode(ins))).toEqual(ins);
    expect(sequence.codec.decode(sequence.codec.encode(del))).toEqual(del);
  });

  it('returns null rather than throwing on anything malformed', () => {
    // §3.2: a codec that can throw cannot keep the fold total (§3.4).
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.of(99),
      Uint8Array.of(1, 1, 255, 255, 255, 255),
      Uint8Array.of(2, 0),
    ]) {
      expect(sequence.codec.decode(bytes)).toBeNull();
    }
  });
});
