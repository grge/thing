/**
 * The rule vocabulary, and the algebra every rule must satisfy.
 *
 * Two properties carry the design (ARCHITECTURE.md §3.2, §3.7):
 *
 * - **Order-independence**, so two peers holding the same events agree.
 * - **The homomorphism** `step(step(∅, S₁), S₂) = step(∅, S₁ ∪ S₂)`, which is
 *   what lets a peer keep a running accumulator instead of replaying from
 *   empty. A rule can fail this while looking correct, so it is checked here
 *   for every rule rather than argued.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hex } from './bytes.js';
import type { Key } from './chain.js';
import { HASH_LEN } from './hash.js';
import type { AnyRule, Entry } from './rule.js';
import { attributeRule, blob, bodyRule, bytesRegister, flag, stringRegister } from './rules.js';
import { PUBLIC_KEY_LEN } from './sign.js';
import { labelled, permutation, reorder } from './testkit.js';

/** A synthetic key. Distinct `(lamport, writer, id)` triples, cheaply. */
function key(lamport: number, writer: string, id: string): Key {
  return {
    lamport,
    writer: labelled(writer, PUBLIC_KEY_LEN),
    id: labelled(id, HASH_LEN),
  };
}

/**
 * Keys for generated entries.
 *
 * **Ids must be distinct**, because in a real log they are: an id is the hash
 * of an event's preimage, and two distinct events cannot share one. A generator
 * that emitted duplicate ids would produce genuinely unorderable entries and
 * make order-independence look false when it is not — the fault would be in the
 * test, not the rule. Entries are therefore tagged with their index.
 */
function genEntry<V>(genValue: fc.Arbitrary<V>): fc.Arbitrary<(i: number) => Entry<unknown>> {
  return fc
    .tuple(fc.integer({ min: 0, max: 6 }), fc.constantFrom('a', 'b', 'c'), genValue)
    .map(
      ([l, w, v]) =>
        (i: number): Entry<unknown> => ({ key: key(l, w, `e${i}`), value: v }),
    );
}

/** Render a bag under a rule, from empty. */
function render(rule: AnyRule, entries: readonly Entry<unknown>[]): unknown {
  return rule.merge.render(rule.merge.step(rule.merge.empty(), entries).acc);
}

/**
 * A comparable string for a rendered value.
 *
 * `JSON.stringify` is not usable here: it renders a `Uint8Array` as an object
 * with index keys, so an empty array and a one-zero-byte array both serialise
 * to something misleading. These rules produce bytes, so this has to be right
 * or the properties below would pass vacuously.
 */
function show(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `bytes:${hex(v)}`;
  return `${typeof v}:${String(v)}`;
}

/**
 * The properties every rule must satisfy, applied to each in the vocabulary.
 *
 * Written once and reused, because the obligation is on the *contract* rather
 * than on any particular rule — a new rule added later should be dropped into
 * this list and nothing else.
 */
function checkAlgebra<V>(name: string, rule: AnyRule, genValue: fc.Arbitrary<V>): void {
  const genEntries = fc
    .array(genEntry(genValue), { maxLength: 12 })
    .map((makers) => makers.map((make, i) => make(i)));

  describe(`${name}: the algebra`, () => {
    it('is order-independent', () => {
      fc.assert(
        fc.property(genEntries, (entries) => {
          if (entries.length === 0) return;
          const expected = show(render(rule, entries));
          fc.assert(
            fc.property(permutation(entries.length), (order) => {
              expect(show(render(rule, reorder(entries, order)))).toBe(expected);
            }),
            { numRuns: 20 },
          );
        }),
        { numRuns: 30 },
      );
    });

    it('is idempotent: duplicates change nothing', () => {
      fc.assert(
        fc.property(genEntries, (entries) => {
          const once = show(render(rule, entries));
          const twice = show(render(rule, [...entries, ...entries]));
          expect(twice).toBe(once);
        }),
        { numRuns: 100 },
      );
    });

    it('is a homomorphism: folding in batches equals folding at once', () => {
      // The property §9.1 and incremental folding depend on. A rule that
      // resolved by scanning its whole input at once would fail here while
      // passing every other test.
      fc.assert(
        fc.property(genEntries, genEntries, (first, rawSecond) => {
          // Disjoint ids across the two bags, for the same reason.
          const second = rawSecond.map((e, i) => ({
            ...e,
            key: { ...e.key, id: labelled(`s${i}`, HASH_LEN) },
          }));
          const batched = rule.merge.step(
            rule.merge.step(rule.merge.empty(), first).acc,
            second,
          ).acc;
          const atOnce = rule.merge.step(rule.merge.empty(), [...first, ...second]).acc;
          expect(show(rule.merge.render(batched))).toBe(show(rule.merge.render(atOnce)));
        }),
        { numRuns: 200 },
      );
    });

    it('an empty bag folds to something', () => {
      // Totality (§3.4): there is no event set that fails to fold.
      expect(() => render(rule, [])).not.toThrow();
    });
  });
}

checkAlgebra('stringRegister', stringRegister as AnyRule, fc.string({ maxLength: 5 }));
checkAlgebra('bytesRegister', bytesRegister as AnyRule, fc.uint8Array({ maxLength: 5 }));
checkAlgebra('flag', flag as AnyRule, fc.boolean());
checkAlgebra(
  'blob',
  blob as AnyRule,
  fc.uint8Array({ minLength: HASH_LEN, maxLength: HASH_LEN }),
);

describe('register', () => {
  it('the highest key wins', () => {
    const entries: Entry<unknown>[] = [
      { key: key(1, 'a', 'x'), value: 'first' },
      { key: key(3, 'a', 'y'), value: 'winner' },
      { key: key(2, 'a', 'z'), value: 'middle' },
    ];
    expect(render(stringRegister as AnyRule, entries)).toBe('winner');
  });

  it('keeps the winning key in the accumulator', () => {
    // §3.7: without the key, a later arrival cannot be resolved against this.
    const acc = stringRegister.merge.step(stringRegister.merge.empty(), [
      { key: key(2, 'a', 'x'), value: 'v' },
    ]).acc;
    expect(acc.key?.lamport).toBe(2);
  });

  it('a late arrival with a lower key does not displace the winner', () => {
    // The case §3.7 exists for: fold, then receive something older.
    const after = stringRegister.merge.step(
      stringRegister.merge.step(stringRegister.merge.empty(), [
        { key: key(5, 'a', 'hi'), value: 'winner' },
      ]).acc,
      [{ key: key(1, 'a', 'lo'), value: 'straggler' }],
    ).acc;
    expect(stringRegister.merge.render(after)).toBe('winner');
  });
});

describe('flag', () => {
  it('is set when the greatest true beats the greatest false', () => {
    expect(
      render(flag as AnyRule, [
        { key: key(1, 'a', 'x'), value: false },
        { key: key(2, 'a', 'y'), value: true },
      ]),
    ).toBe(true);
  });

  it('is cleared by an explicit later false', () => {
    expect(
      render(flag as AnyRule, [
        { key: key(2, 'a', 'y'), value: true },
        { key: key(3, 'a', 'z'), value: false },
      ]),
    ).toBe(false);
  });

  it('is false for an empty bag', () => {
    expect(render(flag as AnyRule, [])).toBe(false);
  });

  it('does not revive on unrelated activity', () => {
    // §3.2: a delete does not lose to "any later write anywhere on the object".
    // Only an explicit false in this bag clears it — anything else would need
    // to read another slice.
    const acc = flag.merge.step(flag.merge.empty(), [
      { key: key(9, 'a', 'kill'), value: true },
    ]).acc;
    expect(flag.merge.render(acc)).toBe(true);
  });
});

describe('codecs', () => {
  it('round-trip their values', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (s) => {
        expect(stringRegister.codec.decode(stringRegister.codec.encode(s))).toBe(s);
      }),
      { numRuns: 100 },
    );
    expect(flag.codec.decode(flag.codec.encode(true))).toBe(true);
    expect(flag.codec.decode(flag.codec.encode(false))).toBe(false);
  });

  it('are canonical: one value, one encoding', () => {
    expect(hex(stringRegister.codec.encode('x'))).toBe(hex(stringRegister.codec.encode('x')));
    expect(hex(flag.codec.encode(true))).toBe(hex(flag.codec.encode(true)));
  });

  it('reject values they do not understand rather than throwing', () => {
    // Totality (§3.4) cannot hold if a codec can throw.
    expect(flag.codec.decode(new Uint8Array(4))).toBeNull();
    expect(blob.codec.decode(new Uint8Array(8))).toBeNull();
    expect(blob.codec.decode(new Uint8Array(HASH_LEN))).not.toBeNull();
  });

  it('a rejected value is skipped by the fold, not fatal', () => {
    const entries: Entry<unknown>[] = [
      { key: key(1, 'a', 'x'), value: true },
      { key: key(2, 'a', 'y'), value: false },
    ];
    expect(() => render(flag as AnyRule, entries)).not.toThrow();
  });
});

describe('rule lookup', () => {
  it('resolves the fixed attribute rules', () => {
    expect(attributeRule(':name').id).toBe('register:string');
    expect(attributeRule(':parent').id).toBe('register:bytes');
    expect(attributeRule(':deleted').id).toBe('flag');
  });

  it('gives an unknown attribute a register rather than dropping it', () => {
    // §3.4: a client that has not heard of an attribute still carries and
    // resolves it.
    expect(attributeRule(':invented-later').id).toBe('register:bytes');
  });

  it('resolves a media type to the blob rule', () => {
    expect(bodyRule('image/png')?.id).toBe('blob');
    expect(bodyRule('text/plain')?.id).toBe('blob');
  });

  it('returns null for a body rule this client does not have', () => {
    expect(bodyRule('sequence')).toBeNull();
    expect(bodyRule(null)).toBeNull();
  });
});
