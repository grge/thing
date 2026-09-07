/**
 * The browser client's tab model (`docs/MAIN-SPACE.md`).
 *
 * The properties worth pinning are the ones the rebuild exists for: opening a
 * space writes nothing, following a link opens a tab rather than acquiring the
 * space, and a client need hold nothing of its own.
 *
 * Runs under `fake-indexeddb`, a real implementation rather than a stub, and a
 * `localStorage` shim — the two browser globals the client reaches for.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  contentHash,
  entry,
  generateKeyPair,
  hex,
  links,
  list,
  makeFile,
  makeFolder,
  makeLink,
  read,
  move,
  remove,
  rename,
  ROOT,
} from '@thing/engine';

import { Client } from './client.js';

/** Enough `localStorage` for the keyring. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

describe('tabs', () => {
  it('opens a space without writing anything', async () => {
    // The whole point of separating *open* from *keep*: browsing leaves no
    // trace, so a log does not accumulate a record of everything looked at.
    const client = new Client();
    const someone = await generateKeyPair();

    const tab = await client.open(someone.publicKey);

    expect(tab.id).toBe(hex(someone.publicKey));
    expect(tab.writable).toBe(false); // no key for it, so read-only
    await client.close();
  });

  it('holds several spaces at once', async () => {
    // What distinguishes a client from a server: a renderer can show many.
    const client = new Client();
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    await client.open(a.publicKey, 'first');
    await client.open(b.publicKey, 'second');

    expect(client.view().map((t) => t.name)).toEqual(['first', 'second']);
    await client.close();
  });

  it('opening the same space twice is one tab', async () => {
    const client = new Client();
    const a = await generateKeyPair();
    await client.open(a.publicKey);
    await client.open(a.publicKey);
    expect(client.view()).toHaveLength(1);
    await client.close();
  });

  it('closing a tab leaves the others alone', async () => {
    const client = new Client();
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    await client.open(a.publicKey, 'keep');
    await client.open(b.publicKey, 'drop');

    await client.closeTab(hex(b.publicKey));

    expect(client.view().map((t) => t.name)).toEqual(['keep']);
    await client.close();
  });

  it('follows a link into a new tab, carrying its name', async () => {
    // A petname was a local lookup table; it is now the name of the link the
    // tab was opened from, which comes along for free.
    const client = new Client();
    const mine = await client.create('mine');
    const target = await generateKeyPair();
    await makeLink(client.space(mine.id)!, 'theirs', target.publicKey);

    const opened = await client.follow(mine.id, 'theirs');

    expect(opened).not.toBeNull();
    expect(opened!.id).toBe(hex(target.publicKey));
    expect(opened!.name).toBe('theirs');
    expect(client.view()).toHaveLength(2);
    await client.close();
  });

  it('following a link does not add it to your own space', async () => {
    // Opening is not acquiring. This is the assertion the rebuild exists for.
    const client = new Client();
    const mine = await client.create('mine');
    const target = await generateKeyPair();
    await makeLink(client.space(mine.id)!, 'theirs', target.publicKey);

    const before = links(client.space(mine.id)!.state).length;
    await client.follow(mine.id, 'theirs');
    const after = links(client.space(mine.id)!.state).length;

    expect(after).toBe(before);
    await client.close();
  });

  it('following a link that is not there is null, not an error', async () => {
    const client = new Client();
    const mine = await client.create('mine');
    expect(await client.follow(mine.id, 'nothing')).toBeNull();
    await client.close();
  });

  it('a client holds nothing of its own until asked', async () => {
    // §6.1 goes one further here: participating without holding anything.
    const client = new Client();
    expect(client.view()).toEqual([]);
    await client.close();
  });

  it('a space it minted is writable, and its contents fold', async () => {
    const client = new Client();
    const tab = await client.create('mine');
    await makeFolder(client.space(tab.id)!, 'docs');

    expect(client.view()[0]!.writable).toBe(true);
    expect(list(client.view()[0]!.state).map((e) => e.name)).toEqual(['docs']);
    await client.close();
  });

  it('adds a file and reads its bytes back', async () => {
    // What the UI does on a drop: write bytes, then read them to preview.
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;

    await makeFile(space, 'notes.txt', new TextEncoder().encode('hello'), {
      kind: 'text/plain',
    });

    const found = list(space.state).find((e) => e.name === 'notes.txt')!;
    expect(found.kind).toBe('text/plain');
    expect(new TextDecoder().decode((await read(space, found.id))!)).toBe('hello');
    await client.close();
  });

  it('puts a file in the folder it was dropped into', async () => {
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;

    const folder = await makeFolder(space, 'docs');
    await makeFile(space, 'inside.txt', new TextEncoder().encode('x'), { parent: folder });

    expect(list(space.state).map((e) => e.name)).toEqual(['docs']);
    expect(list(space.state, folder).map((e) => e.name)).toEqual(['inside.txt']);
    await client.close();
  });

  it('a file can be in the tree with its bytes elsewhere', async () => {
    // §2.4: events replicate to everyone, blobs are pulled by whoever wants
    // them. So a tab can show a file it cannot yet read — which is exactly the
    // preview's "asking peers" state, and why it retries when one appears.
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;

    // A file the events describe but whose bytes this client does not hold:
    // written by hand rather than through `makeFile`, which would store them.
    const id = new Uint8Array(16).fill(7);
    await space.write(id, ':name', new TextEncoder().encode('elsewhere.bin'));
    await space.write(id, ':kind', new TextEncoder().encode('application/octet-stream'));
    await space.write(id, ':body', new Uint8Array(32).fill(9));

    const found = entry(space.state, id)!;
    expect(found.name).toBe('elsewhere.bin');
    expect(contentHash(space.state, id)).not.toBeNull();
    expect(await read(space, id)).toBeNull();

    await client.close();
  });

  it('nests folders, so a tree can show depth', async () => {
    // The tree expands in place rather than navigating, so it needs the whole
    // shape available at once — `list` per parent, at any depth.
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;

    const outer = await makeFolder(space, 'outer');
    const inner = await makeFolder(space, 'inner', outer);
    await makeFile(space, 'deep.txt', new TextEncoder().encode('x'), { parent: inner });

    expect(list(space.state).map((e) => e.name)).toEqual(['outer']);
    expect(list(space.state, outer).map((e) => e.name)).toEqual(['inner']);
    expect(list(space.state, inner).map((e) => e.name)).toEqual(['deep.txt']);
    await client.close();
  });

  it('renames in place, keeping the same object', async () => {
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;
    await makeFile(space, 'before.txt', new TextEncoder().encode('x'));
    const id = list(space.state)[0]!.id;

    await rename(space, id, 'after.txt');

    expect(list(space.state).map((e) => e.name)).toEqual(['after.txt']);
    expect(hex(list(space.state)[0]!.id)).toBe(hex(id)); // same object
    await client.close();
  });

  it('deleting hides without unwriting (§7.2.3)', async () => {
    // The events stay in the log. A peer that already has them keeps them, and
    // nothing about the past is rewritten.
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;
    await makeFile(space, 'gone.txt', new TextEncoder().encode('x'));
    const id = list(space.state)[0]!.id;

    await remove(space, id);

    expect(list(space.state)).toEqual([]);
    expect(list(space.state, ROOT, { includeDeleted: true }).map((e) => e.name)).toEqual([
      'gone.txt',
    ]);
    await client.close();
  });

  it('moves an object into a folder', async () => {
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;
    const folder = await makeFolder(space, 'docs');
    await makeFile(space, 'loose.txt', new TextEncoder().encode('x'));
    const file = list(space.state).find((e) => e.name === 'loose.txt')!;

    await move(space, file.id, folder);

    expect(list(space.state).map((e) => e.name)).toEqual(['docs']);
    expect(list(space.state, folder).map((e) => e.name)).toEqual(['loose.txt']);
    await client.close();
  });

  it('keeping a space writes a link named as the tab was', async () => {
    // Dragging a tab into a space is the moment *looking at* becomes *kept*
    // (docs/MAIN-SPACE.md). What it writes is an ordinary link.
    const client = new Client();
    const mine = await client.create('mine');
    const theirs = await generateKeyPair();
    await client.open(theirs.publicKey, 'theirs');

    const space = client.space(mine.id)!;
    await makeLink(space, 'theirs', theirs.publicKey);

    const kept = links(space.state);
    expect(kept.map((l) => l.entry.name)).toEqual(['theirs']);
    expect(hex(kept[0]!.target)).toBe(hex(theirs.publicKey));
    await client.close();
  });

  it('a kept space is still just a tab until reopened', async () => {
    // Keeping does not change what is open, and opening does not keep. The two
    // are separate acts, which is the whole point of the distinction.
    const client = new Client();
    const mine = await client.create('mine');
    const theirs = await generateKeyPair();
    await makeLink(client.space(mine.id)!, 'theirs', theirs.publicKey);

    expect(client.view().map((t) => t.name)).toEqual(['mine']);

    const opened = await client.follow(mine.id, 'theirs');
    expect(opened!.name).toBe('theirs');
    expect(client.view()).toHaveLength(2);
    await client.close();
  });

  it('tells a view when something changed', async () => {
    const client = new Client();
    let redraws = 0;
    const off = client.subscribe(() => (redraws += 1));

    await client.open((await generateKeyPair()).publicKey);

    expect(redraws).toBeGreaterThan(0);
    off();
    await client.close();
  });
});
