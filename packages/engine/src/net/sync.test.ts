/**
 * Reconciliation, including the case the tip hash exists for.
 *
 * All pure: version vectors in, a plan out. The fork cases are the reason this
 * is worth testing carefully — they are the ones that would otherwise show up
 * as two peers quietly failing to converge.
 */
import { describe, expect, it } from 'vitest';
import { frontiersOf, inSync, PendingEvents, reconcile } from './sync.js';
import type { WireVersionVector } from './protocol.js';

const A = 'aaaa';
const B = 'bbbb';

function vv(entries: Record<string, [number, string]>): WireVersionVector {
  const out: WireVersionVector = {};
  for (const [writer, [frontier, tip]] of Object.entries(entries)) {
    out[writer] = { frontier, tip };
  }
  return out;
}

describe('reconcile', () => {
  it('two empty peers have nothing to do', () => {
    const plan = reconcile({}, {});
    expect(inSync(plan)).toBe(true);
    expect(plan.forked).toHaveLength(0);
  });

  it('identical vectors need no exchange', () => {
    const same = vv({ [A]: [5, 'tip5'] });
    expect(inSync(reconcile(same, same))).toBe(true);
  });

  it('sends what a peer behind me lacks', () => {
    const plan = reconcile(vv({ [A]: [7, 'x'] }), vv({ [A]: [3, 'y'] }));
    expect(plan.send).toEqual([{ writer: A, from: 4 }]);
    expect(plan.want).toHaveLength(0);
  });

  it('asks for what I lack', () => {
    const plan = reconcile(vv({ [A]: [3, 'y'] }), vv({ [A]: [7, 'x'] }));
    expect(plan.want).toEqual([{ writer: A, from: 4 }]);
    expect(plan.send).toHaveLength(0);
  });

  it('asks from zero for a writer I have never seen', () => {
    const plan = reconcile({}, vv({ [B]: [2, 'z'] }));
    expect(plan.want).toEqual([{ writer: B, from: 0 }]);
  });

  it('offers from zero a writer the peer has never seen', () => {
    const plan = reconcile(vv({ [B]: [2, 'z'] }), {});
    expect(plan.send).toEqual([{ writer: B, from: 0 }]);
  });

  it('detects a fork: same frontier, different history', () => {
    // The case the tip exists for. Without it these two peers look identical
    // and would exchange nothing, each believing it was up to date.
    const plan = reconcile(vv({ [A]: [40, 'mine'] }), vv({ [A]: [40, 'theirs'] }));

    expect(plan.forked).toEqual([
      { writer: A, frontier: 40, mine: 'mine', theirs: 'theirs' },
    ]);
    expect(inSync(plan)).toBe(true); // nothing to exchange, and that is the problem
  });

  it('a fork on one writer does not stop the others', () => {
    // §2.3: a fork is confined to one chain. Everything else must still sync,
    // or one bad chain would take a whole space down.
    const plan = reconcile(
      vv({ [A]: [40, 'mine'], [B]: [9, 'shared'] }),
      vv({ [A]: [40, 'theirs'], [B]: [4, 'shared'] }),
    );

    expect(plan.forked.map((f) => f.writer)).toEqual([A]);
    expect(plan.send).toEqual([{ writer: B, from: 5 }]);
  });

  it('does not call differing frontiers a fork', () => {
    // At different distances the vectors cannot tell a fork from a lag — the
    // shorter peer's tip is at a position the longer one does not report. The
    // events settle it: the store rejects a mismatched `prev`.
    const plan = reconcile(vv({ [A]: [40, 'mine'] }), vv({ [A]: [30, 'other'] }));
    expect(plan.forked).toHaveLength(0);
    expect(plan.send).toEqual([{ writer: A, from: 31 }]);
  });

  it('is symmetric: what I send is what they want', () => {
    const mine = vv({ [A]: [7, 'x'], [B]: [1, 'y'] });
    const theirs = vv({ [A]: [3, 'x'], [B]: [4, 'y'] });

    const forward = reconcile(mine, theirs);
    const backward = reconcile(theirs, mine);

    expect(forward.send).toEqual(backward.want);
    expect(forward.want).toEqual(backward.send);
  });
});

describe('PendingEvents', () => {
  const held = <T>(): PendingEvents<T> => new PendingEvents<T>();

  it('holds an event that cannot yet apply', () => {
    const p = held<string>();
    p.hold(A, 5, 'five');
    expect(p.size).toBe(1);
    // Nothing is applicable while the frontier is behind the gap.
    expect(p.drain(A, 2)).toEqual([]);
  });

  it('drains a contiguous run once the gap is filled', () => {
    const p = held<string>();
    p.hold(A, 3, 'three');
    p.hold(A, 4, 'four');
    p.hold(A, 6, 'six'); // still beyond a gap at 5

    expect(p.drain(A, 2)).toEqual(['three', 'four']);
    expect(p.size).toBe(1);
  });

  it('names exactly the gap it needs', () => {
    const p = held<string>();
    p.hold(A, 9, 'nine');
    expect(p.gaps(new Map([[A, 4]]))).toEqual([{ writer: A, from: 5 }]);
  });

  it('asks from zero for a writer with no frontier', () => {
    const p = held<string>();
    p.hold(B, 2, 'two');
    expect(p.gaps(new Map())).toEqual([{ writer: B, from: 0 }]);
  });

  it('reports no gap once the held events are contiguous', () => {
    const p = held<string>();
    p.hold(A, 3, 'three');
    expect(p.gaps(new Map([[A, 2]]))).toEqual([]);
  });

  it('keeps writers independent', () => {
    const p = held<string>();
    p.hold(A, 1, 'a1');
    p.hold(B, 1, 'b1');
    expect(p.drain(A, 0)).toEqual(['a1']);
    expect(p.size).toBe(1);
  });
});

describe('frontiersOf', () => {
  it('drops the tips, keeping the numbers', () => {
    const f = frontiersOf(vv({ [A]: [4, 'x'], [B]: [0, 'y'] }));
    expect([...f]).toEqual([
      [A, 4],
      [B, 0],
    ]);
  });
});
