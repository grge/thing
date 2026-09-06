/**
 * The incremental fold must agree with a full refold. Always.
 *
 * This is the guarantee stage 4 rests on: a peer that has been running for a
 * week and one that just restarted and replayed the log must hold identical
 * state. Anything less is a divergence that only appears under load, in
 * production, between two peers that both believe they are correct.
 *
 * Checked over generated histories rather than examples, and in every delivery
 * order and batching, because that is where an incremental implementation goes
 * wrong — a rule that looks right applied to a whole bag can be wrong applied
 * one event at a time.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hex } from './bytes.js';
import { type Event, ROOT, type Uuid, UUID_LEN } from './event.js';
import { BODY_ATTR, fold, PARENT_ATTR, type State } from './fold.js';
import { Folder } from './incremental.js';
import { generateKeyPair, type KeyPair, keyPairFromSeed, SEED_LEN } from './sign.js';
import { labelled, permutation, reorder } from './testkit.js';
import { Writer } from './writer.js';

const UTF8 = new TextEncoder();
const uuid = (label: string): Uuid => labelled(label, UUID_LEN);

/** A comparable rendering of a whole state. */
function summarise(state: State): string {
  const lines: string[] = [];
  for (const [k, o] of [...state.objects].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const attrs = [...o.attrs]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, s]) => `${name}=${show(s.value)}`)
      .join(',');
    lines.push(
      `${k} p=${hex(o.parent)} b=${o.cycleBroken} ${attrs}` +
        ` body=${show(o.body?.value)} missing=${o.bodyRuleMissing ?? '-'}`,
    );
  }
  const root = [...state.root]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, s]) => `${name}=${show(s.value)}`)
    .join(',');
  return `root(${root})\n${lines.join('\n')}`;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `bytes:${hex(v)}`;
  return String(v);
}

/** Fold incrementally, one event at a time. */
function incremental(space: Uint8Array, events: readonly Event[]): State {
  const folder = new Folder(space);
  for (const e of events) folder.apply([e]);
  return folder.state;
}

/**
 * A generated history covering every path the incremental fold has.
 *
 * Includes cycles (the whole-graph pass), tombstones, bodies whose `:kind`
 * arrives *after* their content, and an unknown body rule.
 */
async function history(n: number): Promise<{ key: KeyPair; events: Event[] }> {
  const key = await keyPairFromSeed(labelled('space', SEED_LEN));
  const ws = [
    new Writer(key.publicKey, key),
    new Writer(key.publicKey, await keyPairFromSeed(labelled('w2', SEED_LEN))),
    new Writer(key.publicKey, await generateKeyPair()),
  ];
  const names = ['alpha', 'beta', 'gamma'];
  const events: Event[] = [];

  for (let i = 0; i < n; i++) {
    const w = ws[i % ws.length]!;
    if (i % 6 === 0) w.observe(events);
    const name = names[i % names.length]!;
    const target = uuid(name);

    switch (i % 5) {
      case 0:
        events.push(await w.write(target, ':name', UTF8.encode(`n${i}`), i));
        break;
      case 1:
        // alpha and beta point at each other, so a cycle survives.
        events.push(
          await w.write(target, PARENT_ATTR, name === 'alpha' ? uuid('beta') : uuid('alpha'), i),
        );
        break;
      case 2:
        events.push(await w.write(target, ':deleted', Uint8Array.of((i >> 2) % 2), i));
        break;
      case 3:
        // A body written before any `:kind` exists for this object, so the
        // incremental path must reinterpret it when the kind arrives.
        events.push(await w.write(target, BODY_ATTR, UTF8.encode(`body${i}`), i));
        break;
      default:
        events.push(
          await w.write(target, ':kind', UTF8.encode(i % 10 === 4 ? 'register:string' : 'unknown-rule'), i),
        );
        break;
    }
  }
  return { key, events };
}

describe('Folder agrees with fold', () => {
  it('event by event, in log order', async () => {
    const { key, events } = await history(30);
    expect(summarise(incremental(key.publicKey, events))).toBe(
      summarise(fold(events, { space: key.publicKey })),
    );
  });

  it('event by event, in any order', async () => {
    const { key, events } = await history(24);

    fc.assert(
      fc.property(permutation(events.length), (order) => {
        const shuffled = reorder(events, order);
        expect(summarise(incremental(key.publicKey, shuffled))).toBe(
          summarise(fold(shuffled, { space: key.publicKey })),
        );
      }),
      { numRuns: 150 },
    );
  });

  it('in arbitrary batches', async () => {
    // A peer receives events in whatever groupings the network delivers, and
    // the result must not depend on the grouping.
    const { key, events } = await history(24);
    const expected = summarise(fold(events, { space: key.publicKey }));

    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 12 }), (sizes) => {
        const folder = new Folder(key.publicKey);
        let at = 0;
        for (const size of sizes) {
          if (at >= events.length) break;
          folder.apply(events.slice(at, at + size));
          at += size;
        }
        if (at < events.length) folder.apply(events.slice(at));
        expect(summarise(folder.state)).toBe(expected);
      }),
      { numRuns: 150 },
    );
  });

  it('under duplicate delivery', async () => {
    const { key, events } = await history(20);
    const folder = new Folder(key.publicKey);
    folder.apply(events);
    folder.apply(events);
    expect(summarise(folder.state)).toBe(summarise(fold(events, { space: key.publicKey })));
  });

  it('reading state repeatedly does not change it', async () => {
    const { key, events } = await history(16);
    const folder = new Folder(key.publicKey);
    folder.apply(events);
    const first = summarise(folder.state);
    expect(summarise(folder.state)).toBe(first);
    expect(summarise(folder.state)).toBe(first);
  });

  it('the generated history exercises every path', async () => {
    // Guards the properties above against passing vacuously.
    const { key, events } = await history(30);
    const state = fold(events, { space: key.publicKey });
    const objects = [...state.objects.values()];

    expect(objects.filter((o) => o.cycleBroken).length).toBeGreaterThan(0);
    expect(objects.filter((o) => o.attrs.get(':deleted')?.value === true).length).toBeGreaterThan(0);
    expect(objects.filter((o) => o.bodyRuleMissing !== undefined).length).toBeGreaterThan(0);
    expect(objects.filter((o) => o.body !== undefined).length).toBeGreaterThan(0);
  });
});

describe('Folder: the tricky paths', () => {
  it('reinterprets a body when its :kind arrives afterwards', async () => {
    // The body is written before anything says what it is. A naive incremental
    // fold would decode it under no rule and never revisit it.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const body = await w.write(uuid('doc'), BODY_ATTR, UTF8.encode('hello'), 0);
    const kind = await w.write(uuid('doc'), ':kind', UTF8.encode('register:string'), 1);

    const folder = new Folder(key.publicKey);
    folder.apply([body]);
    expect(folder.state.objects.get(hex(uuid('doc')))!.body).toBeUndefined();

    folder.apply([kind]);
    expect(folder.state.objects.get(hex(uuid('doc')))!.body?.value).toBe('hello');
  });

  it('admits events from a writer added later', async () => {
    // The writer set can grow. An event that arrived before its writer was
    // admitted must be reconsidered, or state would depend on arrival order.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await keyPairFromSeed(labelled('other', SEED_LEN));

    const owner = new Writer(key.publicKey, key);
    const restrict = await owner.write(ROOT, ':writers', UTF8.encode(hex(key.publicKey)), 0);

    const stranger = new Writer(key.publicKey, other);
    const write = await stranger.write(uuid('doc'), ':name', UTF8.encode('mine'), 0);

    const admit = await owner.write(
      ROOT,
      ':writers',
      UTF8.encode(`${hex(key.publicKey)},${hex(other.publicKey)}`),
      1,
    );

    const folder = new Folder(key.publicKey);
    folder.apply([restrict, write]);
    expect(folder.state.objects.has(hex(uuid('doc')))).toBe(false);

    // **Still not admitted**, and this changed with `deps` (§7.2.3). The
    // stranger wrote having seen nothing — their event's `deps` are empty — so
    // they are judged against the writer set as it stood at the earliest
    // declaration, which excludes them. Being admitted *later* does not
    // retroactively authorise what they wrote before.
    //
    // The alternative would let anyone bypass membership entirely by claiming
    // to have seen no declaration, since naming an empty past costs nothing.
    folder.apply([admit]);
    expect(folder.state.objects.has(hex(uuid('doc')))).toBe(false);
  });

  it('admits a writer who saw their own admission', async () => {
    // The other half of the rule above: a writer who *did* see the event
    // admitting them folds normally, which is the ordinary case.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await generateKeyPair();

    const owner = new Writer(key.publicKey, key);
    const restrict = await owner.write(ROOT, ':writers', UTF8.encode(hex(key.publicKey)), 0);
    const admit = await owner.write(
      ROOT,
      ':writers',
      UTF8.encode(`${hex(key.publicKey)},${hex(other.publicKey)}`),
      1,
    );

    const newcomer = new Writer(key.publicKey, other);
    newcomer.observe([restrict, admit]);
    const write = await newcomer.write(uuid('doc'), ':name', UTF8.encode('mine'), 2);

    const folder = new Folder(key.publicKey);
    folder.apply([restrict, admit, write]);
    expect(folder.state.objects.get(hex(uuid('doc')))!.attrs.get(':name')?.value).toBe('mine');
  });

  it('recomputes the tree when a parent write breaks a cycle', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const first = await w.write(uuid('aaa'), PARENT_ATTR, uuid('bbb'), 0);
    const second = await w.write(uuid('bbb'), PARENT_ATTR, uuid('aaa'), 1);

    const folder = new Folder(key.publicKey);
    folder.apply([first]);
    expect(folder.state.objects.get(hex(uuid('aaa')))!.cycleBroken).toBe(false);

    folder.apply([second]);
    expect(folder.state.objects.get(hex(uuid('aaa')))!.cycleBroken).toBe(true);
  });
});
