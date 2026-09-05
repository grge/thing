/**
 * Stage 0: the scaffold works and the boundaries are real.
 *
 * These are not tests of the design. They check the things a later stage would
 * otherwise discover the hard way: that the workspace wires up, that the shuffle
 * helper every convergence test depends on is not subtly biased, and that
 * `core` genuinely cannot reach the platform.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hex, labelled, permutation, reorder } from './testkit.js';

describe('scaffold', () => {
  it('core has no platform globals', () => {
    // `lib` is ES2022 only, so referencing these would not compile. This checks
    // the runtime too, because the headless peer must not depend on a bundler
    // having shimmed something.
    const g = globalThis as Record<string, unknown>;
    for (const name of ['window', 'document', 'localStorage', 'indexedDB']) {
      expect(g[name], `core must not need ${name}`).toBeUndefined();
    }
  });
});

describe('testkit', () => {
  it('permutation yields every index exactly once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        fc.assert(
          fc.property(permutation(n), (order) => {
            expect([...order].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
          }),
          { numRuns: 20 },
        );
      }),
      { numRuns: 10 },
    );
  });

  it('permutation actually permutes', () => {
    // A generator that always returned identity would pass every
    // order-independence test while checking nothing.
    const seen = new Set<string>();
    fc.assert(
      fc.property(permutation(6), (order) => {
        seen.add(order.join(','));
      }),
      { numRuns: 100 },
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('reorder is a permutation of its input', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 12 }), (items) => {
        fc.assert(
          fc.property(permutation(items.length), (order) => {
            const out = reorder(items, order);
            expect(out).toHaveLength(items.length);
            expect([...out].sort()).toEqual([...items].sort());
          }),
          { numRuns: 20 },
        );
      }),
      { numRuns: 20 },
    );
  });

  it('labelled is deterministic and correctly sized', () => {
    expect(hex(labelled('alice', 4))).toBe(hex(labelled('alice', 4)));
    expect(labelled('alice', 32)).toHaveLength(32);
    expect(hex(labelled('a', 2))).toBe('6100');
  });
});
