/**
 * The headless peer.
 *
 * What is worth asserting is the model rather than the plumbing: one space,
 * held whether or not this peer can write to it, reachable when it has an
 * address, and carrying links to others.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { generateKeyPair, hex, links, list, makeFile, makeLink } from '@thing/engine';

import { createSpace, Server } from './server.js';

const dirs: string[] = [];
const servers: Server[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thing-server-'));
  dirs.push(dir);
  return dir;
}

/** A peer serving a space it minted, so it can write. */
async function ownPeer(listen = false): Promise<Server> {
  const dir = await tempDir();
  const key = await createSpace(dir);
  const server = new Server({
    dir,
    space: key.publicKey,
    ...(listen ? { listen: { port: 0, host: '127.0.0.1' } } : {}),
  });
  servers.push(server);
  await server.start();
  return server;
}

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('a headless peer', () => {
  it('serves the one space it was pointed at', async () => {
    const server = await ownPeer();
    expect(server.space).not.toBeNull();
    expect(server.writable).toBe(true);
  });

  it('holds a space it cannot write to', async () => {
    // §6.1: storing and serving without a writing key is an ordinary way to
    // participate — and it is what a hub mirroring someone else's space does.
    const dir = await tempDir();
    const someone = await generateKeyPair();
    const server = new Server({ dir, space: someone.publicKey });
    servers.push(server);
    await server.start();

    expect(server.space).not.toBeNull();
    expect(server.writable).toBe(false);
  });

  it('binds a port when given an address, and none when not', async () => {
    // Reachability is a capability, not a rank (§5.6). A peer without an
    // address is not lesser; it dials instead.
    expect((await ownPeer(true)).port).toBeGreaterThan(0);
    expect((await ownPeer(false)).port).toBe(0);
  });

  it('carries files and links in the space it serves', async () => {
    const server = await ownPeer();
    const space = server.space!;
    const other = await generateKeyPair();

    await makeFile(space, 'notes.txt', new TextEncoder().encode('hi'));
    await makeLink(space, 'theirs', other.publicKey);

    expect(list(space.state).map((e) => e.name)).toEqual(['notes.txt', 'theirs']);
    expect(links(space.state).map((l) => hex(l.target))).toEqual([hex(other.publicKey)]);
  });

  it('reopens the same space from the same directory', async () => {
    const dir = await tempDir();
    const key = await createSpace(dir);

    const first = new Server({ dir, space: key.publicKey });
    await first.start();
    await makeFile(first.space!, 'kept.txt', new TextEncoder().encode('x'));
    await first.close();

    const again = new Server({ dir, space: key.publicKey });
    servers.push(again);
    await again.start();

    expect(list(again.space!.state).map((e) => e.name)).toEqual(['kept.txt']);
    expect(again.writable).toBe(true);
  });
});
