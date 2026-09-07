/**
 * Links (`docs/design/MAIN-SPACE.md`).
 *
 * The properties that matter are that a link is an ordinary object — so a
 * client that has never heard of one still folds the tree — and that its target
 * is a key rather than an address.
 */
import { describe, expect, it } from 'vitest';

import { hex } from '../core/bytes.js';
import { generateKeyPair, keyPairFromSeed, SEED_LEN } from '../core/sign.js';
import { labelled } from '../core/testkit.js';
import { MemoryStore } from '../store/index.js';
import { Space } from '../space.js';
import { list, makeFolder } from './files.js';
import { isLink, links, makeLink, targetOf } from './links.js';

async function open(): Promise<Space> {
  const key = await keyPairFromSeed(labelled('space', SEED_LEN));
  let tick = 0;
  const store = await new MemoryStore().open(hex(key.publicKey), key.publicKey);
  return Space.open(store, { key: key.publicKey, writer: key, now: () => (tick += 1) });
}

describe('links', () => {
  it('points at a space by key', async () => {
    const space = await open();
    const target = await generateKeyPair();
    const id = await makeLink(space, 'notes', target.publicKey);

    expect(hex(targetOf(space.state, id)!)).toBe(hex(target.publicKey));
  });

  it('appears in the tree as an ordinary named object', async () => {
    // §3.1: a client that has never heard of links folds the structure anyway.
    // What makes that true is that a link uses only the fixed vocabulary.
    const space = await open();
    const target = await generateKeyPair();
    await makeLink(space, 'notes', target.publicKey);
    await makeFolder(space, 'docs');

    expect(list(space.state).map((e) => e.name)).toEqual(['docs', 'notes']);
  });

  it('is distinguishable from a folder', async () => {
    const space = await open();
    await makeLink(space, 'remote', (await generateKeyPair()).publicKey);
    await makeFolder(space, 'local');

    const byName = new Map(list(space.state).map((e) => [e.name, e]));
    expect(isLink(byName.get('remote')!)).toBe(true);
    expect(isLink(byName.get('local')!)).toBe(false);
  });

  it('sits in a folder like anything else', async () => {
    const space = await open();
    const folder = await makeFolder(space, 'hub');
    await makeLink(space, 'inside', (await generateKeyPair()).publicKey, folder);

    expect(list(space.state, folder).map((e) => e.name)).toEqual(['inside']);
  });

  it('lists every link in the space, wherever it sits', async () => {
    // "What does this peer know about" is a question about the space, not
    // about a position in its tree.
    const space = await open();
    const folder = await makeFolder(space, 'hub');
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    await makeLink(space, 'top', a.publicKey);
    await makeLink(space, 'nested', b.publicKey, folder);

    expect(links(space.state).map((l) => l.entry.name)).toEqual(['nested', 'top']);
  });

  it('a deleted link is not listed', async () => {
    const space = await open();
    const id = await makeLink(space, 'gone', (await generateKeyPair()).publicKey);
    await space.write(id, ':deleted', Uint8Array.of(1));

    expect(links(space.state)).toEqual([]);
  });

  it('refuses a target that is not a key', async () => {
    const space = await open();
    await expect(makeLink(space, 'bad', new Uint8Array(8))).rejects.toThrow(/32 bytes/);
  });

  it('a folder is not a link, and asking is null rather than an error', async () => {
    const space = await open();
    const folder = await makeFolder(space, 'docs');
    expect(targetOf(space.state, folder)).toBeNull();
  });
});
