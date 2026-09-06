/**
 * `deps`: judging permission by what a writer had seen (§7.2.3).
 *
 * The property that matters is not any single scenario but that **the two folds
 * agree**. A full replay and an incremental fold over the same events must
 * produce the same state, or a peer's view depends on whether it restarted —
 * which is the fork §7.2.3 exists to prevent and a violation of §3.6.
 */
import { describe, expect, it } from 'vitest';

import { hex } from './bytes.js';
import { generateKeyPair, type KeyPair, keyPairFromSeed, SEED_LEN } from './sign.js';
import { type Event, ROOT } from './event.js';
import { fold } from './fold.js';
import { Folder } from './incremental.js';
import { Writer } from './writer.js';
import { labelled, permutation, reorder } from './testkit.js';
import fc from 'fast-check';

const UTF8 = new TextEncoder();
const uuid = (s: string): Uint8Array => labelled(s, 16);

/** A history where writers are added *and removed* — the gap that hid this bug. */
async function history(seed: number): Promise<{ key: KeyPair; events: Event[] }> {
  const key = await keyPairFromSeed(labelled('space', SEED_LEN));
  const people = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  const owner = new Writer(key.publicKey, key);
  const writers = people.map((k) => new Writer(key.publicKey, k));

  const events: Event[] = [];
  const members = new Set<string>();
  let rand = seed >>> 0;
  const next = (): number => {
    rand = (rand * 1664525 + 1013904223) >>> 0;
    return rand / 4294967296;
  };

  for (let i = 0; i < 24; i++) {
    if (next() < 0.3) {
      const who = Math.floor(next() * people.length);
      const k = hex(people[who]!.publicKey);
      if (members.has(k) && next() < 0.6) members.delete(k);
      else members.add(k);
      const e = await owner.write(ROOT, ':writers', UTF8.encode([...members].sort().join(',')), i);
      events.push(e);
      // Everyone who is online sees it.
      for (const w of writers) w.observe([e]);
      owner.observe([e]);
    } else {
      const who = Math.floor(next() * writers.length);
      const e = await writers[who]!.write(uuid(`o${i % 4}`), ':name', UTF8.encode(`v${i}`), i);
      events.push(e);
      owner.observe([e]);
      // Partial sync: others may or may not have seen it.
      for (const w of writers) if (next() < 0.6) w.observe([e]);
    }
  }
  return { key, events };
}

function names(state: { objects: ReadonlyMap<string, { attrs: ReadonlyMap<string, { value: unknown }> }> }): string {
  return [...state.objects.entries()]
    .map(([id, o]) => `${id.slice(0, 6)}=${String(o.attrs.get(':name')?.value ?? '')}`)
    .sort()
    .join(',');
}

describe('deps and permission', () => {
  it('a full fold and an incremental fold agree', async () => {
    // The invariant. Before `deps` these disagreed whenever a writer was
    // removed: the replay dropped everything they had ever written.
    for (let seed = 1; seed <= 20; seed++) {
      const { key, events } = await history(seed);
      const replayed = fold(events, { space: key.publicKey });

      const folder = new Folder(key.publicKey);
      for (const e of events) folder.apply([e]); // one at a time, as they arrive
      expect(names(folder.state)).toBe(names(replayed));
    }
  });

  it('the full fold does not depend on arrival order', async () => {
    const { key, events } = await history(7);
    await fc.assert(
      fc.asyncProperty(permutation(events.length), async (order) => {
        const shuffled = reorder(events, order);
        expect(names(fold(shuffled, { space: key.publicKey }))).toBe(
          names(fold(events, { space: key.publicKey })),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('the incremental fold does not depend on arrival order', async () => {
    const { key, events } = await history(11);
    const reference = names(fold(events, { space: key.publicKey }));
    await fc.assert(
      fc.asyncProperty(permutation(events.length), async (order) => {
        const folder = new Folder(key.publicKey);
        for (const e of reorder(events, order)) folder.apply([e]);
        expect(names(folder.state)).toBe(reference);
      }),
      { numRuns: 50 },
    );
  });

  it('claiming to have seen nothing does not bypass membership', async () => {
    // `deps` is self-reported, so an empty set costs nothing to claim. An event
    // whose past holds no declaration is judged against the *earliest* one,
    // rather than admitted for having seen none.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const mallory = await generateKeyPair();

    const owner = new Writer(key.publicKey, key);
    const restrict = await owner.write(ROOT, ':writers', UTF8.encode(hex(key.publicKey)), 0);

    // Never observes anything, so writes with empty deps.
    const bad = new Writer(key.publicKey, mallory);
    const sneak = await bad.write(uuid('doc'), ':name', UTF8.encode('defaced'), 1);

    const state = fold([restrict, sneak], { space: key.publicKey });
    expect(state.objects.has(hex(uuid('doc')))).toBe(false);
  });

  it('deps stay narrow: one head after each write', async () => {
    // A write consumes the heads it names and becomes the only one, which is
    // what bounds `deps` by concurrency rather than by log length.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const a = await w.write(uuid('x'), ':name', UTF8.encode('one'), 0);
    const b = await w.write(uuid('x'), ':name', UTF8.encode('two'), 1);
    const c = await w.write(uuid('x'), ':name', UTF8.encode('three'), 2);

    expect(a.deps).toHaveLength(0);
    expect(b.deps).toHaveLength(1);
    expect(c.deps).toHaveLength(1);
  });
});
