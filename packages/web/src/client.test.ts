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
  isLink,
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
  targetOf,
} from '@thing/engine';

import { Client, parsePasted } from './client.js';
import { IdbStore } from './idbstore.js';
import { browserLocalState } from './local.js';

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

  it('reopens what was open, across a reload', async () => {
    // With no inventory (docs/MAIN-SPACE.md), a lost tab list means a space you
    // made yourself is unfindable — nothing else records that it exists. So the
    // list is persisted even though it is interface state.
    const first = new Client();
    const mine = await first.create('mine');
    await first.close();

    // A fresh client over the same storage: what a reload is.
    const second = new Client();
    await second.restore();

    expect(second.view().map((t) => t.id)).toEqual([mine.id]);
    expect(second.view()[0]!.name).toBe('mine');
    await second.close();
  });

  it('forgets a tab that was closed on purpose', async () => {
    const first = new Client();
    const a = await first.create('keep');
    const b = await first.create('drop');
    await first.closeTab(b.id);
    await first.close();

    const second = new Client();
    await second.restore();

    expect(second.view().map((t) => t.id)).toEqual([a.id]);
    await second.close();
  });

  it('a link has no blob to fetch, however its body looks', async () => {
    // A link's body is a 32-byte key, and `contentHash` returns any Uint8Array
    // body — so a preview that asked `contentHash` treated a link as a file
    // whose bytes were missing, and offered to fetch a blob that never existed.
    const client = new Client();
    const tab = await client.create('mine');
    const space = client.space(tab.id)!;
    const target = await generateKeyPair();
    const id = await makeLink(space, 'theirs', target.publicKey);

    // The body is there, and it is a key rather than a hash.
    expect(contentHash(space.state, id)).not.toBeNull();
    expect(hex(targetOf(space.state, id)!)).toBe(hex(target.publicKey));
    // Which is what a caller must distinguish before treating it as content.
    expect(isLink(entry(space.state, id)!)).toBe(true);
    await client.close();
  });

  it('a file inside a linked space belongs to that space', async () => {
    // Previewing a file reached through a link against the *tab's* space finds
    // no such object, and reports "no content" for every file in a hub.
    const client = new Client();
    const mine = await client.create('mine');
    const other = await client.create('theirs');
    await makeFile(client.space(other.id)!, 'theirs.txt', new TextEncoder().encode('hi'));
    await makeLink(client.space(mine.id)!, 'theirs', fromHexKey(other.id));

    const inside = list(client.space(other.id)!.state)[0]!;

    // Looked up in the linked space: found. In the tab's: not there.
    expect(entry(client.space(other.id)!.state, inside.id)?.name).toBe('theirs.txt');
    expect(entry(client.space(mine.id)!.state, inside.id)).toBeNull();
    await client.close();
  });

  it('a space reached twice is the same space, whatever the path', async () => {
    // Two hubs linking each other, or a link back to your own space. Expansion
    // is keyed by path so each occurrence is its own row and a cycle can be
    // walked by hand; the space behind them is one space.
    const client = new Client();
    const a = await client.create('a');
    const b = await client.create('b');
    await makeLink(client.space(a.id)!, 'b', fromHexKey(b.id));
    await makeLink(client.space(b.id)!, 'a', fromHexKey(a.id));

    const intoB = links(client.space(a.id)!.state)[0]!;
    const backToA = links(client.space(b.id)!.state)[0]!;

    expect(hex(intoB.target)).toBe(b.id);
    expect(hex(backToA.target)).toBe(a.id);
    await client.close();
  });

  it('signals a change when a linked space is fetched', async () => {
    // Expanding a link the client does not hold fetches it, and a view has to
    // learn that the contents are now available. Without a signal the tree
    // showed "Fetching…" until some unrelated interaction forced a redraw.
    const client = new Client();
    const mine = await client.create('mine');
    const other = await generateKeyPair();
    await makeLink(client.space(mine.id)!, 'theirs', other.publicKey);

    let signals = 0;
    const off = client.subscribe(() => (signals += 1));

    // What `expandLink` does: hold it, without opening a tab.
    await client.hold(other.publicKey);

    expect(signals).toBeGreaterThan(0);
    expect(client.space(hex(other.publicKey))).not.toBeNull();
    off();
    await client.close();
  });

  it('holding for a link does not add a tab', async () => {
    // Expanding is looking inside; opening is going there. Fetching a linked
    // space to show its contents must not do the second.
    const client = new Client();
    const mine = await client.create('mine');
    const other = await generateKeyPair();

    await client.hold(other.publicKey);

    expect(client.view().map((t) => t.id)).toEqual([mine.id]);
    await client.close();
  });

  it('a second space named the same gets its own name', async () => {
    // Petnames are keyed by name — one name, one space — so naming a second
    // `untitled` would take the name from the first, which would then report a
    // name belonging to something else.
    const client = new Client();
    const a = await client.create('untitled');
    const b = await client.create('untitled');

    const names = client.view().map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe('untitled');
    expect(a.id).not.toBe(b.id);
    await client.close();
  });

  it('renames a space, and the name survives a reload', async () => {
    const first = new Client();
    const tab = await first.create('untitled');
    await first.rename(tab.id, 'notes');
    expect(first.view()[0]!.name).toBe('notes');
    await first.close();

    const second = new Client();
    await second.restore();
    expect(second.view()[0]!.name).toBe('notes');
    await second.close();
  });

  it('renaming onto a taken name takes a free one instead', async () => {
    const client = new Client();
    const a = await client.create('notes');
    const b = await client.create('other');

    const taken = await client.rename(b.id, 'notes');

    expect(taken).not.toBe('notes');
    // And the first space keeps the name it had.
    expect(client.view().find((t) => t.id === a.id)!.name).toBe('notes');
    await client.close();
  });

  it('a space keeps its own name when opened again with another', async () => {
    // An incoming name — from a link, say — should not silently rename a space
    // this client has already named.
    const client = new Client();
    const tab = await client.create('mine');
    await client.rename(tab.id, 'my notes');
    await client.open(fromHexKey(tab.id), 'something else');

    expect(client.view()[0]!.name).toBe('my notes');
    await client.close();
  });

  it('closing a tab frees its name', async () => {
    // Otherwise a closed space goes on holding `untitled`, and the next one is
    // `untitled 2` with nothing else named `untitled` anywhere in sight.
    const client = new Client();
    const first = await client.create('untitled');
    await client.closeTab(first.id);
    const second = await client.create('untitled');

    expect(second.name).toBe('untitled');
    await client.close();
  });

  it('restore clears a name left behind by an older version', async () => {
    // Closing used to forget the inventory entry and keep the petname, where
    // nothing could read it and it went on holding the name. Anyone who closed
    // a tab before that was fixed has one; this sweeps them.
    //
    // The orphan is made directly rather than through `closeTab`, which now
    // cleans up — so this tests the sweep rather than the fix that made it
    // unnecessary going forward.
    const local = browserLocalState();
    await local.petnames.set('untitled', '11'.repeat(32));

    const client = new Client();
    await client.restore();

    expect([...(await local.petnames.all())]).toEqual([]);
    // And the freed name is available.
    expect((await client.create('untitled')).name).toBe('untitled');
    await client.close();
  });

  it('closing a tab deletes the space from storage', async () => {
    // Closing used to close and keep. Nothing then removed a space ever, so a
    // browser accumulated every space it had opened, with no way to drop one.
    const client = new Client();
    const tab = await client.create('mine');
    await makeFile(client.space(tab.id)!, 'f.txt', new TextEncoder().encode('x'));
    expect(await new IdbStore().list()).toContain(tab.id);

    await client.closeTab(tab.id);

    expect(await new IdbStore().list()).not.toContain(tab.id);
    await client.close();
  });

  it('a space held only to expand a link goes with the tab', async () => {
    // Browsing a hub fetches every space you expand. Those are cached rather
    // than kept, and keeping them would mean a visit to one hub leaves fifty
    // spaces behind.
    const client = new Client();
    const tab = await client.create('mine');
    const other = await generateKeyPair();
    await makeLink(client.space(tab.id)!, 'theirs', other.publicKey);
    await client.hold(other.publicKey); // what expanding does

    expect(await new IdbStore().list()).toContain(hex(other.publicKey));

    await client.closeTab(tab.id);

    expect(await new IdbStore().list()).not.toContain(hex(other.publicKey));
    await client.close();
  });

  it('a linked space stays while another tab still links to it', async () => {
    // Two tabs, both linking the same space: closing one must not take it.
    const client = new Client();
    const a = await client.create('a');
    const b = await client.create('b');
    const shared = await generateKeyPair();
    await makeLink(client.space(a.id)!, 'shared', shared.publicKey);
    await makeLink(client.space(b.id)!, 'shared', shared.publicKey);
    await client.hold(shared.publicKey);

    await client.closeTab(a.id);

    expect(await new IdbStore().list()).toContain(hex(shared.publicKey));
    await client.close();
  });

  it('an open tab is never dropped as unreferenced', async () => {
    const client = new Client();
    const a = await client.create('a');
    const b = await client.create('b');

    await client.closeTab(a.id);

    expect(await new IdbStore().list()).toContain(b.id);
    expect(client.view().map((t) => t.id)).toEqual([b.id]);
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

describe('parsePasted', () => {
  const key = 'ab'.repeat(32);

  it('takes a bare key', () => {
    expect(parsePasted(key)).toMatchObject({ key, locator: null, token: null });
  });

  it('lowercases, so a key copied from anywhere works', () => {
    expect(parsePasted(key.toUpperCase())?.key).toBe(key);
  });

  it('ignores surrounding whitespace, which a paste often carries', () => {
    expect(parsePasted(`  ${key}\n`)?.key).toBe(key);
  });

  it('takes a whole share link, with its hint and token', () => {
    const link = parsePasted(`https://example.com/#k=${key}&n=notes&t=abcd&l=ws://x:1`);
    expect(link).toMatchObject({ key, name: 'notes', token: 'abcd', locator: 'ws://x:1' });
  });

  it('takes a bare fragment too', () => {
    expect(parsePasted(`#k=${key}`)?.key).toBe(key);
  });

  it('refuses a short code, which cannot be reversed to a key (§5.4)', () => {
    // A code is derived from the hash of a key: it narrows *where to look*,
    // and a client that has never seen the space has nothing to look through.
    expect(parsePasted('4sektg4g')).toBeNull();
  });

  it('refuses anything that is not a key', () => {
    for (const bad of ['', '   ', 'hello', key.slice(0, 63), `${key}ab`, 'zz'.repeat(32)]) {
      expect(parsePasted(bad)).toBeNull();
    }
  });
});

function fromHexKey(id: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return out;
}
