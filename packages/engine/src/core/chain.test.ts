/**
 * Per-writer chains and the comparison key (ARCHITECTURE.md §2.2, §7.3).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkChain, checkLink, compareKeys, greater, type Key, keyOf, maxKey } from './chain.js';
import { hex } from './bytes.js';
import { type Event, type EventBody, eventId, ROOT } from './event.js';
import { HASH_LEN } from './hash.js';
import { generateKeyPair, type KeyPair, keyPairFromSeed, PUBLIC_KEY_LEN, SEED_LEN, SIGNATURE_LEN } from './sign.js';
import { labelled, point } from './testkit.js';
import { resumeFrom, Writer } from './writer.js';

const SPACE = labelled('space', PUBLIC_KEY_LEN);
const UNSIGNED = new Uint8Array(SIGNATURE_LEN);

function body(over: Partial<EventBody> = {}): EventBody {
  return {
    writer: labelled('alice', PUBLIC_KEY_LEN),
    point: point(),
    seq: 0,
    prev: null,
    deps: [],
    lamport: 1,
    target: ROOT,
    attr: ':name',
    value: new Uint8Array(0),
    wall: 0,
    ...over,
  };
}

/** An event with a placeholder signature: chain checks never look at it. */
function unsigned(over: Partial<EventBody> = {}): Event {
  return { ...body(over), sig: UNSIGNED };
}

describe('the comparison key', () => {
  it('orders by lamport first', () => {
    const a = keyOf(SPACE, body({ lamport: 1 }));
    const b = keyOf(SPACE, body({ lamport: 2 }));
    expect(compareKeys(a, b)).toBeLessThan(0);
  });

  it('breaks lamport ties on writer', () => {
    const a = keyOf(SPACE, body({ writer: labelled('aaa', PUBLIC_KEY_LEN) }));
    const b = keyOf(SPACE, body({ writer: labelled('bbb', PUBLIC_KEY_LEN) }));
    expect(compareKeys(a, b)).toBeLessThan(0);
  });

  it('breaks writer ties on event id — the forked-chain case', () => {
    // §7.3: one key on two devices produces two events at the same seq and the
    // same lamport, both validly signed. With only (lamport, writer) these
    // compare equal and the winner falls back to arrival order, so two peers
    // holding the same events disagree. The event id is what prevents that.
    const left = body({ seq: 3, lamport: 5, attr: ':name', value: Uint8Array.of(1) });
    const right = body({ seq: 3, lamport: 5, attr: ':name', value: Uint8Array.of(2) });

    const a = keyOf(SPACE, left);
    const b = keyOf(SPACE, right);

    expect(compareKeys(a, b)).not.toBe(0);
    // And the order is the same whichever way round they are compared.
    expect(Math.sign(compareKeys(a, b))).toBe(-Math.sign(compareKeys(b, a)));
  });

  it('is a total order: only an event equals itself', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.uint8Array({ minLength: 1, maxLength: 4 }),
        fc.uint8Array({ minLength: 1, maxLength: 4 }),
        (la, lb, va, vb) => {
          const a = keyOf(SPACE, body({ lamport: la, value: va }));
          const b = keyOf(SPACE, body({ lamport: lb, value: vb }));
          const same = la === lb && hex(va) === hex(vb);
          expect(compareKeys(a, b) === 0).toBe(same);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('maxKey and greater treat null as bottom', () => {
    const k: Key = keyOf(SPACE, body());
    expect(greater(k, null)).toBe(true);
    expect(greater(null, k)).toBe(false);
    expect(greater(null, null)).toBe(false);
    expect(maxKey(null, k)).toBe(k);
    expect(maxKey(k, null)).toBe(k);
    expect(maxKey(null, null)).toBeNull();
  });
});

describe('chain links', () => {
  it('accepts a well-formed first event', () => {
    expect(checkLink(SPACE, null, body({ seq: 0, prev: null }))).toBeNull();
  });

  it('rejects a first event that carries a prev', () => {
    const fault = checkLink(SPACE, null, body({ seq: 0, prev: labelled('p', HASH_LEN) }));
    expect(fault?.kind).toBe('seq-zero-has-prev');
  });

  it('rejects a non-zero seq with no predecessor', () => {
    const fault = checkLink(SPACE, null, body({ seq: 5 }));
    expect(fault?.kind).toBe('seq-not-contiguous');
  });

  it('accepts a correct link', () => {
    const first = unsigned({ seq: 0, lamport: 1 });
    const second = body({ seq: 1, prev: eventId(SPACE, first), lamport: 2 });
    expect(checkLink(SPACE, first, second)).toBeNull();
  });

  it('rejects a fabricated prev', () => {
    // The graft §2.1 protects against: a prev that does not name the event it
    // claims to follow.
    const first = unsigned({ seq: 0, lamport: 1 });
    const second = body({ seq: 1, prev: labelled('fake', HASH_LEN), lamport: 2 });
    expect(checkLink(SPACE, first, second)?.kind).toBe('prev-mismatch');
  });

  it('rejects a gap in seq', () => {
    const first = unsigned({ seq: 0, lamport: 1 });
    const third = body({ seq: 2, prev: eventId(SPACE, first), lamport: 2 });
    expect(checkLink(SPACE, first, third)?.kind).toBe('seq-not-contiguous');
  });

  it('rejects a lamport that does not increase', () => {
    // §2.2: the comparison key is a total order only because a writer's own
    // lamports strictly increase. Nothing else enforces it.
    const first = unsigned({ seq: 0, lamport: 5 });
    const second = body({ seq: 1, prev: eventId(SPACE, first), lamport: 5 });
    expect(checkLink(SPACE, first, second)?.kind).toBe('lamport-not-increasing');
  });

  it('rejects a prev that is right for a different space', () => {
    // eventId includes the space key, so a chain does not carry across.
    const first = unsigned({ seq: 0, lamport: 1 });
    const elsewhere = labelled('other', PUBLIC_KEY_LEN);
    const second = body({ seq: 1, prev: eventId(elsewhere, first), lamport: 2 });
    expect(checkLink(SPACE, first, second)?.kind).toBe('prev-mismatch');
  });
});

describe('whole chains', () => {
  async function chain(n: number): Promise<{ key: KeyPair; events: Event[] }> {
    const key = await keyPairFromSeed(labelled('writer', SEED_LEN));
    const w = new Writer(SPACE, key);
    const events: Event[] = [];
    for (let i = 0; i < n; i++) events.push(await w.write(ROOT, ':name', Uint8Array.of(i), i));
    return { key, events };
  }

  it('accepts a chain a Writer produced', async () => {
    const { events } = await chain(5);
    expect(checkChain(SPACE, events)).toBeNull();
  });

  it('reports where a chain breaks', async () => {
    const { events } = await chain(5);
    const broken = [...events];
    broken[3] = { ...broken[3]!, prev: labelled('fake', HASH_LEN) };
    const fault = checkChain(SPACE, broken);
    expect(fault?.at).toBe(3);
    expect(fault?.fault.kind).toBe('prev-mismatch');
  });

  it('a resuming Writer starts a new chain rather than extending one', async () => {
    // The old behaviour was to continue the last chain, which is only safe if
    // whoever wrote it has stopped — and being wrong about that produces two
    // events at one seq, both validly signed (§2.1's `Point`). A fresh chain
    // costs one version-vector entry and cannot be wrong.
    const { key, events } = await chain(3);
    const resumed = new Writer(SPACE, key, resumeFrom(SPACE, events));
    const next = await resumed.write(ROOT, ':name', Uint8Array.of(99), 99);

    expect(hex(next.point)).not.toBe(hex(events[0]!.point));
    expect(next.seq).toBe(0);
    expect(next.prev).toBeNull();

    // Both chains are individually sound; they are simply separate.
    expect(checkChain(SPACE, events)).toBeNull();
    expect(checkChain(SPACE, [next])).toBeNull();
  });

  it('a resuming Writer carries the clock forward', async () => {
    // §2.2: a later write must not lose to an earlier one this identity has
    // already made, so the Lamport clock crosses chains even though seq does
    // not.
    const { key, events } = await chain(3);
    const resumed = new Writer(SPACE, key, resumeFrom(SPACE, events));
    const next = await resumed.write(ROOT, ':name', Uint8Array.of(99), 99);
    const highest = Math.max(...events.map((e) => e.lamport));
    expect(next.lamport).toBeGreaterThan(highest);
  });

  it('a Writer raises its clock on observing others', async () => {
    const key = await generateKeyPair();
    const w = new Writer(SPACE, key);
    w.observe([body({ lamport: 41 })]);
    const e = await w.write(ROOT, ':name', new Uint8Array(0), 0);
    expect(e.lamport).toBe(42);
  });
});
