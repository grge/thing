/**
 * The file backends against the same contract the memory ones satisfy.
 *
 * The reason this suite exists: `node` and `web` had solved these four jobs
 * four different ways, and nothing checked they agreed. One of them — locators
 * — `node` had not solved at all.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

import { localConformanceTests } from '@thing/engine/local-conformance';

import { FileInventory, FileKeyring, FileLocators } from './local.js';
import { FilePetnames } from './petnames.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thing-local-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

localConformanceTests('files', {
  keys: async () => new FileKeyring(await tempDir()),
  inventory: async () => {
    const dir = await tempDir();
    // Standing in for the store's own listing: the directories that exist.
    const held = new Set<string>();
    const inv = new FileInventory(dir, async () => [...held]);
    return {
      all: () => inv.all(),
      remember: async (s) => {
        held.add(s);
        await inv.remember(s);
      },
      forget: async (s) => {
        held.delete(s);
        await inv.forget(s);
      },
    };
  },
  petnames: async () => new FilePetnames(await tempDir()),
  locators: async () => FileLocators.load(await tempDir()),
});
