/**
 * A sequence inside a real space — §3.8's bet, end to end.
 *
 * `sequence.test.ts` tests the rule against its contract. This tests the claim
 * the contract exists to support: that a rule this complicated needs **no
 * special case anywhere in the kernel**. The fold dispatches it by `:kind` like
 * any other body rule, two writers converge, and reopening replays it.
 *
 * If §3.8's vocabulary were going to fail, it would fail here — with the fold
 * needing to know what a sequence is.
 */
import { describe, expect, it } from 'vitest';

import { hex } from './core/bytes.js';
import { elementIdOf, sequence, type SeqOp } from './core/sequence.js';
import { generateKeyPair, type KeyPair, keyPairFromSeed, SEED_LEN } from './core/sign.js';
import { eventId } from './core/event.js';
import { BODY_ATTR } from './core/fold.js';
import { labelled } from './core/testkit.js';
import { MemoryStore, type Store } from './store/index.js';
import { Space } from './space.js';
import type { Event } from './core/index.js';

const UTF8 = new TextEncoder();
const uuid = (s: string): Uint8Array => labelled(s, 16);

async function open(store: Store, key: KeyPair, writer: KeyPair = key): Promise<Space> {
  let tick = 0;
  const s = await store.open(hex(key.publicKey), key.publicKey);
  return Space.open(s, { key: key.publicKey, writer, now: () => (tick += 1) });
}

/** Write one operation into a space's `:body` slice. */
async function op(space: Space, target: Uint8Array, value: SeqOp): Promise<Event> {
  return space.write(target, BODY_ATTR, sequence.codec.encode(value));
}

function reading(space: Space, target: Uint8Array): string {
  // `body` is a SliceState; `value` is what the rule's `render` produced.
  const value = space.state.objects.get(hex(target))?.body?.value;
  if (!Array.isArray(value)) return '';
  return (value as Uint8Array[]).map((b) => new TextDecoder().decode(b)).join('');
}

describe('a sequence in a space', () => {
  it('folds through the kernel with no special case', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await open(new MemoryStore(), key);
    const doc = uuid('doc');

    // `:kind` names the rule, exactly as it names `blob` or `register`.
    await space.write(doc, ':kind', UTF8.encode('sequence'));

    const h = await op(space, doc, { op: 'ins', after: null, body: UTF8.encode('h') });
    const i = await op(space, doc, {
      op: 'ins',
      after: elementIdOf({ lamport: h.lamport, writer: h.writer, id: idOf(key, h) }),
      body: UTF8.encode('i'),
    });
    expect(i).toBeTruthy();

    expect(reading(space, doc)).toBe('hi');
  });

  it('survives a reopen, replaying from the log', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const store = new MemoryStore();
    const doc = uuid('doc');

    const first = await open(store, key);
    await first.write(doc, ':kind', UTF8.encode('sequence'));
    const a = await op(first, doc, { op: 'ins', after: null, body: UTF8.encode('a') });
    await op(first, doc, {
      op: 'ins',
      after: elementIdOf({ lamport: a.lamport, writer: a.writer, id: idOf(key, a) }),
      body: UTF8.encode('b'),
    });
    const before = reading(first, doc);
    await first.close();

    const again = await open(store, key);
    expect(reading(again, doc)).toBe(before);
    expect(before).toBe('ab');
  });

  it('two writers converge on one document', async () => {
    // The bet's actual claim: concurrent editing, no coordination, same result.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const alice = await generateKeyPair();
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    const doc = uuid('doc');

    const owner = await open(storeA, key);
    await owner.addWriter(alice.publicKey);
    await owner.write(doc, ':kind', UTF8.encode('sequence'));
    const anchor = await op(owner, doc, { op: 'ins', after: null, body: UTF8.encode('>') });

    // Alice starts from the owner's log, then both write concurrently.
    const seed: Event[] = [];
    for await (const e of (await storeA.open(hex(key.publicKey), key.publicKey)).readAll()) {
      seed.push(e);
    }
    const asAlice = await open(storeB, key, alice);
    await asAlice.receive(seed);

    const anchorId = elementIdOf({
      lamport: anchor.lamport,
      writer: anchor.writer,
      id: idOf(key, anchor),
    });
    await op(owner, doc, { op: 'ins', after: anchorId, body: UTF8.encode('owner') });
    await op(asAlice, doc, { op: 'ins', after: anchorId, body: UTF8.encode('alice') });

    // Exchange, as syncing would.
    const drain = async (s: MemoryStore): Promise<Event[]> => {
      const out: Event[] = [];
      for await (const e of (await s.open(hex(key.publicKey), key.publicKey)).readAll()) out.push(e);
      return out;
    };
    await asAlice.receive(await drain(storeA));
    await owner.receive(await drain(storeB));

    const one = reading(owner, doc);
    const two = reading(asAlice, doc);

    expect(one).toBe(two); // converged
    expect(one).toContain('owner'); // neither write lost
    expect(one).toContain('alice');
    expect(one.startsWith('>')).toBe(true);
  });

  it('a client that does not know the rule still folds the structure', async () => {
    // §3.1's tiering: an unknown body rule costs one object's body, never the
    // space's shape. `:kind` names a rule this client has never heard of.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await open(new MemoryStore(), key);
    const doc = uuid('doc');

    await space.write(doc, ':kind', UTF8.encode('sequence:future-version'));
    await space.write(doc, ':name', UTF8.encode('notes'));
    await op(space, doc, { op: 'ins', after: null, body: UTF8.encode('x') });

    const object = space.state.objects.get(hex(doc));
    expect(object?.attrs.get(':name')?.value).toBe('notes');
    expect(object?.body?.value).toBeUndefined();
  });
});

/** An event's id, which is what names the element it created. */
function idOf(key: KeyPair, e: Event): Uint8Array {
  return eventId(key.publicKey, e);
}
