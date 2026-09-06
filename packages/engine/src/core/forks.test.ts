/**
 * Resolving a forked chain (§7.3).
 *
 * A fork is two events at one `(writer, point, seq)` with the same `prev`, both
 * validly signed. Append points mean honest software cannot produce one, so
 * these are all staged deliberately — which is the point: what matters is that
 * every peer picks the same branch, not that the pick is fair.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { hex } from './bytes.js';
import { type Event, eventId, ROOT } from './event.js';
import { fold } from './fold.js';
import { Folder } from './incremental.js';
import { generateKeyPair, type KeyPair, keyPairFromSeed, SEED_LEN } from './sign.js';
import { labelled, permutation, point, reorder } from './testkit.js';
import { Writer } from './writer.js';

const UTF8 = new TextEncoder();
const uuid = (s: string): Uint8Array => labelled(s, 16);

/** Two writers on one chain: the same key, the same point. A staged fork. */
async function forkedPair(
  key: KeyPair,
  writerKey: KeyPair,
  a: string,
  b: string,
): Promise<{ left: Event; right: Event }> {
  const shared = point('shared');
  const one = new Writer(key.publicKey, writerKey, {
    point: shared, seq: 0, prev: null, lamport: 0, heads: [],
  });
  const two = new Writer(key.publicKey, writerKey, {
    point: shared, seq: 0, prev: null, lamport: 0, heads: [],
  });
  return {
    left: await one.write(uuid('doc'), ':name', UTF8.encode(a), 1),
    right: await two.write(uuid('doc'), ':name', UTF8.encode(b), 2),
  };
}

function nameOf(state: ReturnType<typeof fold>): string | undefined {
  const o = state.objects.get(hex(uuid('doc')));
  return o?.attrs.get(':name')?.value as string | undefined;
}

describe('fork resolution', () => {
  it('picks the lower event id, and only one branch folds', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const { left, right } = await forkedPair(key, key, 'left', 'right');

    const lower = hex(eventId(key.publicKey, left)) < hex(eventId(key.publicKey, right))
      ? 'left'
      : 'right';

    expect(nameOf(fold([left, right], { space: key.publicKey }))).toBe(lower);
  });

  it('does not depend on which branch arrived first', async () => {
    // The property that matters. Two peers that received the branches in
    // different orders must still agree — otherwise the network partitions.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const { left, right } = await forkedPair(key, key, 'left', 'right');

    const forward = nameOf(fold([left, right], { space: key.publicKey }));
    const backward = nameOf(fold([right, left], { space: key.publicKey }));
    expect(forward).toBe(backward);
  });

  it('drops what descends from the losing branch', async () => {
    // A loser's successors name a `prev` that no longer counts, so they cannot
    // be folded either — otherwise state would depend on a dropped event.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const shared = point('shared');
    const mk = (): Writer =>
      new Writer(key.publicKey, key, { point: shared, seq: 0, prev: null, lamport: 0, heads: [] });

    const one = mk();
    const two = mk();
    const a0 = await one.write(uuid('doc'), ':name', UTF8.encode('a0'), 1);
    const b0 = await two.write(uuid('doc'), ':name', UTF8.encode('b0'), 2);
    // Each branch continues, writing to a different object so the effect shows.
    const a1 = await one.write(uuid('from-a'), ':name', UTF8.encode('a1'), 3);
    const b1 = await two.write(uuid('from-b'), ':name', UTF8.encode('b1'), 4);

    const state = fold([a0, b0, a1, b1], { space: key.publicKey });
    const aWon = hex(eventId(key.publicKey, a0)) < hex(eventId(key.publicKey, b0));

    expect(state.objects.has(hex(uuid('from-a')))).toBe(aWon);
    expect(state.objects.has(hex(uuid('from-b')))).toBe(!aWon);
  });

  it('leaves an unforked log untouched', async () => {
    // The overwhelmingly common case, and it must cost nothing.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const w = new Writer(key.publicKey, key);
    const events = [
      await w.write(uuid('doc'), ':name', UTF8.encode('one'), 1),
      await w.write(uuid('doc'), ':name', UTF8.encode('two'), 2),
    ];
    expect(nameOf(fold(events, { space: key.publicKey }))).toBe('two');
  });

  it('a fork on one chain does not disturb another writer', async () => {
    // §2.3: a fork is confined to one chain, and the rest of the space syncs.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await generateKeyPair();

    const owner = new Writer(key.publicKey, key);
    const declare = await owner.write(
      ROOT, ':writers', UTF8.encode(`${hex(key.publicKey)},${hex(other.publicKey)}`), 0,
    );

    const bystander = new Writer(key.publicKey, other);
    bystander.observe([declare]);
    const safe = await bystander.write(uuid('safe'), ':name', UTF8.encode('untouched'), 5);

    const { left, right } = await forkedPair(key, key, 'left', 'right');
    const state = fold([declare, left, right, safe], { space: key.publicKey });

    expect(state.objects.get(hex(uuid('safe')))?.attrs.get(':name')?.value).toBe('untouched');
  });

  it('resolves the same under every arrival order', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const shared = point('shared');
    const mk = (): Writer =>
      new Writer(key.publicKey, key, { point: shared, seq: 0, prev: null, lamport: 0, heads: [] });
    const one = mk();
    const two = mk();
    const events: Event[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(await one.write(uuid(`a${i}`), ':name', UTF8.encode(`a${i}`), i * 2));
      events.push(await two.write(uuid(`b${i}`), ':name', UTF8.encode(`b${i}`), i * 2 + 1));
    }

    const reference = [...fold(events, { space: key.publicKey }).objects.keys()].sort().join(',');
    fc.assert(
      fc.property(permutation(events.length), (order) => {
        const shuffled = reorder(events, order);
        const got = [...fold(shuffled, { space: key.publicKey }).objects.keys()].sort().join(',');
        expect(got).toBe(reference);
      }),
      { numRuns: 60 },
    );
  });

  it('the incremental fold agrees with a replay', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const { left, right } = await forkedPair(key, key, 'left', 'right');
    const events = [left, right];

    const folder = new Folder(key.publicKey);
    for (const e of events) folder.apply([e]);

    const replayed = fold(events, { space: key.publicKey });
    expect(folder.state.objects.get(hex(uuid('doc')))?.attrs.get(':name')?.value).toBe(
      nameOf(replayed),
    );
  });
});
