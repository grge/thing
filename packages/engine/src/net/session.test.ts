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
import { point } from '../core/testkit.js';
import { MemoryStore, type SpaceStore } from '../store/index.js';
import { describe, expect, it } from 'vitest';
import { haveMessage, presenceMessage } from './ephemeral.js';
import { Session } from './session.js';
import { ChannelPair, channelPair } from './testwire.js';
import { vvToWire } from './wire.js';
import type { Divergence } from './sync.js';
import type { Resolved } from './protocol.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

/** One side of an exchange: a store, a writer, and what it has seen. */
interface Peer {
  readonly store: SpaceStore;
  readonly writer: EventWriter;
  readonly events: Event[];
  forks: Divergence[];
}

/**
 * A peer with its own store and writer.
 *
 * `point` is normally left alone, so each peer mints its own append point and
 * two peers sharing a key simply write separate chains. Passing one explicitly
 * puts two peers on the *same* chain, which is how a genuine fork is staged —
 * honest software no longer produces one.
 */

async function makePeer(space: KeyPair, writerKey: KeyPair, point?: Uint8Array): Promise<Peer> {
  const store = await new MemoryStore().open(hex(space.publicKey), space.publicKey);
  return {
    store,
    writer: new EventWriter(
      space.publicKey,
      writerKey,
      ...(point === undefined ? [] : [{ point, seq: 0, prev: null, lamport: 0, heads: [] }] as const),
    ),
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

async function connect(a: Peer, b: Peer): Promise<ChannelPair> {
  const wire = channelPair();
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
    // **Forced onto one chain.** Two processes sharing a key no longer collide
    // on their own — each mints its own append point (§2.1) — so a fork now
    // has to be staged. It means equivocation or a rolled-back store rather
    // than someone opening a second tab, which is the point of the change.
    const shared = point('shared');
    const a = await makePeer(space, space, shared);
    const b = await makePeer(space, space, shared);

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

    // Staged onto one chain, as above — honest peers no longer collide.
    const shared = point('shared');
    const a = await makePeer(space, space, shared);
    const b = await makePeer(space, space, shared);

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
    expect(vvB.get(third.chain)?.frontier).toBe(2);
  });
});

describe('asking whether a peer is caught up (§2.3.1)', () => {
  it('answers covered once the peer has everything', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    for (let i = 0; i < 3; i++) await write(a, ':name', `v${i}`, i);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    const mine = vvToWire(await a.store.versionVector());
    const answer = wire.a.askSynced(mine);
    await wire.settle();
    expect((await answer).kind).toBe('covered');
  });

  it('answers behind while the peer is still missing events', async () => {
    // Asked *before* anything is exchanged, so the peer genuinely has nothing.
    // This is the case the whole question exists for: the write is in my store
    // and has reached no one.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    await write(a, ':name', 'unshared', 0);

    const wire = await connect(a, b);
    const mine = vvToWire(await a.store.versionVector());
    // No `start()`: no HELLO, so no reconciliation has happened.
    const answer = wire.a.askSynced(mine);
    await wire.settle();

    const got = await answer;
    expect(got.kind).toBe('behind');
    if (got.kind !== 'behind') throw new Error('unreachable');
    expect(got.chains).toHaveLength(1);
  });

  it('goes from behind to covered as the events land', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    await write(a, ':name', 'eventually', 0);

    const wire = await connect(a, b);
    const mine = vvToWire(await a.store.versionVector());

    const before = wire.a.askSynced(mine);
    await wire.settle();
    expect((await before).kind).toBe('behind');

    await wire.a.start();
    await wire.settle();

    const after = wire.a.askSynced(mine);
    await wire.settle();
    expect((await after).kind).toBe('covered');
  });

  it('reports a fork rather than waiting on one', async () => {
    // Staged by putting both peers on one append point, since honest software
    // no longer produces a fork. Waiting would never resolve it.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const shared = point('shared');
    const a = await makePeer(space, space, shared);
    const b = await makePeer(space, space, shared);

    await write(a, ':name', 'mine', 0);
    await write(b, ':name', 'theirs', 0);

    const wire = await connect(a, b);
    const mine = vvToWire(await a.store.versionVector());
    const answer = wire.a.askSynced(mine);
    await wire.settle();
    expect((await answer).kind).toBe('forked');
  });

  it('answers an outstanding question when the connection closes', async () => {
    // Otherwise a caller waits forever on a peer that has gone — which is the
    // failure this question exists to prevent, arrived at from the other side.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);
    await write(a, ':name', 'x', 0);

    const wire = await connect(a, b);
    const answer = wire.a.askSynced(vvToWire(await a.store.versionVector()));
    wire.a.close();
    expect((await answer).kind).toBe('behind');
  });

  it('can be asked more than once on one connection', async () => {
    // The reason this is not `HELLO`: that carries a vector once, at open, and
    // a writer asking about a moment after the handshake needs to ask again.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const wire = await connect(a, b);
    await wire.a.start();
    await wire.settle();

    const first = wire.a.askSynced(vvToWire(await a.store.versionVector()));
    await wire.settle();
    expect((await first).kind).toBe('covered');

    // A write *after* the handshake — exactly what HELLO could never cover.
    await write(a, ':name', 'later', 1);
    const mine = vvToWire(await a.store.versionVector());

    const second = wire.a.askSynced(mine);
    await wire.settle();
    expect((await second).kind).toBe('behind');

    wire.a.push([a.events[a.events.length - 1]!]);
    await wire.settle();

    const third = wire.a.askSynced(mine);
    await wire.settle();
    expect((await third).kind).toBe('covered');
  });
});

describe('a blob a peer does not have (§2.4)', () => {
  it('reports the refusal rather than swallowing it', async () => {
    // `NO_BLOB` existed and stopped at cancelling the transfer, so a refusal
    // was indistinguishable from slowness and a caller waited forever on bytes
    // that were never coming. That is the failure the message was added to
    // prevent, half-wired.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const refused: string[] = [];
    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), {
      peer: 'b',
      onNoBlob: (hash) => refused.push(hash),
    });
    wire.b = new Session(b.store, wire.channelFor('b'), { peer: 'a' });

    const missing = new Uint8Array(32).fill(7);
    wire.a.requestBlob(missing);
    await wire.settle();

    expect(refused).toEqual([hex(missing)]);
  });

  it('announces a blob it has just acquired', async () => {
    // The other half of the race: a relay that fetches bytes after refusing
    // them has to say so, or the peer it refused has no reason to ask again.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const announced: string[][] = [];
    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), { peer: 'b' });
    wire.b = new Session(b.store, wire.channelFor('b'), {
      peer: 'a',
      onHave: (hashes) => announced.push([...hashes]),
    });

    const bytes = UTF8.encode('freshly acquired');
    const hash = await a.store.putBlob(bytes);
    wire.a.announceBlob(hex(hash));
    await wire.settle();

    expect(announced).toEqual([[hex(hash)]]);
  });

  it('serves a blob it does have', async () => {
    // The control: the same request against a peer that holds the bytes must
    // transfer them, so the refusal test above is about absence and not about
    // the request being broken.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const bytes = UTF8.encode('the actual content');
    const hash = await b.store.putBlob(bytes);

    let got: Uint8Array | null = null;
    const refused: string[] = [];
    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), {
      peer: 'b',
      onBlob: (_h, received) => (got = received),
      onNoBlob: (h) => refused.push(h),
    });
    wire.b = new Session(b.store, wire.channelFor('b'), { peer: 'a' });

    wire.a.requestBlob(hash);
    await wire.settle();

    expect(refused).toEqual([]);
    expect(got).not.toBeNull();
    expect(hex(got!)).toBe(hex(bytes));
  });
});

describe('resolution (§5.3)', () => {
  it('answers a query from what the caller knows', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const answers: Resolved[] = [];
    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), {
      peer: 'b',
      onResolved: (m) => answers.push(m),
    });
    wire.b = new Session(b.store, wire.channelFor('b'), {
      peer: 'a',
      onResolve: () => ({
        known: true,
        at: [{ kind: 'ws', url: 'ws://found:9944' }],
      }),
    });

    wire.a.resolve(1, 'ff'.repeat(32));
    await wire.settle();

    expect(answers).toHaveLength(1);
    expect(answers[0]!.known).toBe(true);
    expect(answers[0]!.at).toEqual(['ws://found:9944']);
  });

  it('distinguishes "never heard of it" from "nobody is serving"', async () => {
    // §5.3 wants three answers, not two: they call for different behaviour —
    // stop asking this peer, versus ask again later and tell the person
    // something true.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const answers: Resolved[] = [];
    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), {
      peer: 'b',
      onResolved: (m) => answers.push(m),
    });
    wire.b = new Session(b.store, wire.channelFor('b'), {
      peer: 'a',
      onResolve: (s) =>
        s.startsWith('aa')
          ? { known: true, at: [], lastSeen: 1234 }
          : { known: false, at: [] },
    });

    wire.a.resolve(1, 'aa'.repeat(32));
    wire.a.resolve(2, 'bb'.repeat(32));
    await wire.settle();

    const tracked = answers.find((m) => m.id === 1)!;
    expect(tracked.known).toBe(true);
    expect(tracked.at).toEqual([]);
    expect(tracked.lastSeen).toBe(1234);

    const unknown = answers.find((m) => m.id === 2)!;
    expect(unknown.known).toBe(false);
  });

  it('answers unknown when the caller offers no opinion', async () => {
    // A session with no `onResolve` must still reply: silence is
    // indistinguishable from a lost message, and a caller would wait forever.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const answers: Resolved[] = [];
    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), {
      peer: 'b',
      onResolved: (m) => answers.push(m),
    });
    wire.b = new Session(b.store, wire.channelFor('b'), { peer: 'a' });

    wire.a.resolve(7, 'cc'.repeat(32));
    await wire.settle();

    expect(answers[0]).toMatchObject({ id: 7, known: false, at: [] });
  });

  it('records what a peer announced, and who serves what', async () => {
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), { peer: 'b' });
    wire.b = new Session(b.store, wire.channelFor('b'), { peer: 'a' });

    wire.a.announce(['aa'.repeat(32)], [{ kind: 'ws', url: 'ws://me:1' }]);
    await wire.settle();

    expect(wire.b.serversOf('aa'.repeat(32))).toEqual([
      { peer: 'a', at: ['ws://me:1'] },
    ]);
  });

  it('an announcement with no address means "on this connection"', async () => {
    // The browser case: a peer with no address of its own still serves, and
    // the receiver already has the connection to reach it on.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const b = await makePeer(space, space);

    const wire = channelPair();
    wire.a = new Session(a.store, wire.channelFor('a'), { peer: 'b' });
    wire.b = new Session(b.store, wire.channelFor('b'), { peer: 'a' });

    wire.a.announce(['aa'.repeat(32)]);
    await wire.settle();

    expect(wire.b.serversOf('aa'.repeat(32))).toEqual([{ peer: 'a', at: [] }]);
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

  it('drops a frame for another space without closing', async () => {
    // **This used to close**, which was right when a connection was about one
    // space. It is wrong now: one connection carries several
    // (`design/CONNECTIONS.md`), so a frame naming a different space belongs to
    // a sibling session on the same transport — or to a space this peer does
    // not hold. Closing would take down every space sharing the connection.
    const space = await keyPairFromSeed(labelled('space', SEED_LEN));
    const a = await makePeer(space, space);
    const wire = await connect(a, a);

    const elsewhere = new Uint8Array([
      0x01,
      ...UTF8.encode(JSON.stringify({ type: 'HELLO', space: 'somewhere-else', protocol: 1, vv: {} })),
    ]);
    expect(await wire.a.receive(elsewhere)).toBe(true);
    expect(wire.a.isClosed).toBe(false);
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
