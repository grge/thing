/**
 * Two peers, one wire, converging.
 *
 * The stage-5 property: peers starting from arbitrary states end up holding the
 * same events, over a channel that is a pair of functions rather than a
 * network. Everything the protocol has to get right — gaps, batching, blob
 * transfer, fork detection — is reachable here.
 */
import {
  type Event,
  hex,
  type KeyPair,
  keyPairFromSeed,
  ROOT,
  SEED_LEN,
  Writer as EventWriter,
} from '../core/index.js';
import { MemoryStore, type SpaceStore } from '../store/index.js';
import { describe, expect, it } from 'vitest';
import type { Channel } from './blobs.js';
import { haveMessage, presenceMessage } from './ephemeral.js';
import { Session } from './session.js';
import type { Divergence } from './sync.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

/**
 * Two sessions wired to each other.
 *
 * Frames are queued rather than delivered synchronously, so `settle` drives the
 * exchange to quiescence — which is what a real connection does, and which
 * makes a protocol that needs several round trips work here.
 */
class Wire {
  private queueA: Uint8Array[] = [];
  private queueB: Uint8Array[] = [];
  a!: Session;
  b!: Session;

  channelFor(side: 'a' | 'b'): Channel {
    const queue = side === 'a' ? this.queueB : this.queueA;
    return {
      send: (frame) => queue.push(frame),
      get bufferedAmount() {
        return 0;
      },
    };
  }

  /** Deliver until nothing is left to deliver. */
  async settle(limit = 100): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const toA = this.queueA.splice(0);
      const toB = this.queueB.splice(0);
      if (toA.length === 0 && toB.length === 0) return;
      for (const f of toA) await this.a.receive(f);
      for (const f of toB) await this.b.receive(f);
    }
    throw new Error('exchange did not settle');
  }
}

interface Peer {
  readonly store: SpaceStore;
  readonly writer: EventWriter;
  readonly events: Event[];
  forks: Divergence[];
}

async function makePeer(space: KeyPair, writerKey: KeyPair): Promise<Peer> {
  const store = await new MemoryStore().open(hex(space.publicKey), space.publicKey);
  return {
    store,
    writer: new EventWriter(space.publicKey, writerKey),
    events: [],
    forks: [],
  };
}

/** Write an event into a peer's own store. */
async function write(peer: Peer, attr: string, value: string, wall: number): Promise<Event> {
  const e = await peer.writer.write(ROOT, attr, UTF8.encode(value), wall);
  await peer.store.append([e]);
  peer.events.push(e);
  return e;
}

async function connect(a: Peer, b: Peer): Promise<Wire> {
  const wire = new Wire();
  wire.a = new Session(a.store, wire.channelFor('a'), {
    peer: 'b',
    onFork: (f) => a.forks.push(f),
  });
  wire.b = new Session(b.store, wire.channelFor('b'), {
    peer: 'a',
    onFork: (f) => b.forks.push(f),
  });
  return wire;
}

async function countOf(store: SpaceStore): Promise<number> {
  return store.count();
}

describe('two peers', () => {
  it('converge when one is ahead', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    for (let i = 0; i < 5; i++) await write(a, ':name', `v${i}`, i);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    expect(await countOf(b.store)).toBe(5);
    expect(await countOf(a.store)).toBe(5);
  });

  it('converge when both have written', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await keyPairFromSeed(labelled('other', SEED_LEN));

    // Two different writers, both admitted because no writer set is declared.
    const a = await makePeer(space, space);
    const b = await makePeer(space, other);

    for (let i = 0; i < 3; i++) await write(a, ':name', `a${i}`, i);
    for (let i = 0; i < 4; i++) await write(b, ':name', `b${i}`, i);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    expect(await countOf(a.store)).toBe(7);
    expect(await countOf(b.store)).toBe(7);

    const vvA = await a.store.versionVector();
    const vvB = await b.store.versionVector();
    expect([...vvA.keys()].sort()).toEqual([...vvB.keys()].sort());
  });

  it('converge from arbitrary starting states', async () => {
    // Neither peer knows what the other has; the exchange has to work out.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await keyPairFromSeed(labelled('other', SEED_LEN));

    for (const [na, nb] of [
      [0, 0],
      [0, 5],
      [5, 0],
      [3, 3],
      [1, 9],
    ] as const) {
      const a = await makePeer(space, space);
      const b = await makePeer(space, other);
      for (let i = 0; i < na; i++) await write(a, ':name', `a${i}`, i);
      for (let i = 0; i < nb; i++) await write(b, ':name', `b${i}`, i);

      const wire = await connect(a, b);
      await wire.a.start();
      await wire.settle();

      expect(await countOf(a.store)).toBe(na + nb);
      expect(await countOf(b.store)).toBe(na + nb);
    }
  });

  it('either side may open the conversation', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    for (let i = 0; i < 3; i++) await write(a, ':name', `v${i}`, i);

    const wire = await connect(a, b);
    await wire.b.start(); // the empty side greets first
    await wire.settle();

    expect(await countOf(b.store)).toBe(3);
  });

  it('a second exchange moves nothing', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    for (let i = 0; i < 4; i++) await write(a, ':name', `v${i}`, i);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    await wire.a.start();
    await wire.settle();
    expect(await countOf(b.store)).toBe(4);
  });

  it('fills a gap when events arrive out of order', async () => {
    // §2.5: an event beyond a gap is held, not dropped, and the gap is asked
    // for. Delivering the tail first is exactly that case.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    for (let i = 0; i < 6; i++) await write(a, ':name', `v${i}`, i);

    const wire = await connect(a, b);
    // Hand b the last three events directly, out of order and beyond a gap.
    await wire.b.receive(
      encodeEventsFrame(a.events.slice(3)),
    );
    expect(await countOf(b.store)).toBe(0); // all held, none applicable

    await wire.a.start();
    await wire.settle();
    expect(await countOf(b.store)).toBe(6);
  });
});

describe('forks', () => {
  it('are detected and reported on both sides', async () => {
    // Two peers at the same frontier on different histories — the case the tip
    // hash exists for (§2.3). Without it they would look identical.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    // Same key, two "devices": each writes its own seq 0 (§7.3).
    await write(a, ':name', 'from-a', 1);
    await write(b, ':name', 'from-b', 2);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    expect(a.forks).toHaveLength(1);
    expect(a.forks[0]!.frontier).toBe(0);
    expect(a.forks[0]!.mine).not.toBe(a.forks[0]!.theirs);
    expect(b.forks.length).toBeGreaterThan(0);
  });

  it('do not stop other writers from syncing', async () => {
    // A fork is confined to one chain (§2.3). Everything else must converge.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await keyPairFromSeed(labelled('other', SEED_LEN));

    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    await write(a, ':name', 'a-fork', 1);
    await write(b, ':name', 'b-fork', 2);

    // A third writer's events exist only on a, and must reach b regardless.
    const third = new EventWriter(space.publicKey, other);
    const extra: Event[] = [];
    for (let i = 0; i < 3; i++) {
      extra.push(await third.write(ROOT, ':name', UTF8.encode(`c${i}`), i));
    }
    await a.store.append(extra);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    expect(a.forks.length).toBeGreaterThan(0);
    const vvB = await b.store.versionVector();
    expect(vvB.get(hex(other.publicKey))?.frontier).toBe(2);
  });
});

describe('the connection', () => {
  it('closes on a protocol mismatch', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const wire = await connect(a, a);

    const wrong = new Uint8Array([
      0x01,
      ...UTF8.encode(JSON.stringify({ type: 'HELLO', space: a.store.space, protocol: 999, vv: {} })),
    ]);
    await wire.a.receive(wrong);
    expect(wire.a.isClosed).toBe(true);
  });

  it('closes on the wrong space', async () => {
    // An event's signature covers the space key (§2.1), so a connection about
    // a different space could never produce anything usable.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const wire = await connect(a, a);

    const elsewhere = new Uint8Array([
      0x01,
      ...UTF8.encode(JSON.stringify({ type: 'HELLO', space: 'somewhere-else', protocol: 1, vv: {} })),
    ]);
    await wire.a.receive(elsewhere);
    expect(wire.a.isClosed).toBe(true);
  });

  it('survives a malformed frame', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const wire = await connect(a, a);

    expect(await wire.a.receive(Uint8Array.of(0xff, 0x00))).toBe(false);
    expect(wire.a.isClosed).toBe(false);
  });

  it('rejects events that do not verify', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    const good = await write(a, ':name', 'real', 1);

    const wire = await connect(a, b);
    const forged: Event = { ...good, value: UTF8.encode('forged') };
    await wire.b.receive(encodeEventsFrame([forged]));

    // Nothing entered the store: §2.3 says a peer cannot be trusted to have
    // checked, so the store checks.
    expect(await countOf(b.store)).toBe(0);
  });
});

describe('blobs and presence', () => {
  it('transfers a blob between peers', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const bytes = new Uint8Array(40_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const hash = await a.store.putBlob(bytes);

    const wire = await connect(a, b);
    wire.b.requestBlob(hash);
    await wire.settle();

    const got = await b.store.getBlob(hash);
    expect(got).not.toBeNull();
    expect(hex(got!)).toBe(hex(bytes));
  });

  it('says so when it does not hold a blob', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const wire = await connect(a, b);
    wire.b.requestBlob(labelled('absent', 32));
    await wire.settle();

    // Nothing arrived, and nothing is stuck waiting: NO_BLOB is what stops a
    // caller waiting forever for something that was never there.
    expect(await b.store.getBlob(labelled('absent', 32))).toBeNull();
  });

  it('announces what it holds, without that reaching storage', async () => {
    // §10: ephemeral messages are never stored. This is the structural
    // property that makes the channel safe to leave unsigned.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    await a.store.putBlob(UTF8.encode('some content'));

    const wire = await connect(a, b);
    await wire.a.announceBlobs();
    wire.a.sendEphemeral(presenceMessage({ cursor: 3 }, 10_000));
    await wire.settle();

    // b learned about the blob and the presence...
    expect(wire.b.ephemeral.present().size).toBe(1);
    // ...and neither reached its log.
    expect(await countOf(b.store)).toBe(0);
  });

  it('records availability from a HAVE', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const wire = await connect(a, a);

    await wire.a.receive(
      new Uint8Array([0x03, ...UTF8.encode(JSON.stringify(haveMessage(['aabb'])))]),
    );
    expect(wire.a.ephemeral.whoHas('aabb')).toEqual(['b']);
  });
});

/** An EVENTS frame, for handing events to a session directly. */
function encodeEventsFrame(events: readonly Event[]): Uint8Array {
  const wire = events.map((e) => ({
    w: hex(e.writer),
    s: e.seq,
    p: e.prev === null ? null : hex(e.prev),
    l: e.lamport,
    t: hex(e.target),
    a: e.attr,
    v: hex(e.value),
    wall: e.wall,
    sig: hex(e.sig),
  }));
  return new Uint8Array([
    0x01,
    ...UTF8.encode(JSON.stringify({ type: 'EVENTS', events: wire })),
  ]);
}
