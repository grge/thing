/**
 * Being a peer, with the platform faked.
 *
 * `Peer` and the browser client are both tested through their own transports,
 * which is right but means the shared behaviour was only ever exercised
 * incidentally. These pin the parts that used to exist twice — attaching,
 * pushing on write, adopting, the lock — over an in-memory store and a pair of
 * connections wired to each other, so nothing here needs a socket or a disk.
 */
import { describe, expect, it } from 'vitest';

import { generateKeyPair, hex } from '../core/index.js';
import { MemoryStore } from '../store/index.js';
import { Client } from './client.js';
import { type Connection, NO_LOCK, type WriteLock } from './types.js';

/**
 * Two connections that deliver to each other, a turn later, **one at a time**.
 *
 * Deferred rather than synchronous, because a real transport never delivers
 * inside `send` — and a `Session` that saw its own frames arrive re-entrantly
 * would be tested against conditions it never meets.
 *
 * Serialised because a socket is. `Session.receive` is asynchronous and reads
 * the store before appending, so overlapping two deliveries lets both see the
 * same event as new and report it twice. That is an artifact of a fake
 * transport handing over frames concurrently, and a test built on it would
 * measure the harness rather than the client.
 */
interface Wire extends Connection {
  deliver(data: Uint8Array): Promise<void>;
  fireClose(): void;
  /** How many handlers were registered — one per owner, or the bug is back. */
  readonly handlers: { frames: number; closes: number };
}

function endpoint(name: string): Wire {
  const frames: ((data: Uint8Array) => void)[] = [];
  const closes: (() => void)[] = [];
  let other: Wire | null = null;
  /** One frame at a time, in order, the way a socket delivers them. */
  let queue: Promise<void> = Promise.resolve();

  const wire: Wire & { link(peer: Wire): void } = {
    peer: name,
    channel: {
      send(frame: Uint8Array): void {
        // Copied: a `Session` may reuse the buffer once `send` returns.
        const copy = frame.slice();
        queue = queue.then(async () => {
          await other?.deliver(copy);
        });
      },
      bufferedAmount: 0,
    },
    onFrame(handler): void {
      frames.push(handler);
    },
    onClose(handler): void {
      closes.push(handler);
    },
    close(): void {
      wire.fireClose();
      other?.fireClose();
    },
    async deliver(data): Promise<void> {
      // Handlers are async; awaiting each keeps one frame from overtaking the
      // one before it.
      for (const handler of frames) await handler(data);
    },
    fireClose(): void {
      for (const handler of closes) handler();
    },
    link(peer): void {
      other = peer;
    },
    get handlers() {
      return { frames: frames.length, closes: closes.length };
    },
  };
  return wire;
}

function pair(): [Wire, Wire] {
  const a = endpoint('a');
  const b = endpoint('b');
  (a as Wire & { link(peer: Wire): void }).link(b);
  (b as Wire & { link(peer: Wire): void }).link(a);
  return [a, b];
}

/**
 * Wait until something is true, rather than for a fixed number of turns.
 *
 * The exchange is driven by microtasks and takes an unpredictable number of
 * them: a fixed count passes on a fast machine and fails on a slow one, which
 * is the kind of test that fails once a fortnight and gets rerun rather than
 * read.
 */
async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the exchange to settle');
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
  }
}

describe('Client', () => {
  it('holds a space with a writing key, and writes to it', async () => {
    const client = new Client({ store: new MemoryStore() });
    const key = await generateKeyPair();
    const space = await client.hold(key.publicKey, key);

    expect(space.writable).toBe(true);
    await client.close();
  });

  it('opens read-only without a writing key', async () => {
    const client = new Client({ store: new MemoryStore() });
    const key = await generateKeyPair();
    const space = await client.hold(key.publicKey);

    // §6.1: storing and serving without ever being able to write is an
    // ordinary way to participate, not a degraded one.
    expect(space.writable).toBe(false);
    await client.close();
  });

  it('takes the writing key from the supplied source', async () => {
    const key = await generateKeyPair();
    const client = new Client({
      store: new MemoryStore(),
      keys: { keyFor: async (id) => (id === hex(key.publicKey) ? key : null) },
    });

    expect((await client.hold(key.publicKey)).writable).toBe(true);
    await client.close();
  });

  it('opens read-only when another writer holds the lock (§7.3)', async () => {
    const key = await generateKeyPair();
    const client = new Client({
      store: new MemoryStore(),
      lock: async (): Promise<WriteLock> => NO_LOCK,
    });

    // The key is here, but someone else is writing with it. Forking would
    // produce two validly signed events at one sequence number.
    expect((await client.hold(key.publicKey, key)).writable).toBe(false);
    await client.close();
  });

  it('writes when no lock mechanism is supplied at all', async () => {
    // Absent means unlocked, not locked: a runtime with no way to exclude a
    // second writer must not thereby lose the ability to write.
    const client = new Client({ store: new MemoryStore() });
    const key = await generateKeyPair();
    expect((await client.hold(key.publicKey, key)).writable).toBe(true);
    await client.close();
  });

  it('syncs a space between two clients over a connection', async () => {
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });

    const written = await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);
    await written.write(new Uint8Array(16), ':name', new TextEncoder().encode('shared'));

    const [x, y] = pair();
    await b.join(hex(key.publicKey), y);
    await a.join(hex(key.publicKey), x);
    await until(() => b.space(hex(key.publicKey))?.state.root.get(':name')?.value === 'shared');

    expect(b.space(hex(key.publicKey))?.state.root.get(':name')?.value).toBe('shared');
    await a.close();
    await b.close();
  });

  it('pushes a later local write to a connected peer', async () => {
    // Reconciliation only runs when vectors are exchanged, so without the push
    // on change a live connection goes stale the moment either side writes.
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);

    const written = await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);

    const [x, y] = pair();
    await b.join(id, y);
    await a.join(id, x);
    await until(() => b.peers().length === 1);

    await written.write(new Uint8Array(16), ':name', new TextEncoder().encode('later'));
    await until(() => b.space(id)?.state.root.get(':name')?.value === 'later');

    expect(b.space(id)?.state.root.get(':name')?.value).toBe('later');
    await a.close();
    await b.close();
  });

  it('refuses an adopted connection for a space it does not hold', async () => {
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);
    await a.hold(key.publicKey, key);

    const refused: string[] = [];
    b.observe({ onRefused: (space) => refused.push(space) });

    const [x, y] = pair();
    b.adopt(y);
    await a.join(id, x);
    await until(() => refused.length > 0);

    // Closing is the honest answer: there is nothing to sync.
    expect(refused).toEqual([id]);
    await a.close();
    await b.close();
  });

  it('accepts an unknown space when told to', async () => {
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const hub = new Client({ store: new MemoryStore(), acceptUnknownSpaces: true });
    const id = hex(key.publicKey);

    const written = await a.hold(key.publicKey, key);
    await written.write(new Uint8Array(16), ':name', new TextEncoder().encode('hub'));

    const [x, y] = pair();
    hub.adopt(y);
    await a.join(id, x);
    await until(() => hub.space(id)?.state.root.get(':name')?.value === 'hub');

    // A space is named by its own key, so holding it needs nothing beyond what
    // the connection already said.
    expect(hub.space(id)?.state.root.get(':name')?.value).toBe('hub');
    await a.close();
    await hub.close();
  });

  it('builds one session per connection, however frames arrive', async () => {
    // Both ways in wire the connection, and for a while both wired *delivery*
    // as well: an adopted connection reads its own frames to learn which space
    // it is about, so a second handler in `attach` meant every frame was
    // processed twice. `adopt` has a second hazard behind it — `attach` is
    // asynchronous, so frames arriving while it runs must wait for the session
    // being opened rather than each starting another.
    //
    // Note what is *not* asserted: that an event is reported once. A peer may
    // legitimately send the same range twice (reconciliation on HELLO, then
    // answering a WANT), and `receive` is fire-and-forget, so two of them can
    // overlap. That is the protocol's business, not this class's.
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const hub = new Client({ store: new MemoryStore(), acceptUnknownSpaces: true });
    const id = hex(key.publicKey);

    const written = await a.hold(key.publicKey, key);
    await written.write(new Uint8Array(16), ':name', new TextEncoder().encode('once'));

    const [x, y] = pair();
    hub.adopt(y);
    await a.join(id, x);
    await until(() => hub.space(id)?.state.root.get(':name')?.value === 'once');
    // Let any duplicate wiring show itself.
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));

    // One session and one connection for the one link that exists.
    expect(hub.availability(id)).toHaveLength(1);
    expect(hub.peers()).toHaveLength(1);

    // And exactly one owner of delivery on each side. `adopt` reads frames
    // itself, so it registers the handler; `join` registers its own. Two on
    // one connection is the duplicate-delivery bug, and it is invisible from
    // the outside because the store deduplicates what it causes.
    expect(y.handlers.frames).toBe(1);
    expect(y.handlers.closes).toBe(1);
    expect(x.handlers.frames).toBe(1);
    expect(x.handlers.closes).toBe(1);

    await a.close();
    await hub.close();
  });

  it('reports a peer going away once', async () => {
    // Same hazard on the close path: two handlers meant `dropped` twice.
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);
    await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);

    const gone: string[] = [];
    a.observe({ onDisconnect: (_space, peer) => void gone.push(peer) });

    const [x, y] = pair();
    await b.join(id, y);
    await a.join(id, x);
    await until(() => a.peers().length === 1);

    x.close();
    await until(() => a.peers().length === 0);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
    expect(gone).toEqual(['a']);

    await a.close();
    await b.close();
  });

  it('drops sessions and connections when a link closes', async () => {
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);
    await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);

    const [x, y] = pair();
    await b.join(id, y);
    await a.join(id, x);
    await until(() => a.peers().length === 1);

    x.close();
    await until(() => a.peers().length === 0);
    expect(a.peers()).toEqual([]);

    await a.close();
    await b.close();
  });

  it('reports activity for an operator', async () => {
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);

    const written = await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);
    await written.write(new Uint8Array(16), ':name', new TextEncoder().encode('seen'));

    const seen: string[] = [];
    b.observe({ onActivity: (activity) => seen.push(activity.channel) });

    const [x, y] = pair();
    await b.join(id, y);
    await a.join(id, x);
    await until(() => seen.includes('log'));

    // The three channels (§10) are otherwise invisible, so arriving events are
    // reported even though nothing in the protocol needs them to be.
    expect(seen).toContain('log');
    expect(b.recent().some((activity) => activity.channel === 'log')).toBe(true);
    await a.close();
    await b.close();
  });

  it('forgets a space entirely', async () => {
    const store = new MemoryStore();
    const client = new Client({ store });
    const key = await generateKeyPair();
    await client.hold(key.publicKey, key);
    expect(await client.list()).toHaveLength(1);

    await client.forget(hex(key.publicKey));
    expect(client.holding()).toEqual([]);
    expect(await client.list()).toEqual([]);
    await client.close();
  });
});
