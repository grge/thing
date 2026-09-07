/**
 * Hosting linked spaces: what makes a hub a hub.
 *
 * **The link is the authorisation** (`docs/design/MAIN-SPACE.md`). Adding a link to
 * your own space inside a server's main space is how you ask it to host that
 * space — a far narrower rule than `acceptUnknownSpaces`, which makes a peer
 * free storage for anyone who connects. Only someone who may write the main
 * space can add a link, so the permission model is the one that already exists.
 *
 * The workflow these pin down: make a space in a browser, drop a link to it in
 * your synced copy of the hub's space, and the hub now holds and serves it —
 * content included, since hosting a space whose bytes you cannot serve is not
 * hosting it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  Client,
  generateKeyPair,
  hex,
  list,
  makeFile,
  makeLink,
  type KeyPair,
} from '@thing/engine';

import { FileStore } from './filestore.js';
import { FileKeyring } from './local.js';
import { createSpace, Server } from './server.js';
import { dial } from './transport.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thing-host-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A hub: its own space, listening, hosting whatever it links to. */
async function hub(hostDepth?: number): Promise<{ server: Server; key: KeyPair; url: string }> {
  const dir = await tempDir();
  const key = await createSpace(dir);
  const server = new Server({
    dir,
    space: key.publicKey,
    listen: { port: 0, host: '127.0.0.1' },
    ...(hostDepth === undefined ? {} : { hostDepth }),
  });
  cleanup.push(() => server.close());
  await server.start();
  return { server, key, url: `ws://127.0.0.1:${server.port}` };
}

/** A client with a space of its own, as a browser would have. */
async function owner(): Promise<{ client: Client; key: KeyPair; dir: string }> {
  const dir = await tempDir();
  const key = await new FileKeyring(dir).mint();
  const client = new Client({
    store: new FileStore(dir),
    keys: { keyFor: (id) => new FileKeyring(dir).keyFor(id) },
  });
  cleanup.push(() => client.close());
  return { client, key, dir };
}

const waitFor = async (what: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (await what()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

describe('a hub hosts what its main space links to', () => {
  it('holds a linked space, and did not before the link', async () => {
    const { server, key } = await hub();
    const other = await generateKeyPair();

    expect(server.hosting).toEqual([hex(key.publicKey)]);

    await makeLink(server.space!, 'someones-space', other.publicKey);
    await waitFor(() => server.hosting.length === 2);

    expect(server.hosting).toContain(hex(other.publicKey));
  });

  it('serves a linked space to a peer that connects about it', async () => {
    // The point of hosting: a space the hub was never told about directly is
    // now one it will talk to strangers about.
    const { server, url } = await hub();
    const mine = await owner();

    await makeLink(server.space!, 'mine', mine.key.publicKey);
    await waitFor(() => server.hosting.length === 2);

    const space = await mine.client.hold(mine.key.publicKey, mine.key);
    await makeFile(space, 'hosted.txt', new TextEncoder().encode('served by the hub'));

    // Dialling the hub about a space that is not its main space.
    await mine.client.join(hex(mine.key.publicKey), await dial(url));
    await waitFor(() => (mine.client.synced(hex(mine.key.publicKey), { timeoutMs: 3000 })
      .then((r) => r.kind === 'covered')));

    // A *third* peer, which has never met the owner, gets it from the hub.
    const reader = await owner();
    await reader.client.hold(mine.key.publicKey);
    await reader.client.join(hex(mine.key.publicKey), await dial(url));
    await waitFor(() =>
      list(reader.client.space(hex(mine.key.publicKey))!.state).some((e) => e.name === 'hosted.txt'),
    );
  });

  it('mirrors a hosted space\'s blobs, so the content is served too', async () => {
    // Hosting a space whose bytes cannot be served is not hosting it — and the
    // owner may well be offline by the time anyone reads it.
    const { server, url } = await hub();
    const mine = await owner();

    await makeLink(server.space!, 'mine', mine.key.publicKey);
    await waitFor(() => server.hosting.length === 2);

    const space = await mine.client.hold(mine.key.publicKey, mine.key);
    const { hash } = await makeFile(space, 'content.txt', new TextEncoder().encode('the bytes'));
    await mine.client.join(hex(mine.key.publicKey), await dial(url));

    // The hub fetches the bytes itself, without anyone asking it to.
    await waitFor(async () => (await server.blobOf(hex(mine.key.publicKey), hash)) !== null);
  });

  it('goes and finds a linked space rather than waiting (§5.3)', async () => {
    // Hosting a space and waiting for its owner to turn up makes hosting
    // useless whenever they are offline: the hub holds the space, mirrors its
    // blobs, and has never heard a word of it. A link names a space and
    // carries no address, so something has to ask.
    const { server, url } = await hub();
    const mine = await owner();
    const mineId = hex(mine.key.publicKey);

    // The owner is listening at a known address and holds content. Its server
    // reuses the *same* directory, so it finds the key that `owner()` minted —
    // a fresh directory would hold the space read-only.
    const ownerServer = new Server({
      dir: mine.dir,
      space: mine.key.publicKey,
      listen: { port: 0, host: '127.0.0.1' },
    });
    cleanup.push(() => ownerServer.close());
    await ownerServer.start();
    await makeFile(ownerServer.space!, 'found-me.txt', new TextEncoder().encode('reached'));

    // The hub is told where it is, as a share link or a person would.
    server.remember(mineId, `ws://127.0.0.1:${ownerServer.port}`);

    // Linking is the whole instruction: no address, no admin verb.
    await makeLink(server.space!, 'theirs', mine.key.publicKey);

    await waitFor(() => {
      const held = server.spaceOf(mineId);
      return held !== null && list(held.state).some((e) => e.name === 'found-me.txt');
    });
    void url;
  });

  it('a stranger reaches a hosted space through the hub (§5.3)', async () => {
    // The chain resolution exists for. Someone who knows only the hub's
    // address ends up holding a space they had never heard of.
    //
    // **They must share a space with the hub to have a connection at all.**
    // Resolution travels along connections you already have, and a connection
    // is per space — so dialling a hub about a space it does not hold is
    // refused, correctly. Linking the hub is how a person follows one, and the
    // hub's own main space is what everyone can ask about.
    const { server: hubServer, key: hubKey, url: hubUrl } = await hub();

    const ownerPeer = await owner();
    const ownerServer = new Server({
      dir: ownerPeer.dir,
      space: ownerPeer.key.publicKey,
      listen: { port: 0, host: '127.0.0.1' },
    });
    cleanup.push(() => ownerServer.close());
    await ownerServer.start();
    await makeFile(ownerServer.space!, 'shared.txt', new TextEncoder().encode('via the hub'));
    const ownerId = hex(ownerPeer.key.publicKey);

    // The hub is told where the owner is, then curates a link to it.
    hubServer.remember(ownerId, `ws://127.0.0.1:${ownerServer.port}`);
    await makeLink(hubServer.space!, 'theirs', ownerPeer.key.publicKey);
    await waitFor(() => hubServer.spaceOf(ownerId) !== null);

    // A stranger follows the hub, which is the only address it has.
    const strangerDir = await tempDir();
    const strangerKey = await createSpace(strangerDir);
    const stranger = new Server({ dir: strangerDir, space: strangerKey.publicKey });
    cleanup.push(() => stranger.close());
    await stranger.start();
    stranger.remember(hex(hubKey.publicKey), hubUrl);
    await makeLink(stranger.space!, 'the-hub', hubKey.publicKey);
    await waitFor(() => stranger.peers().length > 0);

    // It has never heard of the owner's space, and asks.
    expect(stranger.spaceOf(ownerId)).toBeNull();
    expect(await stranger.reach(ownerId)).toBe(true);

    await waitFor(() => {
      const held = stranger.spaceOf(ownerId);
      return held !== null && list(held.state).some((e) => e.name === 'shared.txt');
    });
  });

  it('hosts a space held only by a peer that cannot be dialled (§5.3)', async () => {
    // The case hosting exists for, and the one that did not work until a
    // connection could carry several spaces (`design/CONNECTIONS.md`).
    //
    // A browser cannot be dialled, so when a hub decides to host a space held
    // there it has no second connection to open. It has to use the one the
    // browser already opened — which means resolving over that connection,
    // then greeting for a second space on it.
    const { server: hubServer, key: hubKey, url } = await hub();
    const hubId = hex(hubKey.publicKey);

    // A "browser": it dials, and has no address of its own.
    const dir = await tempDir();
    const keyring = new FileKeyring(dir);
    await keyring.mintFor(hubId);
    const browser = new Client(
      {
        store: new FileStore(dir),
        keys: { keyFor: (i) => keyring.keyFor(i) },
      },
      {},
    );
    cleanup.push(() => browser.close());
    await browser.hold(hubKey.publicKey, (await keyring.keyFor(hubId)) ?? undefined);
    await browser.join(hubId, await dial(url));
    await waitFor(() => browser.peers().length > 0);

    // It makes a space of its own and puts something in it.
    const mine = await keyring.mint();
    const mineId = hex(mine.publicKey);
    const mineSpace = await browser.hold(mine.publicKey, mine);
    await makeFile(mineSpace, 'only-here.md', new TextEncoder().encode('# held in a browser'));

    // Linking it is the whole instruction — no address, and none to give.
    await makeLink(browser.space(hubId)!, 'mine', mine.publicKey);

    // The hub resolves it over the connection the browser opened, greets for
    // it there, and ends up holding the content.
    await waitFor(() => {
      const held = hubServer.spaceOf(mineId);
      return held !== null && list(held.state).some((e) => e.name === 'only-here.md');
    });

    // And the browser now has two sessions on one transport.
    expect(browser.peers().filter((p) => p.space === mineId)).toHaveLength(1);
  });

  it('refuses a space it was never linked (§the model)', async () => {
    // The narrowness is the point: a hub hosts what its curators chose, not
    // whatever a stranger offers.
    const { server, key, url } = await hub();
    const stranger = await owner();

    await stranger.client.hold(stranger.key.publicKey, stranger.key);
    await stranger.client.join(hex(stranger.key.publicKey), await dial(url));

    // The hub does not take it on. `onRefused` fires on the *hub's* observer,
    // not the dialler's — the dialler only sees its connection close — so what
    // is asserted here is the thing that matters: nothing was hosted.
    await new Promise((r) => setTimeout(r, 500));
    expect(server.hosting).toEqual([hex(key.publicKey)]);
  });

  it('depth 0 hosts nothing but the main space', async () => {
    const { server } = await hub(0);
    const other = await generateKeyPair();
    await makeLink(server.space!, 'ignored', other.publicKey);
    await new Promise((r) => setTimeout(r, 200));
    expect(server.hosting).toHaveLength(1);
  });

  it('depth 2 follows a link out of a linked space', async () => {
    // A hub of hubs: what the linked space itself links to. Different product,
    // so it is asked for rather than assumed.
    const { server, url } = await hub(2);
    const middle = await owner();
    const far = await generateKeyPair();

    const middleSpace = await middle.client.hold(middle.key.publicKey, middle.key);
    await makeLink(middleSpace, 'far', far.publicKey);

    await makeLink(server.space!, 'middle', middle.key.publicKey);
    await waitFor(() => server.hosting.includes(hex(middle.key.publicKey)));
    // The hub must first *have* the middle space's events to see its links.
    await middle.client.join(hex(middle.key.publicKey), await dial(url));

    // Only once the middle space's own events arrive can its links be seen —
    // which is why every hosted space is watched, not only the main one.
    await waitFor(() => server.hosting.includes(hex(far.publicKey)));
  });
});
