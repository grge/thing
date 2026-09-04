/**
 * Does the tiered slice model (§3) actually work?
 *
 * The test that matters is `one space, three types` — a filesystem, a chat and
 * a co-edited document as siblings in ONE space, folded by ONE algorithm with
 * no type-specific code in the kernel.
 *
 * Everything else here checks a specific claim ARCHITECTURE.md makes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { childrenOf, fold } from './fold.js';
import { sequence } from './rules.js';
import { type Event, ROOT } from './types.js';
import { logOf, textOf, Writer } from './writer.js';

const SPACE = 'space-key';

/** Fold a shuffled copy, to assert order-independence (§1.1). */
function foldShuffled(events: readonly Event[], order: readonly number[]) {
  const shuffled = order.map((i) => events[i]!);
  return fold(shuffled, SPACE);
}

function permutations(n: number) {
  return fc.shuffledSubarray([...Array(n).keys()], { minLength: n, maxLength: n });
}

describe('the three tiers', () => {
  it('phase 1: only the space key writes the root (§7.2.1)', () => {
    const owner = new Writer(SPACE);
    const mallory = new Writer('mallory');

    owner.set(ROOT, ':kind', 'filesystem');
    owner.set(ROOT, ':writers', [SPACE, 'alice']);
    // Mallory asserts herself into the writer set. This is the attack the
    // naive two-pass fold falls for (§7.2).
    mallory.set(ROOT, ':writers', [SPACE, 'alice', 'mallory']);

    const state = fold(logOf(owner, mallory), SPACE);

    expect(state.root.get(':writers')).toEqual([SPACE, 'alice']);
  });

  it('phase 1 needs no prior state, so the self-grant is inert', () => {
    const owner = new Writer(SPACE);
    const mallory = new Writer('mallory');

    owner.set(ROOT, ':writers', [SPACE]);
    mallory.set(ROOT, ':writers', [SPACE, 'mallory']);
    mallory.set('doc', ':name', 'mallory was here');

    const state = fold(logOf(owner, mallory), SPACE);

    // Not in the writer set, so nothing she wrote is folded (§7).
    expect(state.objects.has('doc')).toBe(false);
  });

  it('phase 2: structure folds without reading any declaration (§3.1)', () => {
    const alice = new Writer(SPACE);
    alice.set(ROOT, ':kind', 'filesystem');
    alice.set('f1', ':name', 'notes.txt');
    alice.set('f1', ':parent', ROOT);
    // A content rule nobody has. Structure must still be correct.
    alice.set('f1', ':kind', 'some-rule-from-the-future');
    alice.set('f1', ':body', { op: 'ins', after: null, body: 'x' });

    const state = fold(logOf(alice), SPACE);
    const f1 = state.objects.get('f1')!;

    expect(f1.attrs.get(':name')).toBe('notes.txt');
    expect(f1.contentRuleMissing).toBe('some-rule-from-the-future');
    expect(f1.content).toBeUndefined();
  });

  it('an unreadable object does not affect its siblings (§3.4)', () => {
    const alice = new Writer(SPACE);
    alice.set('bad', ':kind', 'unknown-rule');
    alice.set('bad', ':body', { op: 'ins', after: null, body: 'x' });
    alice.set('good', ':name', 'fine.txt');
    alice.setBlob('good', 'hash-abc');

    const state = fold(logOf(alice), SPACE);

    expect(state.objects.get('bad')!.contentRuleMissing).toBe('unknown-rule');
    expect(state.objects.get('good')!.content).toBe('hash-abc');
  });
});

describe('the sequence rule (§3.8, the unproven one)', () => {
  it('concurrent inserts at the same anchor converge', () => {
    const a = new Writer('a');
    const b = new Writer('b');

    a.set('doc', ':kind', 'sequence');
    const h = a.insert('doc', null, 'H');
    b.observe(a.events);
    // Both insert after H, without seeing each other.
    a.insert('doc', h, 'A');
    b.insert('doc', h, 'B');

    const events = logOf(a, b);
    const first = textOf(fold(events, SPACE).objects.get('doc')!.content);

    fc.assert(
      fc.property(permutations(events.length), (order) => {
        const got = textOf(foldShuffled(events, order).objects.get('doc')!.content);
        expect(got).toBe(first);
      }),
      { numRuns: 200 },
    );

    expect(first).toHaveLength(3);
    expect(first[0]).toBe('H');
  });

  it('a delete concurrent with an insert keeps the anchor usable', () => {
    const a = new Writer('a');
    const b = new Writer('b');

    a.set('doc', ':kind', 'sequence');
    const x = a.insert('doc', null, 'X');
    const y = a.insert('doc', x, 'Y');
    b.observe(a.events);

    // A deletes Y; B concurrently inserts after Y. The tombstone must hold
    // Y's position or B's insert has nothing to anchor to (§3.8).
    a.remove('doc', y);
    b.insert('doc', y, 'Z');

    const events = logOf(a, b);
    const state = fold(events, SPACE);

    expect(textOf(state.objects.get('doc')!.content)).toBe('XZ');

    fc.assert(
      fc.property(permutations(events.length), (order) => {
        const got = textOf(foldShuffled(events, order).objects.get('doc')!.content);
        expect(got).toBe('XZ');
      }),
      { numRuns: 200 },
    );
  });

  it('an insert with a missing anchor is pending, not fatal (§3.4)', () => {
    const a = new Writer('a');
    a.set('doc', ':kind', 'sequence');
    const first = a.insert('doc', null, 'A');
    const orphanAnchor = a.insert('doc', first, 'B');
    a.insert('doc', orphanAnchor, 'C');

    // Drop B. C now anchors to something absent — the non-causal delivery
    // case (§3.8): B's event exists somewhere, we just have not got it yet.
    const partial = a.events.filter((e) => {
      const v = e.value as { body?: unknown };
      return v.body !== 'B';
    });

    const state = fold(partial, SPACE);
    const doc = state.objects.get('doc')!;

    expect(textOf(doc.content)).toBe('A');
    expect(doc.pending).toHaveLength(1);
  });

  it('the pending event resolves when its anchor arrives', () => {
    const a = new Writer('a');
    a.set('doc', ':kind', 'sequence');
    const first = a.insert('doc', null, 'A');
    const b = a.insert('doc', first, 'B');
    a.insert('doc', b, 'C');

    const full = fold(a.events, SPACE).objects.get('doc')!;
    expect(textOf(full.content)).toBe('ABC');
    expect(full.pending).toBeUndefined();
  });

  it('is idempotent: duplicate events change nothing (§1.1)', () => {
    const a = new Writer('a');
    a.set('doc', ':kind', 'sequence');
    const x = a.insert('doc', null, 'X');
    a.insert('doc', x, 'Y');

    const once = textOf(fold(a.events, SPACE).objects.get('doc')!.content);
    const twice = textOf(fold([...a.events, ...a.events], SPACE).objects.get('doc')!.content);

    expect(twice).toBe(once);
  });

  it('converges under shuffling with three concurrent writers', () => {
    const a = new Writer('a');
    const b = new Writer('b');
    const c = new Writer('c');

    a.set('doc', ':kind', 'sequence');
    const h = a.insert('doc', null, 'h');
    b.observe(a.events);
    c.observe(a.events);

    const p = a.insert('doc', h, 'a');
    b.insert('doc', h, 'b');
    c.insert('doc', h, 'c');
    a.insert('doc', p, 'z');

    const events = logOf(a, b, c);
    const expected = textOf(fold(events, SPACE).objects.get('doc')!.content);

    fc.assert(
      fc.property(permutations(events.length), (order) => {
        const got = textOf(foldShuffled(events, order).objects.get('doc')!.content);
        expect(got).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});

describe('one space, three types', () => {
  /**
   * THE TEST THIS PROTOTYPE EXISTS FOR.
   *
   * A filesystem, a chat and a co-edited document as siblings in one space.
   * If §3's model is coherent, this needs no type-specific code in the fold —
   * only different `:kind` values on different objects.
   */
  function buildSpace() {
    const alice = new Writer(SPACE);
    const bob = new Writer('bob');

    alice.set(ROOT, ':kind', 'filesystem');
    alice.set(ROOT, ':writers', [SPACE, 'bob']);
    bob.observe(alice.events);

    // ── A file. Content is a blob hash; the bytes travel separately (§2.4).
    alice.set('readme', ':name', 'readme.md');
    alice.set('readme', ':parent', ROOT);
    alice.set('readme', ':kind', 'blob');
    alice.setBlob('readme', 'sha256-readme');

    // ── A folder, holding the file.
    alice.set('docs', ':name', 'docs');
    alice.set('docs', ':parent', ROOT);
    alice.set('readme', ':parent', 'docs');

    // ── A chat. §3.3: a parent object whose children are messages. No new
    // rule — each message's content is an ordinary register.
    alice.set('chat', ':name', 'general');
    alice.set('chat', ':parent', ROOT);
    alice.set('chat', ':kind', 'chat');

    alice.set('m1', ':parent', 'chat');
    alice.set('m1', ':kind', 'register');
    alice.set('m1', ':body', 'is this thing on?');

    bob.set('m2', ':parent', 'chat');
    bob.set('m2', ':kind', 'register');
    bob.set('m2', ':body', 'loud and clear');

    // ── A co-edited document. One object, content is a sequence slice.
    alice.set('spec', ':name', 'spec.md');
    alice.set('spec', ':parent', 'docs');
    alice.set('spec', ':kind', 'sequence');

    const h = alice.insert('spec', null, 'H');
    bob.observe(alice.events);
    const i = alice.insert('spec', h, 'i');
    // Bob edits the same document concurrently.
    bob.insert('spec', i, '!');

    return { alice, bob };
  }

  it('folds all three with one algorithm and no type-specific code', () => {
    const { alice, bob } = buildSpace();
    const state = fold(logOf(alice, bob), SPACE);

    // Filesystem: a tree, derived from `:parent` (§3.1 phase 2).
    expect(state.root.get(':kind')).toBe('filesystem');
    const top = childrenOf(state, ROOT).map((o) => o.attrs.get(':name')).sort();
    expect(top).toEqual(['docs', 'general']);

    // The file's content is a blob hash.
    expect(state.objects.get('readme')!.content).toBe('sha256-readme');
    expect(state.objects.get('readme')!.attrs.get(':parent')).toBe('docs');

    // Chat: children of one parent, each an independent register (§3.3).
    const msgs = childrenOf(state, 'chat').map((o) => o.content);
    expect(msgs).toHaveLength(2);
    expect(msgs).toContain('is this thing on?');
    expect(msgs).toContain('loud and clear');

    // Document: a sequence, concurrently edited by two writers.
    expect(textOf(state.objects.get('spec')!.content)).toBe('Hi!');
  });

  it('converges regardless of arrival order, across all three types', () => {
    const { alice, bob } = buildSpace();
    const events = logOf(alice, bob);
    const expected = fold(events, SPACE);

    fc.assert(
      fc.property(permutations(events.length), (order) => {
        const got = foldShuffled(events, order);

        expect(got.root.get(':kind')).toBe(expected.root.get(':kind'));
        expect(got.objects.size).toBe(expected.objects.size);

        for (const [uuid, want] of expected.objects) {
          const have = got.objects.get(uuid)!;
          expect([...have.attrs.entries()].sort()).toEqual([...want.attrs.entries()].sort());
          if (uuid === 'spec') {
            expect(textOf(have.content)).toBe(textOf(want.content));
          } else {
            expect(have.content).toEqual(want.content);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a client without the sequence rule still folds the whole tree', () => {
    const { alice, bob } = buildSpace();
    const state = fold(logOf(alice, bob), SPACE);

    // Simulate a client that lacks `sequence`: the document's content is
    // unreadable, everything else is unaffected (§3.1, §4.1).
    const partial = fold(
      logOf(alice, bob).map((e) =>
        e.target === 'spec' && e.attr === ':kind' ? { ...e, value: 'not-implemented-here' } : e,
      ),
      SPACE,
    );

    expect(partial.objects.get('spec')!.contentRuleMissing).toBe('not-implemented-here');
    expect(partial.objects.get('spec')!.attrs.get(':name')).toBe('spec.md');
    // The rest of the space is identical.
    expect(textOf(state.objects.get('spec')!.content)).toBe('Hi!');
    expect(partial.objects.get('readme')!.content).toBe('sha256-readme');
    expect(childrenOf(partial, 'chat')).toHaveLength(2);
  });

  it('a non-writer cannot write anything (§7)', () => {
    const { alice, bob } = buildSpace();
    const mallory = new Writer('mallory');
    mallory.set('spec', ':name', 'defaced.md');
    mallory.insert('spec', null, 'X');

    const state = fold([...logOf(alice, bob), ...mallory.events], SPACE);

    expect(state.objects.get('spec')!.attrs.get(':name')).toBe('spec.md');
    expect(textOf(state.objects.get('spec')!.content)).toBe('Hi!');
  });
});

describe('the rule contract', () => {
  it('a rule sees one bag and nothing else', () => {
    // Not an assertion about behaviour — a statement about the signature. If
    // this ever needs a second argument, §3's universality claim is in trouble.
    const bag: Event[] = [
      { writer: 'a', seq: 0, lamport: 1, target: 'x', attr: ':body', value: { op: 'ins', after: null, body: 'A' } },
    ];
    expect(sequence.length).toBe(1);
    expect(textOf(sequence(bag).value)).toBe('A');
  });
});

describe('convergence under generated histories', () => {
  /**
   * The strongest available evidence for §3: build a random multi-writer
   * history against the model, then assert every peer folds it identically
   * regardless of arrival order.
   *
   * Random histories rather than hand-written ones, because the failure modes
   * that matter here — a rule that is not commutative, an anchor rule that
   * depends on insertion order — hide from examples chosen by the person who
   * wrote the rule.
   */
  const genHistory = fc
    .array(
      fc.record({
        who: fc.integer({ min: 0, max: 2 }),
        kind: fc.constantFrom('attr', 'ins', 'del', 'msg'),
        obj: fc.constantFrom('doc', 'chat', 'file'),
        payload: fc.string({ minLength: 1, maxLength: 2 }),
        pick: fc.nat(),
        sync: fc.boolean(),
      }),
      { minLength: 5, maxLength: 40 },
    )
    .map((ops) => {
      const ws = [new Writer('w0'), new Writer('w1'), new Writer('w2')];
      const owner = new Writer(SPACE);
      owner.set(ROOT, ':writers', [SPACE, 'w0', 'w1', 'w2']);
      owner.set('doc', ':kind', 'sequence');
      owner.set('chat', ':kind', 'register');
      owner.set('file', ':kind', 'blob');
      for (const w of ws) w.observe(owner.events);

      const elements: string[] = [];
      for (const op of ops) {
        const w = ws[op.who]!;
        // Occasionally let a writer catch up with the others, so histories
        // contain both concurrent and causally-ordered edits.
        if (op.sync) for (const o of ws) if (o !== w) w.observe(o.events);

        switch (op.kind) {
          case 'attr':
            w.set(op.obj, ':name', op.payload);
            break;
          case 'ins': {
            const after = elements.length === 0 ? null : elements[op.pick % elements.length]!;
            elements.push(w.insert('doc', after, op.payload));
            break;
          }
          case 'del':
            if (elements.length > 0) w.remove('doc', elements[op.pick % elements.length]!);
            break;
          case 'msg': {
            const id = `m${op.pick}`;
            w.set(id, ':parent', 'chat');
            w.set(id, ':kind', 'register');
            w.set(id, ':body', op.payload);
            break;
          }
        }
      }
      return logOf(owner, ...ws);
    });

  it('every arrival order yields identical state', () => {
    fc.assert(
      fc.property(genHistory, fc.nat(), (events, seed) => {
        const expected = fold(events, SPACE);

        // A deterministic shuffle driven by the seed, so a failure shrinks.
        const order = [...events.keys()];
        let s = seed + 1;
        for (let i = order.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) % 2147483648;
          const j = s % (i + 1);
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const got = foldShuffled(events, order);

        expect(got.objects.size).toBe(expected.objects.size);
        for (const [uuid, want] of expected.objects) {
          const have = got.objects.get(uuid)!;
          expect([...have.attrs.entries()].sort()).toEqual([...want.attrs.entries()].sort());
          expect(textOf(have.content)).toBe(textOf(want.content));
        }
      }),
      { numRuns: 400 },
    );
  });

  it('is idempotent and associative: duplicates and re-merges change nothing', () => {
    fc.assert(
      fc.property(genHistory, (events) => {
        const once = fold(events, SPACE);
        const twice = fold([...events, ...events.slice(0, events.length >> 1)], SPACE);
        for (const [uuid, want] of once.objects) {
          expect(textOf(twice.objects.get(uuid)!.content)).toBe(textOf(want.content));
        }
      }),
      { numRuns: 200 },
    );
  });
});
