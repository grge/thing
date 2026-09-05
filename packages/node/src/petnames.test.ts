/**
 * Petnames on disk.
 *
 * They live in the store's directory because a petname belongs to the client
 * and the directory is what the client is (§5.5) — so two data directories are
 * two clients, with separate names for the same space.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePetnames } from './petnames.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thing-names-'));
  dirs.push(dir);
  return dir;
}

describe('petnames', () => {
  it('start empty', async () => {
    expect((await new FilePetnames(await tempDir()).all()).size).toBe(0);
  });

  it('persist', async () => {
    const dir = await tempDir();
    await new FilePetnames(dir).set('work', 'aabb');
    // A new instance: nothing carried over but the file.
    expect((await new FilePetnames(dir).all()).get('work')).toBe('aabb');
  });

  it('are replaced rather than duplicated', async () => {
    const dir = await tempDir();
    const names = new FilePetnames(dir);
    await names.set('work', 'aabb');
    await names.set('work', 'ccdd');
    expect((await names.all()).get('work')).toBe('ccdd');
    expect((await names.all()).size).toBe(1);
  });

  it('can be forgotten', async () => {
    const dir = await tempDir();
    const names = new FilePetnames(dir);
    await names.set('work', 'aabb');
    await names.remove('work');
    expect((await names.all()).size).toBe(0);
  });

  it('two directories are two clients', async () => {
    // The reason petnames live with the store: one client's names are its own.
    const a = new FilePetnames(await tempDir());
    const b = new FilePetnames(await tempDir());
    await a.set('mine', 'same-space');
    await b.set('theirs', 'same-space');

    expect([...(await a.all()).keys()]).toEqual(['mine']);
    expect([...(await b.all()).keys()]).toEqual(['theirs']);
  });

  it('survives a corrupt file rather than failing to start', async () => {
    // Names are a convenience; losing them must never stop a peer opening its
    // spaces, which is what actually matters.
    const dir = await tempDir();
    await writeFile(join(dir, 'petnames.json'), 'not json at all');
    expect((await new FilePetnames(dir).all()).size).toBe(0);
  });
});
