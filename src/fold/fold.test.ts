import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fold, pathOf } from './fold.js';
import { hex } from './hash.js';
import type { State } from './state.js';
import { contentHash, TestWriter, uuid, writer } from './testkit.js';
import type { Event } from './types.js';
import { ROOT } from './types.js';

/** Canonical, order-independent rendering of state, for equality assertions. */
function snapshot(s: State): string {
  const rows = [...s.objects.entries()]
    .map(([k, o]) => {
      const parts = [
        `uuid=${k}`,
        `parent=${hex(o.parent)}`,
        `name=${o.name ?? '-'}`,
        `content=${o.content === null ? '-' : hex(o.content)}`,
        `pos=${o.pos === null ? '-' : `${o.pos.x},${o.pos.y}`}`,
        `deleted=${o.deleted}`,
        `kind=${o.kind ?? '-'}`,
        `cycleBroken=${o.cycleBroken}`,
      ];
      return parts.join(' ');
    })
    .sort();
  return rows.join('\n');
}

function get(s: State, u: Uint8Array) {
  const o = s.objects.get(hex(u));
  if (o === undefined) throw new Error(`no object ${hex(u)}`);
  return o;
}

describe('commutativity (§1.3)', () => {
  it('any permutation of an event set folds to the same state', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const f = uuid('file');
    const d = uuid('dir');

    const events: Event[] = [
      a.kind(f, 'file'),
      a.name(f, 'notes.txt'),
      a.parent(f, d),
      a.content(f, contentHash('v1')),
      b.name(f, 'renamed.txt'),
      b.content(f, contentHash('v2')),
      a.kind(d, 'dir'),
      a.name(d, 'docs'),
      a.parent(d, ROOT),
      b.deleted(f, true),
      a.content(f, contentHash('v3')),
    ];

    const expected = snapshot(fold(events));

    fc.assert(
      fc.property(fc.shuffledSubarray(events, { minLength: events.length }), (shuffled) => {
        expect(snapshot(fold(shuffled))).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('duplicate events are a no-op', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const events = [a.name(f, 'x'), a.content(f, contentHash('h')), a.deleted(f, true)];

    const once = snapshot(fold(events));
    const twice = snapshot(fold([...events, ...events]));
    expect(twice).toBe(once);
  });

  it('holds under randomly generated event sets', () => {
    // Each writer's own lamports are strictly increasing (§2.2), so no writer
    // ever produces two events with the same stamp. `jump` models observing a
    // peer's event: counter = max(counter, incoming). Generating arbitrary
    // lamports instead would manufacture same-writer ties, which cannot occur
    // and which no total order on (lamport, writer) can resolve.
    const arbEvents = fc
      .array(
        fc.record({
          w: fc.constantFrom('alice', 'bob', 'carol'),
          target: fc.constantFrom('a', 'b', 'c'),
          op: fc.constantFrom('name', 'parent', 'content', 'deleted', 'undelete', 'kind'),
          parent: fc.constantFrom('a', 'b', 'c', 'root'),
          jump: fc.integer({ min: 0, max: 4 }),
          tag: fc.integer({ min: 1, max: 12 }),
        }),
        { minLength: 1, maxLength: 25 },
      )
      .map((specs) => {
        const writers = new Map<string, TestWriter>();
        const wr = (n: string) => {
          let x = writers.get(n);
          if (x === undefined) {
            x = new TestWriter(writer(n));
            writers.set(n, x);
          }
          return x;
        };
        let clock = 0;
        return specs.map((s) => {
          const w = wr(s.w);
          // Simulate having seen peer traffic up to `clock` before writing.
          clock += s.jump;
          w.observe(clock);
          const t = uuid(s.target);
          const p = s.parent === 'root' ? ROOT : uuid(s.parent);
          const e = (() => {
            switch (s.op) {
              case 'name':
                return w.name(t, `n${s.tag}`);
              case 'parent':
                return w.parent(t, p);
              case 'content':
                return w.content(t, contentHash(`h${s.tag}`));
              case 'deleted':
                return w.deleted(t, true);
              case 'undelete':
                return w.deleted(t, false);
              default:
                return w.kind(t, 'file');
            }
          })();
          clock = Math.max(clock, e.lamport);
          return e;
        });
      });

    fc.assert(
      fc.property(arbEvents, (events) => {
        const base = snapshot(fold(events));
        const reversed = snapshot(fold([...events].reverse()));
        expect(reversed).toBe(base);
      }),
      { numRuns: 300 },
    );
  });
});

describe('delete / undelete (§4.5)', () => {
  it('a later live-attr write revives a tombstoned object', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const s = fold([a.deleted(f, true, 5), a.pos(f, { x: 1, y: 1 }, 7)]);
    expect(get(s, f).deleted).toBe(false);
  });

  it('a later delete wins over an earlier live-attr write', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const s = fold([a.deleted(f, true, 5), a.pos(f, { x: 1, y: 1 }, 7), a.deleted(f, true, 9)]);
    expect(get(s, f).deleted).toBe(true);
  });

  it('THE order-dependence trap: tombstone@5, pos@7, delete@9 in every order', () => {
    // A naive incremental fold ("on a live-attr event, clear the tombstone if it
    // beats the tombstone") yields `alive` for 5,9,7 and `deleted` for 5,7,9.
    // The set-level predicate in §4.5 must give `deleted` for all six.
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const kill1 = a.deleted(f, true, 5);
    const move = a.pos(f, { x: 1, y: 1 }, 7);
    const kill2 = a.deleted(f, true, 9);

    const orders: Event[][] = [
      [kill1, move, kill2],
      [kill1, kill2, move],
      [move, kill1, kill2],
      [move, kill2, kill1],
      [kill2, kill1, move],
      [kill2, move, kill1],
    ];
    for (const o of orders) {
      expect(get(fold(o), f).deleted).toBe(true);
    }
  });

  it('explicit undelete counts as a live-attr event', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    expect(get(fold([a.deleted(f, true, 5), a.deleted(f, false, 7)]), f).deleted).toBe(false);
    expect(get(fold([a.deleted(f, false, 5), a.deleted(f, true, 7)]), f).deleted).toBe(true);
  });

  it(':kind does not revive a tombstoned object', () => {
    // §4.5 lists :content, :name, :parent, :pos and :deleted=false. Not :kind.
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    expect(get(fold([a.deleted(f, true, 5), a.kind(f, 'file', 7)]), f).deleted).toBe(true);
  });

  it('concurrent delete and write: the write revives (undelete-wins)', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const f = uuid('file');
    // Same lamport: ties break on writer bytes, and 'bob' > 'alice'.
    const s = fold([a.deleted(f, true, 5), b.content(f, contentHash('x'), 5)]);
    expect(get(s, f).deleted).toBe(false);
  });
});

describe('cycles (§4.1)', () => {
  it('breaks a two-object cycle by re-parenting the smallest UUID to ROOT', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const x = uuid('aaa');
    const y = uuid('bbb');
    const s = fold([a.parent(x, y), b.parent(y, x)]);

    expect(get(s, x).cycleBroken).toBe(true);
    expect(hex(get(s, x).parent)).toBe(hex(ROOT));
    expect(get(s, y).cycleBroken).toBe(false);
    expect(hex(get(s, y).parent)).toBe(hex(x));
  });

  it('is order-independent', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const c = new TestWriter(writer('carol'));
    const x = uuid('aaa');
    const y = uuid('bbb');
    const z = uuid('ccc');
    const events = [a.parent(x, y), b.parent(y, z), c.parent(z, x)];

    const expected = snapshot(fold(events));
    fc.assert(
      fc.property(fc.shuffledSubarray(events, { minLength: 3 }), (sh) => {
        expect(snapshot(fold(sh))).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('breaks a self-parent cycle', () => {
    const a = new TestWriter(writer('alice'));
    const x = uuid('solo');
    const s = fold([a.parent(x, x)]);
    expect(get(s, x).cycleBroken).toBe(true);
    expect(hex(get(s, x).parent)).toBe(hex(ROOT));
  });

  it('leaves acyclic structures alone', () => {
    const a = new TestWriter(writer('alice'));
    const d = uuid('dir');
    const f = uuid('file');
    const s = fold([a.parent(d, ROOT), a.parent(f, d)]);
    expect(get(s, d).cycleBroken).toBe(false);
    expect(get(s, f).cycleBroken).toBe(false);
  });

  it('breaks two independent cycles', () => {
    const a = new TestWriter(writer('alice'));
    const [p, q, r, t] = [uuid('aa'), uuid('bb'), uuid('cc'), uuid('dd')];
    const s = fold([a.parent(p, q), a.parent(q, p), a.parent(r, t), a.parent(t, r)]);
    expect(get(s, p).cycleBroken).toBe(true);
    expect(get(s, r).cycleBroken).toBe(true);
    expect(get(s, q).cycleBroken).toBe(false);
    expect(get(s, t).cycleBroken).toBe(false);
  });
});

describe('totality (§3.5)', () => {
  it('an unknown parent UUID is materialised, not rejected', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const ghost = uuid('ghost');
    const s = fold([a.parent(f, ghost)]);
    expect(s.objects.has(hex(ghost))).toBe(true);
    expect(get(s, ghost).name).toBeNull();
  });

  it('an absent blob is just a content hash with nothing behind it', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const s = fold([a.content(f, contentHash('missing'))]);
    expect(get(s, f).content).not.toBeNull();
  });

  it('an object with no :kind and no :name still folds', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('file');
    const s = fold([a.pos(f, { x: 0, y: 0 })]);
    expect(get(s, f).kind).toBeNull();
    expect(get(s, f).name).toBeNull();
  });

  it('the empty event set folds to empty state', () => {
    expect(fold([]).objects.size).toBe(0);
  });
});

describe('paths (§4.1)', () => {
  it('derives a path by walking :parent and joining :name', () => {
    const a = new TestWriter(writer('alice'));
    const docs = uuid('docs');
    const f = uuid('file');
    const s = fold([
      a.name(docs, 'docs'),
      a.parent(docs, ROOT),
      a.name(f, 'notes.txt'),
      a.parent(f, docs),
    ]);
    expect(pathOf(s, f)).toEqual(['docs', 'notes.txt']);
  });

  it('siblings may share a name (§4.2)', () => {
    const a = new TestWriter(writer('alice'));
    const [f, g] = [uuid('f'), uuid('g')];
    const s = fold([a.name(f, 'same'), a.parent(f, ROOT), a.name(g, 'same'), a.parent(g, ROOT)]);
    expect(pathOf(s, f)).toEqual(['same']);
    expect(pathOf(s, g)).toEqual(['same']);
  });
});
