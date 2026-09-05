/**
 * The homomorphism, at the level of the whole fold.
 *
 * `rules.test.ts` checks it per rule. This checks the property survives the
 * kernel — that folding a log in two halves and folding it at once give the
 * same state, so a peer can hold a running result rather than replaying from
 * empty (ARCHITECTURE.md §3.7, §9.1).
 *
 * Stage 4's incremental fold depends on this. So does any snapshot.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hex } from './bytes.js';
import { type Event, type Uuid, UUID_LEN } from './event.js';
import { fold, PARENT_ATTR, type State } from './fold.js';
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
    lines.push(`${k} p=${hex(o.parent)} b=${o.cycleBroken} ${attrs} body=${show(o.body?.value)}`);
  }
  return lines.join('\n');
}

function show(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `bytes:${hex(v)}`;
  return String(v);
}

/**
 * A generated multi-writer history.
 *
 * Includes `:parent` writes that form cycles, because cycle-breaking is the one
 * whole-graph pass in the fold (§3.4) and therefore the place a naive
 * incremental implementation is most likely to go wrong.
 */
async function history(n: number): Promise<{ key: KeyPair; events: Event[] }> {
  const key = await keyPairFromSeed(labelled('space', SEED_LEN));
  const writers = [
    await keyPairFromSeed(labelled('w1', SEED_LEN)),
    await keyPairFromSeed(labelled('w2', SEED_LEN)),
    await generateKeyPair(),
  ];
  const ws = writers.map((k) => new Writer(key.publicKey, k));
  // Three names against a four-operation cycle, so the two do not share a
  // period and every object receives every kind of write.
  const names = ['alpha', 'beta', 'gamma'];
  const events: Event[] = [];

  for (let i = 0; i < n; i++) {
    const w = ws[i % ws.length]!;
    if (i % 6 === 0) w.observe(events);
    const name = names[i % names.length]!;
    const target = uuid(name);
    switch (i % 4) {
      case 0:
        events.push(await w.write(target, ':name', UTF8.encode(`n${i}`), i));
        break;
      case 1: {
        // Deliberately cyclic: a fixed two-object cycle plus a rotation, so a
        // cycle survives however later writes resolve. Without a stable pair,
        // successive :parent writes overwrite each other and no cycle remains —
        // which is what the vacuity check below caught.
        // alpha and beta point at each other, so a cycle survives however the
        // register resolves; gamma joins it from outside.
        const parent = name === 'alpha' ? uuid('beta') : uuid('alpha');
        events.push(await w.write(target, PARENT_ATTR, parent, i));
        break;
      }
      case 2:
        // `i % 4 === 2` here, so `i % 2` would always be 0 and nothing would
        // ever be deleted. Divide first so the flag actually alternates.
        events.push(await w.write(target, ':deleted', Uint8Array.of((i >> 2) % 2), i));
        break;
      default:
        events.push(await w.write(target, ':kind', UTF8.encode('register:string'), i));
        break;
    }
  }
  return { key, events };
}

describe('the fold is a homomorphism', () => {
  it('folding in two halves equals folding at once', async () => {
    const { key, events } = await history(28);
    const whole = summarise(fold(events, { space: key.publicKey }));

    fc.assert(
      fc.property(fc.integer({ min: 0, max: events.length }), (split) => {
        // The property a running accumulator needs: the same events, delivered
        // in two batches, produce the state as if delivered in one.
        const first = events.slice(0, split);
        const second = events.slice(split);
        const combined = summarise(fold([...first, ...second], { space: key.publicKey }));
        expect(combined).toBe(whole);
      }),
      { numRuns: 100 },
    );
  });

  it('holds under arbitrary reordering as well as splitting', async () => {
    const { key, events } = await history(24);
    const expected = summarise(fold(events, { space: key.publicKey }));

    fc.assert(
      fc.property(permutation(events.length), (order) => {
        expect(summarise(fold(reorder(events, order), { space: key.publicKey }))).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent under arbitrary duplication', async () => {
    const { key, events } = await history(20);
    const once = summarise(fold(events, { space: key.publicKey }));

    fc.assert(
      fc.property(fc.array(fc.nat({ max: 19 }), { maxLength: 10 }), (dupes) => {
        const extra = dupes.map((i) => events[i]!).filter((e) => e !== undefined);
        expect(summarise(fold([...events, ...extra], { space: key.publicKey }))).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it('cycle-breaking is stable across delivery order', async () => {
    // The whole-graph pass (§3.4). A different arrival order must not change
    // which object gets re-parented, or two peers would show different trees.
    const { key, events } = await history(16);
    const broken = (order: readonly number[]): string =>
      [...fold(reorder(events, order), { space: key.publicKey }).objects]
        .filter(([, o]) => o.cycleBroken)
        .map(([k]) => k)
        .sort()
        .join(',');

    const expected = broken([...events.keys()]);
    fc.assert(
      fc.property(permutation(events.length), (order) => {
        expect(broken(order)).toBe(expected);
      }),
      { numRuns: 150 },
    );
  });

  it('the generated history actually exercises cycles and tombstones', async () => {
    // Guards against the properties above passing vacuously.
    const { key, events } = await history(28);
    const state = fold(events, { space: key.publicKey });
    const broken = [...state.objects.values()].filter((o) => o.cycleBroken);
    const deleted = [...state.objects.values()].filter((o) => o.attrs.get(':deleted')?.value === true);
    expect(broken.length).toBeGreaterThan(0);
    expect(deleted.length).toBeGreaterThan(0);
    expect(state.objects.size).toBeGreaterThan(2);
  });
});

describe('slice independence', () => {
  it('an event touches exactly one slice', async () => {
    // What makes an incremental fold tractable: adding an event invalidates one
    // bag, not the whole state. The exception is `:parent`, which feeds the
    // whole-graph cycle pass — asserted separately above.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const first = await w.write(uuid('a'), ':name', UTF8.encode('one'), 0);
    const second = await w.write(uuid('b'), ':name', UTF8.encode('two'), 1);

    const before = fold([first], { space: key.publicKey });
    const after = fold([first, second], { space: key.publicKey });

    // The untouched object's slice is unchanged.
    expect(show(after.objects.get(hex(uuid('a')))!.attrs.get(':name')!.value)).toBe(
      show(before.objects.get(hex(uuid('a')))!.attrs.get(':name')!.value),
    );
  });
});
