#!/usr/bin/env node
/**
 * The command-line client.
 *
 * **A peer holds one space and reaches others by following links inside it**
 * (`docs/MAIN-SPACE.md`). So every command names a space, and naming one means
 * either its key or a path of link names from the space this peer serves.
 *
 * ```
 *   thing init [--name X]              mint a space and serve it
 *   thing serve [--port N]             accept connections
 *   thing ls [path]                    what a space contains
 *   thing put <file> [--as name]       write a file in
 *   thing get <name> [--out file]      read one back
 *   thing link <name> <key>            add a link to another space
 *   thing unlink <name>                remove one
 *   thing links                        every link this peer holds
 *   thing key                          this peer's space key, for sharing
 * ```
 *
 * **Administration is the CLI's alone** (`docs/MAIN-SPACE.md`). Space authority
 * — who may write — cannot answer operator questions like *may you shut this
 * down*, and the two do not coincide: a hub's curators should not be able to
 * restart it, and its operator may hold no writing key at all. The filesystem
 * permissions guarding this directory are the authorisation model, which is why
 * a web client is a space editor and never an admin console.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  contentHash,
  entry,
  type FileEntry,
  hex,
  isLink,
  isTextual,
  links,
  list,
  makeFile,
  makeLink,
  read,
  ROOT,
  type Space,
  type Uuid,
} from '@thing/engine';

import { createSpace, Server } from './server.js';

const UTF8 = new TextEncoder();

/**
 * Where this peer's space lives.
 *
 * `$THING_DIR`, else the XDG data directory, else a dotfile. The engine takes a
 * path and never chooses one; choosing is the CLI's job, because the CLI is
 * what has a user and a home directory.
 */
function dataDir(): string {
  const explicit = process.env['THING_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg !== '') return join(xdg, 'thing');
  return join(homedir(), '.local', 'share', 'thing');
}

const SPACE_FILE = 'space';

/** Which space this peer serves. One id, and it cannot live in a space (§the model). */
async function mainSpace(dir: string): Promise<Uint8Array | null> {
  try {
    const raw = (await readFile(join(dir, SPACE_FILE), 'utf8')).trim();
    return raw.length === 64 ? fromHex(raw) : null;
  } catch {
    return null;
  }
}

async function setMainSpace(dir: string, key: Uint8Array): Promise<void> {
  await writeFile(join(dir, SPACE_FILE), `${hex(key)}\n`);
}

/** Open this peer's space, or explain why not. */
async function openMain(dir: string): Promise<{ server: Server; space: Space } | null> {
  const key = await mainSpace(dir);
  if (key === null) {
    process.stderr.write('no space here yet — run `thing init`\n');
    return null;
  }
  const server = new Server({ dir, space: key });
  await server.start();
  const space = server.space;
  if (space === null) {
    await server.close();
    return null;
  }
  return { server, space };
}

/**
 * Find an object by a path of names, from the root.
 *
 * `notes/today.md` walks two steps. A path that crosses a **link** stops there
 * and says so: following one means opening a different space, which a one-shot
 * command does by being pointed at that space instead.
 */
function walk(space: Space, path: string): FileEntry | { crossed: FileEntry } | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  let parent: Uuid = ROOT;
  let found: FileEntry | null = null;

  for (const part of parts) {
    const here = list(space.state, parent).find((e) => e.name === part);
    if (here === undefined) return null;
    if (isLink(here)) return { crossed: here };
    found = here;
    parent = here.id;
  }
  return found;
}

function describe(e: FileEntry): string {
  if (isLink(e)) return `→ ${e.name}`;
  if (e.isFolder) return `${e.name}/`;
  return `  ${e.name}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const positional: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = '';
    } else positional.push(a);
  }

  const dir = dataDir();

  switch (positional[0]) {
    case 'init': {
      if ((await mainSpace(dir)) !== null) {
        process.stderr.write('this peer already serves a space; `thing key` shows which\n');
        return 1;
      }
      const key = await createSpace(dir);
      await setMainSpace(dir, key.publicKey);

      const name = flags['name'];
      if (name !== undefined && name !== '') {
        const opened = await openMain(dir);
        if (opened !== null) {
          // The suggested name goes on the root, written by the space key (§3.5).
          await opened.space.write(ROOT, ':name', UTF8.encode(name));
          await opened.server.close();
        }
      }
      process.stdout.write(`${hex(key.publicKey)}\n`);
      return 0;
    }

    case 'key': {
      const key = await mainSpace(dir);
      if (key === null) {
        process.stderr.write('no space here yet — run `thing init`\n');
        return 1;
      }
      process.stdout.write(`${hex(key)}\n`);
      return 0;
    }

    case 'ls': {
      const opened = await openMain(dir);
      if (opened === null) return 1;
      try {
        let parent: Uuid = ROOT;
        const path = positional[1];
        if (path !== undefined) {
          const at = walk(opened.space, path);
          if (at === null) {
            process.stderr.write(`no such path: ${path}\n`);
            return 1;
          }
          if ('crossed' in at) {
            process.stderr.write(`${path} is a link to another space; open that space instead\n`);
            return 1;
          }
          parent = at.id;
        }
        for (const e of list(opened.space.state, parent)) {
          process.stdout.write(`${describe(e)}\n`);
        }
        return 0;
      } finally {
        await opened.server.close();
      }
    }

    case 'links': {
      const opened = await openMain(dir);
      if (opened === null) return 1;
      try {
        for (const { entry: e, target } of links(opened.space.state)) {
          process.stdout.write(`${e.name}\t${hex(target)}\n`);
        }
        return 0;
      } finally {
        await opened.server.close();
      }
    }

    case 'link': {
      const name = positional[1];
      const key = positional[2];
      if (name === undefined || key === undefined) {
        process.stderr.write('usage: thing link <name> <key>\n');
        return 2;
      }
      const opened = await openMain(dir);
      if (opened === null) return 1;
      try {
        if (!opened.space.writable) {
          process.stderr.write('this peer cannot write to its space\n');
          return 1;
        }
        await makeLink(opened.space, name, fromHex(key));
        process.stdout.write(`linked ${name}\n`);
        return 0;
      } finally {
        await opened.server.close();
      }
    }

    case 'unlink': {
      const name = positional[1];
      if (name === undefined) {
        process.stderr.write('usage: thing unlink <name>\n');
        return 2;
      }
      const opened = await openMain(dir);
      if (opened === null) return 1;
      try {
        const found = links(opened.space.state).find((l) => l.entry.name === name);
        if (found === undefined) {
          process.stderr.write(`no link called ${name}\n`);
          return 1;
        }
        // §7.2.3's shape: removal stops it being listed, and does not unwrite
        // the fact that it was there.
        await opened.space.write(found.entry.id, ':deleted', Uint8Array.of(1));
        process.stdout.write(`unlinked ${name}\n`);
        return 0;
      } finally {
        await opened.server.close();
      }
    }

    case 'put': {
      const path = positional[1];
      if (path === undefined) {
        process.stderr.write('usage: thing put <file> [--as name]\n');
        return 2;
      }
      const opened = await openMain(dir);
      if (opened === null) return 1;
      try {
        if (!opened.space.writable) {
          process.stderr.write('this peer cannot write to its space\n');
          return 1;
        }
        const bytes = new Uint8Array(await readFile(path));
        const name = flags['as'] ?? basename(path);
        await makeFile(opened.space, name, bytes);
        process.stdout.write(`wrote ${name} (${bytes.length} bytes)\n`);
        return 0;
      } finally {
        await opened.server.close();
      }
    }

    case 'get': {
      const name = positional[1];
      if (name === undefined) {
        process.stderr.write('usage: thing get <name> [--out file]\n');
        return 2;
      }
      const opened = await openMain(dir);
      if (opened === null) return 1;
      try {
        const at = walk(opened.space, name);
        if (at === null || 'crossed' in at) {
          process.stderr.write(`no such file: ${name}\n`);
          return 1;
        }
        const bytes = await read(opened.space, at.id);
        if (bytes === null) {
          const hash = contentHash(opened.space.state, at.id);
          process.stderr.write(
            hash === null
              ? `${name} has no content\n`
              : `${name} is known but its bytes are not held here\n`,
          );
          return 1;
        }
        const out = flags['out'];
        if (out !== undefined && out !== '') await writeFile(out, bytes);
        else process.stdout.write(isTextual(entry(opened.space.state, at.id)?.kind ?? null)
          ? new TextDecoder().decode(bytes)
          : `${bytes.length} bytes; use --out to save\n`);
        return 0;
      } finally {
        await opened.server.close();
      }
    }

    case 'serve': {
      const key = await mainSpace(dir);
      if (key === null) {
        process.stderr.write('no space here yet — run `thing init`\n');
        return 1;
      }
      const port = Number.parseInt(flags['port'] ?? '9944', 10);
      const quiet = flags['quiet'] !== undefined;
      const server = new Server({
        dir,
        space: key,
        listen: { port },
        observer: quiet ? {} : activityLog(),
      });
      await server.start();
      process.stdout.write(`serving ${hex(key).slice(0, 8)} on :${server.port}\n`);
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => resolve());
        process.on('SIGTERM', () => resolve());
      });
      await server.close();
      return 0;
    }

    default:
      process.stdout.write(USAGE);
      return positional[0] === undefined ? 0 : 2;
  }
}

/**
 * Connections and events, printed.
 *
 * A long-running peer that says nothing is one you cannot tell is working. Not
 * protocol — an operator's view, and the only one there is, since a remote
 * client is deliberately not an admin console.
 */
function activityLog(): { onConnect?: (space: string | null, peer: string) => void } & Record<string, unknown> {
  const at = (): string => new Date().toISOString().slice(11, 19);
  const say = (line: string): void => void process.stderr.write(`${at()} ${line}\n`);
  return {
    onConnect: (_space, peer) => say(`${peer} connected`),
    onDisconnect: (_space: string | null, peer: string) => say(`${peer} gone`),
    onEvents: (_space: string, events: readonly unknown[]) => say(`+${events.length} event(s)`),
  };
}

const USAGE = `thing — one space, and links to others

  thing init [--name X]              mint a space and serve it
  thing key                          this peer's space key, for sharing
  thing serve [--port N] [--quiet]   accept connections
  thing ls [path]                    what this space contains
  thing put <file> [--as name]       write a file in
  thing get <name> [--out file]      read one back
  thing link <name> <key>            add a link to another space
  thing unlink <name>                remove one
  thing links                        every link this peer holds

A peer holds one space. Other spaces are links inside it.
Administration is local: this CLI, on this machine.

The space lives in $THING_DIR, or the XDG data directory.
`;

function fromHex(s: string): Uint8Array {
  if (s.length !== 64 || !/^[0-9a-f]+$/i.test(s)) throw new Error(`not a space key: ${s}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
