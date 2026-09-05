/**
 * A peer outside the browser, over real WebSockets.
 *
 * Not a mock channel: an actual server, actual sockets, actual disk. Everything
 * below has been tested without a network already, so what these check is that
 * the transport carries it — and that the claims in §5.6 about reachability
 * hold when there is something real to reach.
 */
import { generateKeyPair, hex, type KeyPair, keyPairFromSeed, SEED_LEN } from '@thing/core';
import { list, makeFile, makeFolder, read } from '@thing/peer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Peer } from './peer.js';

const UTF8 = new TextEncoder();
const dirs: string[] = [];
const peers: Peer[] = [];

afterEach(async () => {
  for (const p of peers.splice(0)) await p.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thing-peer-'));
  dirs.push(dir);
  return dir;
}

async function makePeer(options: { listen?: boolean; accept?: boolean } = {}): Promise<Peer> {
  const peer = new Peer({
    dir: await tempDir(),
    // Port 0 lets the OS choose, so tests never collide.
    ...(options.listen === true ? { listen: { port: 0, host: '127.0.0.1' } } : {}),
    ...(options.accept === true ? { acceptUnknownSpaces: true } : {}),
  });
  peers.push(peer);
  await peer.start();
  return peer;
}

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

async function spaceKey(label = 'space'): Promise<KeyPair> {
  return keyPairFromSeed(labelled(label, SEED_LEN));
}

/** Wait for a condition, so tests do not race the network. */
async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('two peers over a socket', () => {
  it('sync a space', async () => {
    const key = await spaceKey();

    const server = await makePeer({ listen: true });
    const hosted = (await server.hold(key.publicKey, key))!;
    await makeFolder(hosted, 'docs');
    await makeFile(hosted, 'readme.md', UTF8.encode('# hello'), { kind: 'text/markdown' });

    const client = await makePeer();
    await client.connect(`ws://127.0.0.1:${server.port}`, key.publicKey);

    const joined = client.space(hex(key.publicKey))!;
    await until(() => list(joined.state).length === 2);

    expect(list(joined.state).map((e) => e.name).sort()).toEqual(['docs', 'readme.md']);
  });

  it('sync in both directions', async () => {
    const key = await spaceKey();
    const other = await generateKeyPair();

    const server = await makePeer({ listen: true });
    const hosted = (await server.hold(key.publicKey, key))!;
    await makeFolder(hosted, 'from-server');

    const client = await makePeer();
    await client.hold(key.publicKey, other);
    await client.connect(`ws://127.0.0.1:${server.port}`, key.publicKey);

    const joined = client.space(hex(key.publicKey))!;
    await until(() => list(joined.state).length === 1);
    await makeFolder(joined, 'from-client');

    await until(() => list(hosted.state).length === 2);
    expect(list(hosted.state).map((e) => e.name).sort()).toEqual([
      'from-client',
      'from-server',
    ]);
  });

  it('transfer a blob', async () => {
    const key = await spaceKey();
    const bytes = new Uint8Array(50_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11) & 0xff;

    const server = await makePeer({ listen: true });
    const hosted = (await server.hold(key.publicKey, key))!;
    const { id, hash } = await makeFile(hosted, 'big.bin', bytes);

    const client = await makePeer();
    const session = await client.connect(`ws://127.0.0.1:${server.port}`, key.publicKey);

    const joined = client.space(hex(key.publicKey))!;
    await until(() => list(joined.state).length === 1);

    session.requestBlob(hash);
    await until(async () => (await joined.getBlob(hash)) !== null);

    const got = await read(joined, id);
    expect(got).not.toBeNull();
    expect(hex(got!)).toBe(hex(bytes));
  });
});

describe('a hub', () => {
  it('lets two peers that cannot reach each other converge', async () => {
    // The §5.6 claim, and the reason there is no relay code: a peer that syncs
    // with both ends up holding the same log as both, so convergence is what
    // sync already does. Neither client can be dialled; both dial the hub.
    const key = await spaceKey();
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    const hub = await makePeer({ listen: true, accept: true });
    const url = `ws://127.0.0.1:${hub.port}`;

    const a = await makePeer();
    const aSpace = (await a.hold(key.publicKey, alice))!;
    await makeFolder(aSpace, 'from-alice');
    await a.connect(url, key.publicKey);

    const b = await makePeer();
    const bSpace = (await b.hold(key.publicKey, bob))!;
    await makeFolder(bSpace, 'from-bob');
    await b.connect(url, key.publicKey);

    // Each syncs with the hub; nothing connects a to b.
    await until(() => list(aSpace.state).length === 2 && list(bSpace.state).length === 2);

    expect(list(aSpace.state).map((e) => e.name).sort()).toEqual(['from-alice', 'from-bob']);
    expect(list(bSpace.state).map((e) => e.name).sort()).toEqual(['from-alice', 'from-bob']);
  });

  it('holds the space, so a later peer collects it after the first has gone', async () => {
    // What a byte-forwarding relay cannot do. The events are *in* the hub, so
    // both parties never have to be online at once.
    const key = await spaceKey();
    const alice = await generateKeyPair();

    const hub = await makePeer({ listen: true, accept: true });
    const url = `ws://127.0.0.1:${hub.port}`;

    const a = await makePeer();
    const aSpace = (await a.hold(key.publicKey, alice))!;
    await makeFolder(aSpace, 'left-behind');
    await a.connect(url, key.publicKey);

    // The hub opens the space when the connection names it, so wait for that
    // rather than assuming it has happened.
    await until(() => hub.space(hex(key.publicKey)) !== null);
    const hubSpace = hub.space(hex(key.publicKey))!;
    await until(() => list(hubSpace.state).length === 1);

    // Alice disconnects entirely.
    await a.close();
    peers.splice(peers.indexOf(a), 1);

    const b = await makePeer();
    await b.hold(key.publicKey);
    await b.connect(url, key.publicKey);
    const bSpace = b.space(hex(key.publicKey))!;

    await until(() => list(bSpace.state).length === 1);
    expect(list(bSpace.state).map((e) => e.name)).toEqual(['left-behind']);
  });

  it('refuses a space it was not told to serve, by default', async () => {
    // Accepting anything offered is how a hub becomes free storage for
    // strangers, so it is opt-in.
    const key = await spaceKey();
    const closed = await makePeer({ listen: true });

    const client = await makePeer();
    await client.hold(key.publicKey, key);
    await client.connect(`ws://127.0.0.1:${closed.port}`, key.publicKey);

    // Nothing to assert positively: the hub simply never holds it.
    await new Promise((r) => setTimeout(r, 100));
    expect(await closed.list()).not.toContain(hex(key.publicKey));
  });
});

describe('restarting', () => {
  it('resumes from disk and keeps serving', async () => {
    const key = await spaceKey();
    const dir = await tempDir();

    const first = new Peer({ dir, listen: { port: 0, host: '127.0.0.1' } });
    await first.start();
    const hosted = (await first.hold(key.publicKey, key))!;
    await makeFolder(hosted, 'before-restart');
    await first.close();

    // A new process would look like this: same directory, nothing in memory.
    const second = new Peer({ dir, listen: { port: 0, host: '127.0.0.1' } });
    peers.push(second);
    await second.start();
    const reopened = (await second.hold(key.publicKey, key))!;
    expect(list(reopened.state).map((e) => e.name)).toEqual(['before-restart']);

    const client = await makePeer();
    await client.connect(`ws://127.0.0.1:${second.port}`, key.publicKey);
    const joined = client.space(hex(key.publicKey))!;
    await until(() => list(joined.state).length === 1);
    expect(list(joined.state).map((e) => e.name)).toEqual(['before-restart']);
  });
});

describe('reachability', () => {
  it('a peer with no address still participates by dialling out', async () => {
    // §5.6: an unreachable peer cannot be dialled, so it dials. Once open the
    // connection is symmetric — the protocol does not care who started it.
    const key = await spaceKey();
    const server = await makePeer({ listen: true });
    const hosted = (await server.hold(key.publicKey, key))!;
    await makeFolder(hosted, 'reachable');

    const unreachable = await makePeer(); // no listen
    expect(unreachable.port).toBe(0);

    await unreachable.connect(`ws://127.0.0.1:${server.port}`, key.publicKey);
    const joined = unreachable.space(hex(key.publicKey))!;
    await until(() => list(joined.state).length === 1);
    expect(list(joined.state).map((e) => e.name)).toEqual(['reachable']);
  });

  it('reports a connection that cannot be made', async () => {
    const key = await spaceKey();
    const peer = await makePeer();
    // Port 1 is privileged and nothing is listening there.
    await expect(peer.connect('ws://127.0.0.1:1', key.publicKey)).rejects.toThrow(/could not reach/);
  });
});
