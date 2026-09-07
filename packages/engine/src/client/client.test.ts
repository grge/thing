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

import { generateKeyPair, hex, ROOT } from '../core/index.js';
import { MemoryStore } from '../store/index.js';
import { connectionPair as pair, until } from '../net/testwire.js';
import { Client } from './client.js';
import { NO_LOCK, type WriteLock } from './types.js';

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

  it('does not report synced while the peer cannot have the events (§2.3.1)', async () => {
    // The claim `--at` rests on: when `synced` resolves covered, the peer
    // holds the write. Stalling the wire makes that checkable without timing —
    // while frames are held, the peer provably has nothing, so a `covered`
    // here would be a lie rather than a race won.
    const key = await generateKeyPair();
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);

    await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);

    const [x, y] = pair();
    await a.join(id, x);
    await b.join(id, y);
    await until(() => b.space(id) !== null);

    x.stall();
    await a.space(id)!.write(ROOT, ':name', new TextEncoder().encode('held'));

    const answer = await a.synced(id, { timeoutMs: 60 });
    expect(answer.kind).toBe('behind');
    // And the peer really did not have it, which is what makes that correct.
    expect(b.space(id)?.state.root.get(':name')?.value).not.toBe('held');

    await x.release();
    expect((await a.synced(id, { timeoutMs: 500 })).kind).toBe('covered');
    expect(b.space(id)?.state.root.get(':name')?.value).toBe('held');

    await a.close();
    await b.close();
  });

  it('reports behind rather than covered with no peers at all', async () => {
    // A client that wrote and is connected to nobody has told nobody. Saying
    // "covered" because no peer disagreed is the exact lie §2.3.1 exists to
    // prevent.
    const key = await generateKeyPair();
    const client = new Client({ store: new MemoryStore() });
    const id = hex(key.publicKey);
    await client.hold(key.publicKey, key);
    await client.space(id)!.write(ROOT, ':name', new TextEncoder().encode('alone'));

    expect((await client.synced(id, { timeoutMs: 50 })).kind).toBe('behind');
    await client.close();
  });

  it('waits for every connected peer, not the first to answer', async () => {
    // A client connected to two holders that exits when one is caught up has
    // told the other nothing.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const a = new Client({ store: new MemoryStore() });
    const b = new Client({ store: new MemoryStore() });
    const c = new Client({ store: new MemoryStore() });

    await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);
    await c.hold(key.publicKey);

    const [toB, fromA1] = pair('a-b', 'b-a');
    const [toC, fromA2] = pair('a-c', 'c-a');
    await a.join(id, toB);
    await b.join(id, fromA1);
    await a.join(id, toC);
    await c.join(id, fromA2);
    await until(() => b.space(id) !== null && c.space(id) !== null);

    // Only the second peer is stalled.
    toC.stall();
    await a.space(id)!.write(ROOT, ':name', new TextEncoder().encode('both'));

    // The unstalled peer really is caught up, so an implementation satisfied
    // by *any* peer would answer covered here. That is what makes this a test
    // of "every peer" rather than of stalling.
    await until(() => b.space(id)?.state.root.get(':name')?.value === 'both');
    expect(c.space(id)?.state.root.get(':name')?.value).toBeUndefined();

    expect((await a.synced(id, { timeoutMs: 60 })).kind).toBe('behind');

    await toC.release();
    expect((await a.synced(id, { timeoutMs: 500 })).kind).toBe('covered');

    await a.close();
    await b.close();
    await c.close();
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
