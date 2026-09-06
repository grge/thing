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
import { codeFor, contentHash, entry, generateKeyPair, hex, type KeyPair, keyPairFromSeed, list, makeFile, namesFor, read, resolveName, type Space, type SpaceNames } from '@thing/engine';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Peer } from './peer.js';
import { FilePetnames } from './petnames.js';

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

/**
 * Everything this client knows a space by (§5.5).
 *
 * The suggested name is read from the root, which means opening the space —
 * cheap for a handful, and the only way to know what a space calls itself.
 */
async function knownSpaces(dir: string): Promise<SpaceNames[]> {
  const peer = new Peer({ dir });
  const petnames = await new FilePetnames(dir).all();
  const byId = new Map<string, string>();
  for (const [name, id] of petnames) byId.set(id, name);

  const out: SpaceNames[] = [];
  try {
    for (const id of await peer.list()) {
      const key = keyFromHex(id);
      const space = await peer.hold(key, await loadKey(dir, id));
      // The suggested name lives on the root (§3.5), which is a slice map
      // rather than an object — the root is where a space's own attributes go.
      const suggested = space?.state.root.get(':name')?.value ?? null;
      out.push(
        namesFor(key, {
          petname: byId.get(id) ?? null,
          suggested: typeof suggested === 'string' ? suggested : null,
        }),
      );
    }
  } finally {
    await peer.close();
  }
  return out;
}

/**
 * Turn what a person typed into one space.
 *
 * Petname, then suggested name, then code, then key prefix (§4.6) — and an
 * ambiguous name is an error rather than a guess.
 */
async function findSpace(dir: string, query: string): Promise<string> {
  const spaces = await knownSpaces(dir);
  const found = resolveName(query, spaces);
  if (found.ok) return found.id;
  if (found.why.kind === 'ambiguous') {
    throw new Error(
      `"${query}" could mean ${found.why.matches.length} spaces: ` +
        found.why.matches.map((m) => m.slice(0, 8)).join(', '),
    );
  }
  throw new Error(`no space called "${query}"`);
}

/** A peer holding one space, with its key if we have it. */
async function openSpace(query: string): Promise<{ peer: Peer; space: Space; id: string }> {
  const dir = dataDir();
  const id = await findSpace(dir, query);
  const peer = new Peer({ dir });
  const space = await peer.hold(keyFromHex(id), await loadKey(dir, id));
  if (space === null) throw new Error(`could not open ${id}`);
  return { peer, space, id };
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

/**
 * What a long-running peer says about itself.
 *
 * A server that prints one line at startup and then goes silent is one you
 * cannot tell is working — you cannot see whether anyone connected, whether
 * anything synced, or whether it is simply stuck. None of this is protocol; it
 * is for whoever is watching the terminal.
 *
 * To stderr, so `thing serve` can still be piped for its stdout.
 */
function activityLog(enabled: boolean): {
  onConnect?: (peer: string, space: string | null) => void;
  onDisconnect?: (peer: string) => void;
  onRefused?: (peer: string, space: string) => void;
  onEvents?: (space: string, events: readonly unknown[]) => void;
  onBlob?: (space: string, hash: string, bytes: number) => void;
  onFork?: (space: string, fork: { chain: string; frontier: number }) => void;
} {
  if (!enabled) return {};
  const at = (): string => new Date().toISOString().slice(11, 19);
  const short = (s: string): string => s.slice(0, 8);
  const say = (line: string): void => {
    process.stderr.write(`${at()} ${line}\n`);
  };

  return {
    onConnect: (peer, space) => {
      // Twice per connection: once when it opens, once when it says what it is
      // about. The second is the useful one.
      say(space === null ? `${peer} connected` : `${peer} → ${short(space)}`);
    },
    onDisconnect: (peer) => say(`${peer} gone`),
    onRefused: (peer, space) =>
      say(`${peer} wanted ${short(space)}, refused (use --accept to hold it)`),
    onEvents: (space, events) =>
      // Counts arrivals, not net additions. Peers exchange overlapping ranges
      // — reconciliation on HELLO, then again answering a WANT — and the store
      // deduplicates, so a space that received six events may report them more
      // than once. Fine for seeing that traffic is flowing; not a measure of
      // how much is stored. `thing ls` is the answer to that.
      say(`${short(space)} +${events.length} event(s)`),
    onBlob: (space, hash, bytes) => say(`${short(space)} blob ${short(hash)} ${bytes} bytes`),
    onFork: (space, fork) =>
      // §2.3: a fork is reported loudly and does not stall the rest.
      // A chain, not a writer: one identity may hold several (§2.1), and a
      // fork now means equivocation rather than someone opening a second tab.
      say(`${short(space)} FORK: chain ${short(fork.chain)} diverged at ${fork.frontier}`),
  };
}

const USAGE = `thing — a peer-to-peer space

  thing create [--name X]              mint a space and print its key
  thing list [--keys]                  spaces held here
  thing key <space>                    a space's full key, for sharing
  thing name <space> <petname>         call a space something local
  thing serve [--port N] [--accept]    accept connections
                       [--quiet]       ... without the activity log
  thing join <key> <url>               dial a peer and sync one space
  thing ls <key>                       what a space contains
  thing put <key> <file> [--as name]   write a file into a space
  thing get <key> <name> [--out file] [--from url]
                                       read one back, fetching if needed

A <space> is a petname, the space's own name, its short code, or its key.

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
      process.stderr.write(`code ${codeFor(key.publicKey)}\n`);
      return 0;
    }

    case 'list': {
      // The code and the name are for *using* a space here; the key is for
      // sharing it, and `join` needs all 64 characters. A truncated prefix
      // serves neither purpose, so it is either shown whole or not at all.
      const spaces = await knownSpaces(dataDir());
      if (flags['keys'] !== undefined) {
        for (const s of spaces) process.stdout.write(`${s.id}\n`);
        return 0;
      }
      for (const s of spaces) {
        const label = s.petname !== null ? `${s.display} (petname)` : s.display;
        process.stdout.write(`${s.code}  ${label}\n`);
      }
      if (spaces.length > 0) {
        process.stderr.write(`\n${spaces.length} space(s). --keys for full keys, or: thing key <space>\n`);
      }
      return 0;
    }

    case 'key': {
      // The full key, for sharing. Nothing else prints one, because everything
      // else is about using a space this client already holds.
      const query = positional[1];
      if (query === undefined) {
        process.stderr.write('usage: thing key <space>\n');
        return 2;
      }
      process.stdout.write(`${await findSpace(dataDir(), query)}\n`);
      return 0;
    }

    case 'name': {
      // A petname is this client's own (§5.5). Nothing is replicated, and two
      // clients may call the same space different things.
      const query = positional[1];
      const name = positional[2];
      const dir = dataDir();
      if (query === undefined) {
        process.stderr.write('usage: thing name <space> <petname>   (or --forget <petname>)\n');
        return 2;
      }
      const petnames = new FilePetnames(dir);
      if (flags['forget'] !== undefined) {
        await petnames.remove(query);
        return 0;
      }
      if (name === undefined) {
        process.stderr.write('usage: thing name <space> <petname>\n');
        return 2;
      }
      await petnames.set(name, await findSpace(dir, query));
      process.stdout.write(`${name}\n`);
      return 0;
    }

    case 'serve': {
      const dir = dataDir();
      const port = Number.parseInt(flags['port'] ?? '9944', 10);
      const peer = new Peer({
        dir,
        listen: { port },
        acceptUnknownSpaces: flags['accept'] !== undefined,
        ...activityLog(flags['quiet'] === undefined),
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
      const peer = new Peer({ dir, ...activityLog(flags['quiet'] === undefined) });
      // A key, always — joining is how a space this client has never met
      // arrives, so there is no local name to resolve yet.
      const key = keyFromHex(id);
      await peer.hold(key, await loadKey(dir, id));
      await peer.connect(url, key);

      process.stdout.write(`syncing ${codeFor(key)} with ${url}; ctrl-c to stop\n`);
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
      const { peer, space, id: spaceId } = await openSpace(id);
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
        const session = await peer.connect(flags['from']!, keyFromHex(spaceId));
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

// `thing list | head -1` closes stdout early, and an unhandled EPIPE would
// crash rather than exit quietly. A CLI that cannot be piped is a CLI nobody
// pipes.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
