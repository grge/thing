#!/usr/bin/env node
/**
 * The command-line peer.
 *
 * A peer with an address serves; one without dials outward. Both are the same
 * program with different flags, because reachability is the only thing that
 * differs (ARCHITECTURE.md §5.6).
 *
 * ```
 *   thing create [--name X]              mint a space and print its key
 *   thing list                           spaces held here
 *   thing serve [--port N]               accept connections
 *   thing join <key> <url>               dial a peer and sync one space
 *   thing ls <key> [path]                what a space contains
 *   thing put <key> <file> [--as name]   write a file into a space
 *   thing get <key> <name> [--out file] [--from url]
                                       read one back, fetching if needed
 * ```
 *
 * Keys live beside the spaces they open, which is a placeholder: §5.1.1 says a
 * key is something a person must be able to back up and move, and a real answer
 * belongs with whatever the product decides about identity.
 */
import { generateKeyPair, hex, type KeyPair, keyPairFromSeed } from '@thing/core';
import { contentHash, entry, list, makeFile, read, type Space } from '@thing/peer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Peer } from './peer.js';

const UTF8 = new TextEncoder();

/**
 * Where spaces live.
 *
 * `$THING_DIR`, else the XDG data directory, else a dotfile. The library takes
 * a path and never chooses one; choosing is the CLI's job because the CLI is
 * what has a user and a home directory.
 */
function dataDir(): string {
  const explicit = process.env['THING_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg !== '') return join(xdg, 'thing');
  return join(homedir(), '.local', 'share', 'thing');
}

function keyPath(dir: string, id: string): string {
  return join(dir, `${id}.key`);
}

/** Load a space's writing key, if this machine holds one. */
async function loadKey(dir: string, id: string): Promise<KeyPair | undefined> {
  try {
    const seed = await readFile(keyPath(dir, id));
    return await keyPairFromSeed(new Uint8Array(seed));
  } catch {
    return undefined;
  }
}

async function saveKey(dir: string, key: KeyPair): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(keyPath(dir, hex(key.publicKey)), key.privateKey, { mode: 0o600 });
}

function keyFromHex(s: string): Uint8Array {
  if (s.length !== 64 || !/^[0-9a-f]+$/i.test(s)) {
    throw new Error(`not a space key: ${s}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A peer holding one space, with its key if we have it. */
async function openSpace(id: string): Promise<{ peer: Peer; space: Space }> {
  const dir = dataDir();
  const peer = new Peer({ dir });
  const key = keyFromHex(id);
  const writer = await loadKey(dir, id);
  const space = await peer.hold(key, writer);
  if (space === null) throw new Error(`could not open ${id}`);
  return { peer, space };
}

/** `--flag value` and `--flag=value`, plus positionals. */
function parse(argv: readonly string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      flags[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return { positional, flags };
}

const USAGE = `thing — a peer-to-peer space

  thing create [--name X]              mint a space and print its key
  thing list                           spaces held here
  thing serve [--port N] [--accept]    accept connections
  thing join <key> <url>               dial a peer and sync one space
  thing ls <key>                       what a space contains
  thing put <key> <file> [--as name]   write a file into a space
  thing get <key> <name> [--out file] [--from url]
                                       read one back, fetching if needed

Spaces live in $THING_DIR, or the XDG data directory.`;

async function main(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  const command = positional[0];

  switch (command) {
    case 'create': {
      const key = await generateKeyPair();
      const dir = dataDir();
      await saveKey(dir, key);

      const peer = new Peer({ dir });
      const space = await peer.hold(key.publicKey, key);
      const name = flags['name'];
      if (name !== undefined && name !== '' && space !== null) {
        // The root's suggested name (§3.5), written by the space key.
        await space.write(new Uint8Array(16), ':name', UTF8.encode(name));
      }
      await peer.close();

      process.stdout.write(`${hex(key.publicKey)}\n`);
      return 0;
    }

    case 'list': {
      const peer = new Peer({ dir: dataDir() });
      for (const id of await peer.list()) process.stdout.write(`${id}\n`);
      await peer.close();
      return 0;
    }

    case 'serve': {
      const dir = dataDir();
      const port = Number.parseInt(flags['port'] ?? '9944', 10);
      const peer = new Peer({
        dir,
        listen: { port },
        acceptUnknownSpaces: flags['accept'] !== undefined,
        onFork: (space, fork) => {
          // §2.3: a fork is reported loudly and does not stall the rest.
          process.stderr.write(
            `fork in ${space.slice(0, 8)}: writer ${fork.writer.slice(0, 8)} ` +
              `diverged at ${fork.frontier}\n`,
          );
        },
      });

      // Hold everything already on disk, so a restart resumes serving.
      for (const id of await peer.list()) {
        await peer.hold(keyFromHex(id), await loadKey(dir, id));
      }
      await peer.start();

      process.stdout.write(`serving ${(await peer.list()).length} space(s) on :${peer.port}\n`);
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => resolve());
        process.on('SIGTERM', () => resolve());
      });
      await peer.close();
      return 0;
    }

    case 'join': {
      const id = positional[1];
      const url = positional[2];
      if (id === undefined || url === undefined) {
        process.stderr.write('usage: thing join <key> <url>\n');
        return 2;
      }

      const dir = dataDir();
      const peer = new Peer({ dir });
      await peer.hold(keyFromHex(id), await loadKey(dir, id));
      await peer.connect(url, keyFromHex(id));

      process.stdout.write(`syncing ${id.slice(0, 8)} with ${url}; ctrl-c to stop\n`);
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => resolve());
        process.on('SIGTERM', () => resolve());
      });
      await peer.close();
      return 0;
    }

    case 'ls': {
      const id = positional[1];
      if (id === undefined) {
        process.stderr.write('usage: thing ls <key>\n');
        return 2;
      }
      const { peer, space } = await openSpace(id);
      for (const e of list(space.state)) {
        process.stdout.write(`${e.isFolder ? 'd' : '-'} ${e.name}\n`);
      }
      await peer.close();
      return 0;
    }

    case 'put': {
      const id = positional[1];
      const path = positional[2];
      if (id === undefined || path === undefined) {
        process.stderr.write('usage: thing put <key> <file>\n');
        return 2;
      }
      const { peer, space } = await openSpace(id);
      if (!space.writable) {
        process.stderr.write(`no writing key for ${id.slice(0, 8)}\n`);
        await peer.close();
        return 1;
      }
      const bytes = new Uint8Array(await readFile(path));
      const name = flags['as'] ?? basename(path);
      await makeFile(space, name, bytes);
      await peer.close();
      process.stdout.write(`wrote ${name} (${bytes.length} bytes)\n`);
      return 0;
    }

    case 'get': {
      const id = positional[1];
      const name = positional[2];
      if (id === undefined || name === undefined) {
        process.stderr.write('usage: thing get <key> <name>\n');
        return 2;
      }
      const { peer, space } = await openSpace(id);
      const found = list(space.state).find((e) => e.name === name);
      if (found === undefined) {
        process.stderr.write(`no such entry: ${name}\n`);
        await peer.close();
        return 1;
      }
      let bytes = await read(space, found.id);
      if (bytes === null && flags['from'] !== undefined) {
        // Events replicate to everyone; blobs are pulled by whoever wants them
        // (§2.4). So the metadata can be here while the content is not, and
        // fetching it means asking a peer.
        const session = await peer.connect(flags['from']!, keyFromHex(id));
        const hash = contentHash(space.state, found.id);
        if (hash !== null) {
          session.requestBlob(hash);
          const deadline = Date.now() + 5000;
          while (bytes === null && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
            bytes = await read(space, found.id);
          }
        }
      }
      if (bytes === null) {
        // The honest state a distributed system has and a local one does not.
        process.stderr.write(
          `${name} is known but its content is not held here` +
            `${flags['from'] === undefined ? '; try --from <url>' : ''}\n`,
        );
        await peer.close();
        return 1;
      }
      const out = flags['out'];
      if (out === undefined) process.stdout.write(Buffer.from(bytes).toString());
      else await writeFile(out, bytes);
      await peer.close();
      return 0;
    }

    case 'inspect': {
      // What one object looks like, for when a space does not behave.
      const id = positional[1];
      const name = positional[2];
      if (id === undefined || name === undefined) {
        process.stderr.write('usage: thing inspect <key> <name>\n');
        return 2;
      }
      const { peer, space } = await openSpace(id);
      const found = list(space.state, undefined, { includeDeleted: true }).find(
        (e) => e.name === name,
      );
      if (found === undefined) {
        await peer.close();
        return 1;
      }
      const o = entry(space.state, found.id)!;
      process.stdout.write(`uuid    ${hex(o.id)}\n`);
      process.stdout.write(`kind    ${o.kind ?? '-'}\n`);
      process.stdout.write(`deleted ${o.deleted}\n`);
      for (const [attr, slice] of o.object.attrs) {
        process.stdout.write(`  ${attr} = ${String(slice.value)} [${slice.rule}]\n`);
      }
      if (o.object.bodyRuleMissing !== undefined) {
        process.stdout.write(`  body unreadable: no rule for ${o.object.bodyRuleMissing}\n`);
      }
      await peer.close();
      return 0;
    }

    default:
      process.stdout.write(`${USAGE}\n`);
      return command === undefined || command === 'help' ? 0 : 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
