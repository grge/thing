/**
 * The fold (ARCHITECTURE.md §3).
 *
 * The claim under test: one kernel, no per-application code, and a filesystem
 * and a chat folding side by side in one space. Plus the three phases behaving
 * as §3.1 says — most importantly that phase 2 needs no declaration, so a
 * client can always compute a space's structure.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hex } from './bytes.js';
import { type Event, ROOT, type Uuid, UUID_LEN } from './event.js';
import { attr, BODY_ATTR, childrenOf, fold, pathOf, type State } from './fold.js';
import { generateKeyPair, type KeyPair, keyPairFromSeed, SEED_LEN } from './sign.js';
import { labelled, permutation, reorder } from './testkit.js';
import { Writer } from './writer.js';

const UTF8 = new TextEncoder();
const text = (s: string): Uint8Array => UTF8.encode(s);
const uuid = (label: string): Uuid => labelled(label, UUID_LEN);

async function spaceKey(): Promise<KeyPair> {
  return keyPairFromSeed(labelled('space', SEED_LEN));
}

/** Fold with the space's own key as the authority (§7.2.1). */
function foldWith(space: KeyPair, events: readonly Event[]): State {
  return fold(events, { space: space.publicKey });
}

describe('phase 1: the root', () => {
  it('admits root events from the space key', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const e = await w.write(ROOT, ':writers', text(hex(key.publicKey)), 0);
    expect(foldWith(key, [e]).root.get(':writers')?.value).toBe(hex(key.publicKey));
  });

  it('drops root events from anyone else', async () => {
    // The attack §7.2 describes: a stranger writing themselves into the writer
    // set. Phase 1 consults no state, so the self-grant is inert.
    const key = await spaceKey();
    const mallory = await generateKeyPair();

    const owner = new Writer(key.publicKey, key);
    const good = await owner.write(ROOT, ':writers', text(hex(key.publicKey)), 0);

    const bad = new Writer(key.publicKey, mallory);
    const forged = await bad.write(ROOT, ':writers', text('mallory'), 0);

    expect(foldWith(key, [good, forged]).root.get(':writers')?.value).toBe(hex(key.publicKey));
  });

  it('a non-writer cannot write anywhere', async () => {
    const key = await spaceKey();
    const mallory = await generateKeyPair();

    const owner = new Writer(key.publicKey, key);
    const declare = await owner.write(ROOT, ':writers', text(hex(key.publicKey)), 0);

    const bad = new Writer(key.publicKey, mallory);
    const sneak = await bad.write(uuid('doc'), ':name', text('defaced'), 0);

    const state = foldWith(key, [declare, sneak]);
    expect(state.objects.has(hex(uuid('doc')))).toBe(false);
  });

  it('admits everyone when no writer set is declared', async () => {
    // The single-writer case: the space key is the only writer, and no set is
    // needed to say so.
    const key = await spaceKey();
    const other = await generateKeyPair();
    const w = new Writer(key.publicKey, other);
    const e = await w.write(uuid('doc'), ':name', text('fine'), 0);
    expect(attr(foldWith(key, [e]).objects.get(hex(uuid('doc')))!, ':name')).toBe('fine');
  });
});

describe('phase 2: structure', () => {
  it('folds names, parents and kinds with no declaration', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('f1'), ':name', text('notes.txt'), 0),
      await w.write(uuid('f1'), ':parent', ROOT, 0),
      await w.write(uuid('f1'), ':kind', text('text/plain'), 0),
    ];
    const o = foldWith(key, events).objects.get(hex(uuid('f1')))!;
    expect(attr(o, ':name')).toBe('notes.txt');
    expect(attr(o, ':kind')).toBe('text/plain');
  });

  it('folds structure even when the body rule is unknown', async () => {
    // §3.1's central claim: an unrecognised body costs one object's contents,
    // never a space's structure.
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('doc'), ':name', text('spec.md'), 0),
      await w.write(uuid('doc'), ':kind', text('sequence'), 0),
      await w.write(uuid('doc'), BODY_ATTR, text('some op'), 0),
    ];
    const o = foldWith(key, events).objects.get(hex(uuid('doc')))!;
    expect(attr(o, ':name')).toBe('spec.md');
    expect(o.bodyRuleMissing).toBe('sequence');
    expect(o.body).toBeUndefined();
  });

  it('an unreadable object does not affect its siblings', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('bad'), ':kind', text('not-a-rule'), 0),
      await w.write(uuid('bad'), BODY_ATTR, text('x'), 0),
      await w.write(uuid('good'), ':name', text('fine.txt'), 0),
      await w.write(uuid('good'), ':kind', text('image/png'), 0),
      await w.write(uuid('good'), BODY_ATTR, new Uint8Array(32), 0),
    ];
    const state = foldWith(key, events);
    expect(state.objects.get(hex(uuid('bad')))!.bodyRuleMissing).toBe('not-a-rule');
    expect(state.objects.get(hex(uuid('good')))!.body?.value).toBeInstanceOf(Uint8Array);
  });

  it('materialises an object named only as a parent', async () => {
    // Totality (§3.4): an unknown parent is legal and still appears.
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const e = await w.write(uuid('child'), ':parent', uuid('ghost'), 0);
    const state = foldWith(key, [e]);
    expect(state.objects.has(hex(uuid('ghost')))).toBe(true);
  });
});

describe('cycle breaking', () => {
  it('breaks a two-object cycle deterministically', async () => {
    // §3.4: the smallest UUID in the cycle is re-parented to the root, and the
    // resolution is fold-local — never written back as an event.
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('aaa'), ':parent', uuid('bbb'), 0),
      await w.write(uuid('bbb'), ':parent', uuid('aaa'), 0),
    ];
    const state = foldWith(key, events);
    const a = state.objects.get(hex(uuid('aaa')))!;
    const b = state.objects.get(hex(uuid('bbb')))!;

    expect(a.cycleBroken).toBe(true);
    expect(hex(a.parent)).toBe(hex(ROOT));
    expect(b.cycleBroken).toBe(false);
  });

  it('breaks a self-parent', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const e = await w.write(uuid('loop'), ':parent', uuid('loop'), 0);
    const o = foldWith(key, [e]).objects.get(hex(uuid('loop')))!;
    expect(o.cycleBroken).toBe(true);
    expect(hex(o.parent)).toBe(hex(ROOT));
  });

  it('breaks two independent cycles', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('a1'), ':parent', uuid('a2'), 0),
      await w.write(uuid('a2'), ':parent', uuid('a1'), 0),
      await w.write(uuid('b1'), ':parent', uuid('b2'), 0),
      await w.write(uuid('b2'), ':parent', uuid('b1'), 0),
    ];
    const state = foldWith(key, events);
    const broken = [...state.objects.values()].filter((o) => o.cycleBroken);
    expect(broken).toHaveLength(2);
  });

  it('leaves an acyclic tree alone, and pathOf terminates', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('dir'), ':name', text('docs'), 0),
      await w.write(uuid('dir'), ':parent', ROOT, 0),
      await w.write(uuid('file'), ':name', text('a.txt'), 0),
      await w.write(uuid('file'), ':parent', uuid('dir'), 0),
    ];
    const state = foldWith(key, events);
    expect(state.objects.get(hex(uuid('file')))!.cycleBroken).toBe(false);
    expect(pathOf(state, uuid('file'))).toEqual(['docs', 'a.txt']);
  });

  it('pathOf terminates even through a broken cycle', async () => {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('aaa'), ':parent', uuid('bbb'), 0),
      await w.write(uuid('bbb'), ':parent', uuid('aaa'), 0),
    ];
    const state = foldWith(key, events);
    expect(() => pathOf(state, uuid('bbb'))).not.toThrow();
  });
});

describe('one space, two kinds of thing', () => {
  /**
   * A filesystem and a chat as siblings in one space, folded by one kernel
   * with no per-application code. The test §3 exists for.
   */
  async function build() {
    const key = await spaceKey();
    const w = new Writer(key.publicKey, key);
    const events: Event[] = [];
    const add = async (t: Uuid, a: string, v: Uint8Array) =>
      events.push(await w.write(t, a, v, events.length));

    // A folder holding a file.
    await add(uuid('docs'), ':name', text('docs'));
    await add(uuid('docs'), ':parent', ROOT);
    await add(uuid('readme'), ':name', text('readme.md'));
    await add(uuid('readme'), ':parent', uuid('docs'));
    await add(uuid('readme'), ':kind', text('text/markdown'));
    await add(uuid('readme'), BODY_ATTR, labelled('sha-readme', 32));

    // A chat: a folder whose children are messages (§3.3).
    await add(uuid('chat'), ':name', text('general'));
    await add(uuid('chat'), ':parent', ROOT);
    await add(uuid('m1'), ':parent', uuid('chat'));
    await add(uuid('m1'), ':kind', text('register:string'));
    await add(uuid('m1'), BODY_ATTR, text('is this thing on?'));
    await add(uuid('m2'), ':parent', uuid('chat'));
    await add(uuid('m2'), ':kind', text('register:string'));
    await add(uuid('m2'), BODY_ATTR, text('loud and clear'));

    return { key, events };
  }

  it('folds both with one kernel', async () => {
    const { key, events } = await build();
    const state = foldWith(key, events);

    // Filesystem: a tree derived from :parent.
    const top = childrenOf(state, ROOT)
      .map((o) => attr(o, ':name'))
      .sort();
    expect(top).toEqual(['docs', 'general']);
    expect(state.objects.get(hex(uuid('readme')))!.body?.value).toEqual(labelled('sha-readme', 32));

    // Chat: independent children, each an ordinary register (§3.3).
    const messages = childrenOf(state, uuid('chat')).map((o) => o.body?.value);
    expect(messages).toHaveLength(2);
    expect(messages).toContain('is this thing on?');
    expect(messages).toContain('loud and clear');
  });

  it('converges under every arrival order', async () => {
    const { key, events } = await build();
    const expected = summarise(foldWith(key, events));

    fc.assert(
      fc.property(permutation(events.length), (order) => {
        expect(summarise(foldWith(key, reorder(events, order)))).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent under duplicate delivery', async () => {
    const { key, events } = await build();
    expect(summarise(foldWith(key, [...events, ...events]))).toBe(
      summarise(foldWith(key, events)),
    );
  });
});

/** A comparable rendering of a whole state, for convergence assertions. */
function summarise(state: State): string {
  const lines: string[] = [];
  for (const [k, o] of [...state.objects].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const attrs = [...o.attrs]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, s]) => `${name}=${show(s.value)}`)
      .join(',');
    lines.push(
      `${k} parent=${hex(o.parent)} broken=${o.cycleBroken} ${attrs} body=${show(o.body?.value)}`,
    );
  }
  return lines.join('\n');
}

function show(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `bytes:${hex(v)}`;
  return String(v);
}

describe('multi-writer convergence', () => {
  it('generated histories fold identically under every order', async () => {
    // Concurrent writes to different objects and to the same attribute, from
    // three writers, with occasional catch-up so histories contain both
    // concurrent and causally-ordered edits.
    const key = await spaceKey();
    const writers = await Promise.all([
      generateKeyPair(),
      generateKeyPair(),
      keyPairFromSeed(labelled('third', SEED_LEN)),
    ]);

    const ws = writers.map((k) => new Writer(key.publicKey, k));
    const events: Event[] = [];
    const targets = ['alpha', 'beta', 'gamma'];

    for (let i = 0; i < 24; i++) {
      const w = ws[i % ws.length]!;
      if (i % 5 === 0) w.observe(events);
      const t = uuid(targets[i % targets.length]!);
      const a = i % 3 === 0 ? ':name' : i % 3 === 1 ? ':parent' : ':deleted';
      const v =
        a === ':name'
          ? text(`n${i}`)
          : a === ':parent'
            ? uuid(targets[(i + 1) % targets.length]!)
            : Uint8Array.of(i % 2);
      events.push(await w.write(t, a, v, i));
    }

    const expected = summarise(foldWith(key, events));
    fc.assert(
      fc.property(permutation(events.length), (order) => {
        expect(summarise(foldWith(key, reorder(events, order)))).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});
