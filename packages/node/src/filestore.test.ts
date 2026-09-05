/**
 * The Node backend against the shared conformance suite.
 *
 * The suite is the same one the memory backend runs (`@thing/engine`), which is
 * the point: a browser and a headless peer must behave identically, and the
 * only way to be sure is one set of expectations rather than two that look
 * similar.
 */
import { conformanceTests, type Store } from '@thing/engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './filestore.js';

const dirs: string[] = [];

conformanceTests(
  'files',
  async (): Promise<Store> => {
    const dir = await mkdtemp(join(tmpdir(), 'thing-store-'));
    dirs.push(dir);
    return new FileStore(dir);
  },
  async () => {
    // Each store gets its own temp directory; clear them as they are finished
    // with, so a failing run does not leave the tmpdir full.
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  },
);
