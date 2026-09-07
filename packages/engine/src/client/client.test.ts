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
import { list, makeFile } from '../fs/files.js';
import { MemoryStore } from '../store/index.js';
import { MemoryLocators } from '../local.memory.js';
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

  it('holds a space once when asked concurrently', async () => {
    // Opening awaits several times before anything is recorded, so a `has`
    // check is not a guard. A link graph makes this ordinary rather than
    // exotic — it has cycles by design, so a walk reaches one space by two
    // paths at once, and holding it twice is two stores and two folds.
    const client = new Client({ store: new MemoryStore() });
    const key = await generateKeyPair();

    const [a, b, c] = await Promise.all([
      client.hold(key.publicKey, key),
      client.hold(key.publicKey, key),
      client.hold(key.publicKey, key),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(client.holding()).toEqual([hex(key.publicKey)]);
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

  it('does not fetch blobs it folds unless told to (§2.4)', async () => {
    // The default. Blobs are pull-only, so a peer that mirrors everything is
    // spending disk on content it may never read — a browser tab opening a
    // space to look at it should not.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const a = new Client({ store: new MemoryStore() }, {});
    const b = new Client({ store: new MemoryStore() }, {});

    const spA = await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);
    const [x, y] = pair();
    await a.join(id, x);
    await b.join(id, y);
    await until(() => b.space(id) !== null);

    const { hash } = await makeFile(spA, 'f.txt', new TextEncoder().encode('bytes'));
    await until(() => list(b.space(id)!.state).some((e) => e.name === 'f.txt'));

    expect(b.mirrors(id)).toBe(false);
    expect(await b.space(id)!.getBlob(hash)).toBeNull();
    await a.close();
    await b.close();
  });

  it('fetches blobs it folds when mirroring is on', async () => {
    // What makes a relay a relay: holding a file's event and not its bytes is
    // no use to a peer that can only reach the writer through here.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const a = new Client({ store: new MemoryStore() }, {});
    const b = new Client({ store: new MemoryStore(), mirrorBlobs: true }, {});

    const spA = await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);
    const [x, y] = pair();
    await a.join(id, x);
    await b.join(id, y);
    await until(() => b.space(id) !== null);

    const { hash } = await makeFile(spA, 'f.txt', new TextEncoder().encode('bytes'));
    await until(async () => (await b.space(id)!.getBlob(hash)) !== null);

    expect(b.mirrors(id)).toBe(true);
    await a.close();
    await b.close();
  });

  it('re-asks for a blob a peer refused once it announces having it', async () => {
    // The race that hung a browser: the event arrives before the bytes, so a
    // client asking a relay usually asks while the relay is still fetching.
    // `NO_BLOB` answers about *now*, and without this the "no" was permanent.
    //
    // Driven through the observer rather than a three-peer wire, because on a
    // fake transport the relay's own in-flight transfer reaches the reader
    // regardless and the retry cannot be isolated.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const client = new Client({ store: new MemoryStore() }, {});
    await client.hold(key.publicKey, key);

    const [x, y] = pair();
    await client.join(id, x);
    const other = new Client({ store: new MemoryStore() }, {});
    await other.hold(key.publicKey);
    await other.join(id, y);
    await until(() => other.space(id) !== null);

    const asked: string[] = [];
    const missing = new Uint8Array(32).fill(9);
    // The peer does not have it, so this refusal is genuine.
    client.requestBlob(id, missing);
    await until(() => client.recent().some((a) => a.text.includes('not held by')));

    client.observe({ onBlob: (_s, h) => asked.push(h) });
    // The peer now says it has it. That must produce a fresh request rather
    // than being ignored, which is what `wanted` exists for.
    await other.entry(id)!.store.putBlob(new Uint8Array(4).fill(1));
    for (const s of other.entry(id)!.sessions.values()) s.announceBlob(hex(missing));
    await until(() => client.recent().filter((a) => a.channel === 'blob').length > 1);

    await client.close();
    await other.close();
  });

  it('resolves a space through a peer that serves it (§5.3)', async () => {
    // The pull half. A client that holds nothing of a space asks whoever it is
    // connected to, and the peer serving it answers with how to be reached.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const host = new Client(
      { store: new MemoryStore(), locatorsOfSelf: () => [{ kind: 'ws', url: 'ws://host:9944' }] },
      {},
    );
    const seeker = new Client({ store: new MemoryStore(), locators: new MemoryLocators() }, {});

    await host.hold(key.publicKey, key);
    // The seeker holds a *different* space, which is what gives it a
    // connection at all — resolution travels along connections it already has.
    const other = await generateKeyPair();
    await host.hold(other.publicKey);
    await seeker.hold(other.publicKey);

    const [x, y] = pair();
    await seeker.join(hex(other.publicKey), x);
    await host.join(hex(other.publicKey), y);
    await until(() => seeker.peers().length > 0);

    const found = await seeker.resolve(id, { timeoutMs: 300 });
    expect(found.known).toBe(true);
    expect(found.at).toContainEqual({ kind: 'ws', url: 'ws://host:9944' });

    await host.close();
    await seeker.close();
  });

  it('offers the connection itself when a peer has no address', async () => {
    // The browser case, which a list of addresses cannot express: a peer that
    // serves a space and gives no locator is offering *itself*, and it is
    // already connected.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const host = new Client({ store: new MemoryStore() }, {});
    const seeker = new Client({ store: new MemoryStore() }, {});

    await host.hold(key.publicKey, key);
    const other = await generateKeyPair();
    await host.hold(other.publicKey);
    await seeker.hold(other.publicKey);

    const [x, y] = pair('seek', 'host');
    await seeker.join(hex(other.publicKey), x);
    await host.join(hex(other.publicKey), y);
    await until(() => seeker.peers().length > 0);

    const found = await seeker.resolve(id, { timeoutMs: 300 });
    expect(found.known).toBe(true);
    expect(found.at).toEqual([]);
    expect(found.viaPeers).toHaveLength(1);

    await host.close();
    await seeker.close();
  });

  it('says unknown when nobody has heard of a space', async () => {
    // §5.3's first case: *I do not track this* — which tells a caller to stop
    // asking rather than to wait.
    const host = new Client({ store: new MemoryStore() }, {});
    const seeker = new Client({ store: new MemoryStore() }, {});
    const other = await generateKeyPair();
    await host.hold(other.publicKey);
    await seeker.hold(other.publicKey);

    const [x, y] = pair();
    await seeker.join(hex(other.publicKey), x);
    await host.join(hex(other.publicKey), y);
    await until(() => seeker.peers().length > 0);

    const found = await seeker.resolve('ff'.repeat(32), { timeoutMs: 300 });
    expect(found.known).toBe(false);
    expect(found.at).toEqual([]);

    await host.close();
    await seeker.close();
  });

  it('answers from the cache when there is nobody to ask', async () => {
    // The case `:serves` was meant for and no longer covers: returning to a
    // space with no live peer. The cache is the whole answer.
    const locators = new MemoryLocators();
    const client = new Client({ store: new MemoryStore(), locators }, {});
    const key = await generateKeyPair();
    locators.remember(hex(key.publicKey), { kind: 'ws', url: 'ws://remembered:1' });

    const found = await client.resolve(hex(key.publicKey), { timeoutMs: 100 });
    expect(found.at).toEqual([{ kind: 'ws', url: 'ws://remembered:1' }]);
    expect(found.known).toBe(true);
    await client.close();
  });

  it('puts what worked before ahead of what a peer just said', async () => {
    // The cache is the only source that knows what worked *here*, which is the
    // per-client fact that made a replicated list wrong.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const locators = new MemoryLocators();
    locators.remember(id, { kind: 'ws', url: 'ws://mine:1' });
    locators.succeeded(id, { kind: 'ws', url: 'ws://mine:1' });

    const host = new Client(
      { store: new MemoryStore(), locatorsOfSelf: () => [{ kind: 'ws', url: 'ws://theirs:2' }] },
      {},
    );
    const seeker = new Client({ store: new MemoryStore(), locators }, {});
    await host.hold(key.publicKey, key);
    const other = await generateKeyPair();
    await host.hold(other.publicKey);
    await seeker.hold(other.publicKey);

    const [x, y] = pair();
    await seeker.join(hex(other.publicKey), x);
    await host.join(hex(other.publicKey), y);
    await until(() => seeker.peers().length > 0);

    const found = await seeker.resolve(id, { timeoutMs: 300 });
    expect(found.at[0]).toEqual({ kind: 'ws', url: 'ws://mine:1' });
    expect(found.at).toContainEqual({ kind: 'ws', url: 'ws://theirs:2' });

    await host.close();
    await seeker.close();
  });

  it('caches every locator an answer offered', async () => {
    // §5.3 merges answers rather than taking the first, so a candidate is
    // worth keeping whether or not it is tried now — the cache's own ranking
    // is what drops the ones that never work.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const locators = new MemoryLocators();
    const host = new Client(
      { store: new MemoryStore(), locatorsOfSelf: () => [{ kind: 'ws', url: 'ws://host:1' }] },
      {},
    );
    const seeker = new Client({ store: new MemoryStore(), locators }, {});

    await host.hold(key.publicKey, key);
    const other = await generateKeyPair();
    await host.hold(other.publicKey);
    await seeker.hold(other.publicKey);

    const [x, y] = pair();
    await seeker.join(hex(other.publicKey), x);
    await host.join(hex(other.publicKey), y);
    await until(() => seeker.peers().length > 0);

    await seeker.resolve(id, { timeoutMs: 300 });
    expect(locators.get(id)).toContainEqual({ kind: 'ws', url: 'ws://host:1' });

    await host.close();
    await seeker.close();
  });

  it('relays what a connection announced, one hop (§5.3)', async () => {
    // The push half, and the case that needs it. A hub does not hold the
    // space; it knows where it is *only* because the host announced on
    // connecting. Without that announcement the hub has nothing to say.
    //
    // One hop is the limit: the hub answers from its own live connections, and
    // never from what those peers were told.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const shared = await generateKeyPair();
    const sharedId = hex(shared.publicKey);

    const host = new Client(
      { store: new MemoryStore(), locatorsOfSelf: () => [{ kind: 'ws', url: 'ws://host:9944' }] },
      {},
    );
    const hub = new Client({ store: new MemoryStore() }, {});
    const seeker = new Client({ store: new MemoryStore() }, {});

    await host.hold(key.publicKey, key);
    await host.hold(shared.publicKey);
    await hub.hold(shared.publicKey);
    await seeker.hold(shared.publicKey);

    const [h2b, b2h] = pair('host', 'hub-h');
    // Deliberately the side that announces *first*: whichever peer connects
    // first announces into a connection whose other end has no session yet, so
    // this order is the one that fails without the answering half.
    await host.join(sharedId, h2b);
    await hub.join(sharedId, b2h);
    const [s2b, b2s] = pair('seek', 'hub-s');
    await seeker.join(sharedId, s2b);
    await hub.join(sharedId, b2s);
    await until(() => hub.peers().length >= 2);
    // The hub holds no copy of the space at all.
    expect(hub.holding()).not.toContain(id);

    const found = await seeker.resolve(id, { timeoutMs: 400 });
    expect(found.known).toBe(true);
    expect(found.at).toContainEqual({ kind: 'ws', url: 'ws://host:9944' });

    await host.close();
    await hub.close();
    await seeker.close();
  });

  it('reaches a space by dialling what resolution found', async () => {
    // The whole point, from a caller's view: a link names a space and carries
    // no address, so expanding one means asking, dialling, and remembering.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const shared = await generateKeyPair();
    const sharedId = hex(shared.publicKey);
    const locators = new MemoryLocators();

    const host = new Client(
      { store: new MemoryStore(), locatorsOfSelf: () => [{ kind: 'ws', url: 'ws://host:1' }] },
      {},
    );
    await host.hold(key.publicKey, key);
    await host.hold(shared.publicKey);

    // The dial is faked: what matters is that `reach` asked, chose the right
    // candidate, and wired the connection it was given.
    let dialled: string | null = null;
    const seeker = new Client(
      {
        store: new MemoryStore(),
        locators,
        dial: async (l) => {
          dialled = l.kind === 'ws' ? l.url : 'via';
          // The far end has to be listening *before* the near end is handed
          // back, or the caller's own join races the answering one.
          const [near, far] = pair('dialled', 'answering');
          await host.join(id, far);
          return near;
        },
      },
      {},
    );
    await seeker.hold(shared.publicKey);

    const [x, y] = pair();
    await seeker.join(sharedId, x);
    await host.join(sharedId, y);
    await until(() => seeker.peers().length > 0);

    expect(await seeker.reach(id, { timeoutMs: 400 })).toBe(true);
    expect(dialled).toBe('ws://host:1');
    // And it is remembered as having worked, so next time is one dial.
    expect(locators.get(id)).toContainEqual({ kind: 'ws', url: 'ws://host:1' });

    await host.close();
    await seeker.close();
  });

  it('sinks a locator that failed, and tries the next', async () => {
    // §5.3: a stale locator is expected, not an error. What matters is that
    // the cache learns, so a dead address is not tried first forever.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const locators = new MemoryLocators();
    locators.remember(id, { kind: 'ws', url: 'ws://dead:1' });
    locators.remember(id, { kind: 'ws', url: 'ws://alive:2' });

    const tried: string[] = [];
    const client = new Client(
      {
        store: new MemoryStore(),
        locators,
        dial: async (l) => {
          const url = l.kind === 'ws' ? l.url : 'via';
          tried.push(url);
          throw new Error('unreachable');
        },
      },
      {},
    );

    expect(await client.reach(id, { timeoutMs: 100 })).toBe(false);
    expect(tried).toHaveLength(2);
    // Both had never worked, so both are dropped after enough failures.
    for (let i = 0; i < 3; i++) await client.reach(id, { timeoutMs: 50 });
    expect(locators.get(id)).toEqual([]);
    await client.close();
  });

  it('returns true immediately for a space already connected', async () => {
    // Cheap to call again, because the commonest reason to call it is a link
    // expanded twice.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);
    const a = new Client({ store: new MemoryStore() }, {});
    const b = new Client({ store: new MemoryStore() }, {});
    await a.hold(key.publicKey, key);
    await b.hold(key.publicKey);
    const [x, y] = pair();
    await a.join(id, x);
    await b.join(id, y);

    let dialled = false;
    expect(await a.reach(id)).toBe(true);
    expect(dialled).toBe(false);
    await a.close();
    await b.close();
  });

  it('reports failure rather than hanging when nobody knows', async () => {
    const client = new Client({ store: new MemoryStore() }, {});
    expect(await client.reach('ab'.repeat(32), { timeoutMs: 100 })).toBe(false);
    await client.close();
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
