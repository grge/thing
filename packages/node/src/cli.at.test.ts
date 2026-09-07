/**
 * `--at`: writing to a peer that is already serving the space (§2.3.1).
 *
 * The gap this closes was found in use rather than in a test. Per-process
 * append points (§2.1) made two processes writing one space ordinary — no
 * lock, no fork — but a `serve` that is already running still folds what it
 * loaded at startup, so a `thing put` beside it was invisible until a restart.
 *
 * That is the *notification* half. `--at` dials the running holder so the
 * write reaches it live; §2.3.1 is what makes the command able to say the
 * write actually arrived, rather than exiting on its own append and hoping.
 *
 * These run the real CLI entry point against a real server over a real
 * socket, because every earlier version of this bug survived unit tests and
 * was caught by two processes on a machine.
 *
 * **What a real socket cannot show here.** That a zero exit *means* the holder
 * has the write is untestable at this level: on loopback the events arrive
 * before any assertion can run, so the test passes whether or not the command
 * waited. `client.test.ts` proves that half by stalling a fake wire, where the
 * peer provably cannot have the events. What is checked here is the other
 * half — that a holder which is absent or has gone away yields a non-zero
 * exit rather than a false success.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { list } from '@thing/engine';

import { main } from './cli.js';
import { Server } from './server.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the CLI as a process would, in its own data directory. */
async function cli(dir: string, ...argv: string[]): Promise<number> {
  const before = process.env['THING_DIR'];
  process.env['THING_DIR'] = dir;
  try {
    return await main(argv);
  } finally {
    if (before === undefined) delete process.env['THING_DIR'];
    else process.env['THING_DIR'] = before;
  }
}

/** A directory with a space in it, and a holder already serving that space. */
async function served(): Promise<{ dir: string; server: Server; url: string }> {
  const dir = await tempDir('thing-at-');
  expect(await cli(dir, 'init', '--name', 'demo')).toBe(0);

  const key = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(dir, 'space'), 'utf8'),
  );
  const space = Uint8Array.from(
    (key.trim().match(/../g) ?? []).map((b) => Number.parseInt(b, 16)),
  );

  const server = new Server({ dir, space, listen: { port: 0, host: '127.0.0.1' } });
  await server.start();
  cleanup.push(() => server.close());
  return { dir, server, url: `ws://127.0.0.1:${server.port}` };
}

function names(server: Server): string[] {
  const space = server.space;
  if (space === null) throw new Error('not started');
  return list(space.state).map((e) => e.name).sort();
}

describe('writing to a running holder', () => {
  it('a write without --at does not reach it', async () => {
    // The bug, asserted. Not a correctness failure — the event is on disk,
    // signed, on its own chain, and a restart picks it up — but the holder
    // serving right now has never heard of it.
    const { dir, server } = await served();

    const file = join(await tempDir('thing-src-'), 'quiet.md');
    await writeFile(file, 'written beside a running server');
    expect(await cli(dir, 'put', file)).toBe(0);

    expect(names(server)).toEqual([]);
  });

  it('a write with --at reaches it, with no restart', async () => {
    const { dir, server, url } = await served();

    const file = join(await tempDir('thing-src-'), 'live.md');
    await writeFile(file, 'delivered over the wire');
    expect(await cli(dir, 'put', file, '--at', url)).toBe(0);

    // The holder that was already running has it, in the fold, now.
    expect(names(server)).toEqual(['live.md']);
  });

  it('reports failure when the holder cannot confirm', async () => {
    // The half of §2.3.1 that a real socket can demonstrate: a holder that
    // goes away mid-command must not produce a zero exit. The *positive*
    // claim — that a zero exit means the peer really has it — cannot be
    // tested here, because on loopback delivery wins every race whether or
    // not the command waited; `client.test.ts` stalls a fake wire to prove
    // that one without depending on timing.
    const { dir, server, url } = await served();

    const file = join(await tempDir('thing-src-'), 'vanished.md');
    await writeFile(file, 'x');

    await server.close();
    expect(await cli(dir, 'put', file, '--at', url)).toBe(1);
  });

  it('carries several writes, each confirmed', async () => {
    const { dir, server, url } = await served();
    const src = await tempDir('thing-src-');

    for (const name of ['one.md', 'two.md', 'three.md']) {
      const file = join(src, name);
      await writeFile(file, name);
      expect(await cli(dir, 'put', file, '--at', url)).toBe(0);
    }

    expect(names(server)).toEqual(['one.md', 'three.md', 'two.md']);
  });

  it('links go the same way, since the flag is not about files', async () => {
    // `--at` belongs to writing, not to `put`. A link is a write like any
    // other and needed no code of its own.
    const { dir, server, url } = await served();
    const target = 'a'.repeat(64);

    expect(await cli(dir, 'link', 'elsewhere', target, '--at', url)).toBe(0);
    expect(names(server)).toEqual(['elsewhere']);
  });

  it('fails rather than reporting success when nothing is listening', async () => {
    // The failure mode that matters: a script must not be told the write
    // landed when it reached no one.
    const dir = await tempDir('thing-at-');
    expect(await cli(dir, 'init')).toBe(0);

    const file = join(await tempDir('thing-src-'), 'nowhere.md');
    await writeFile(file, 'x');

    // Port 1 is not a peer, on any machine that is behaving.
    expect(await cli(dir, 'put', file, '--at', 'ws://127.0.0.1:1')).toBe(1);
  });
});
