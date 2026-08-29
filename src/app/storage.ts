/**
 * Persistence for one space (§2, §7.1).
 *
 * Spaces are keyed externally: one localStorage key and one IndexedDB object
 * store per space (§2). Nothing about a space's identity lives inside an event.
 *
 * Events go in localStorage — a mode 1 space is small, and synchronous reads
 * keep the fold trivially re-runnable. Blobs go in IndexedDB, which is the only
 * browser store that takes megabytes without base64 inflation.
 */
import type { Event, Hash, Value } from '../fold/index.js';
import { fromHex, hex } from '../fold/index.js';

const EVENTS_PREFIX = 'thing:events:';
const WRITER_PREFIX = 'thing:writer:';
const SPACES_KEY = 'thing:spaces';

/** How a space was created (§8.3). Fixed at creation; never promoted in v0. */
export type SpaceMode = 'local' | 'writer' | 'reader';

export interface SpaceRecord {
  readonly id: string;
  readonly name: string;
  readonly mode: SpaceMode;
  /**
   * For a joined space, the peer id of the writer to dial (§7.2, §8.6).
   * Absent for local spaces and for the writer's own copy.
   */
  readonly host?: string;
}

/**
 * The share URL for a mode 2 space (§7.2): `space_id` and a `role` hint, plus
 * the writer's peer id so a reader knows whom to dial.
 *
 * A joined space derives its storage keyspace from `space` (§8.6), so reopening
 * the same link finds the existing log and blob cache rather than re-fetching
 * from zero.
 */
export function shareUrl(spaceId: string, name: string, peerId: string): string {
  const u = new URL(window.location.href);
  u.hash = new URLSearchParams({ space: spaceId, name, host: peerId, role: 'reader' }).toString();
  return u.toString();
}

export function parseShareUrl(href: string): SpaceRecord | null {
  const hash = new URL(href).hash.replace(/^#/, '');
  if (hash === '') return null;
  const p = new URLSearchParams(hash);
  const id = p.get('space');
  const host = p.get('host');
  if (id === null || host === null) return null;
  return { id, name: p.get('name') ?? 'shared', mode: 'reader', host };
}

/* ── Event serialisation ──────────────────────────────────────────────────
 * JSON, with byte arrays as hex. Not the canonical encoding (§2.1) — that is
 * for hashing and the wire. This only has to round-trip.
 */

export interface StoredEvent {
  w: string;
  s: number;
  p: string | null;
  l: number;
  t: string;
  a: string;
  v: unknown;
  wall: number;
}

function encodeValue(v: Value): unknown {
  switch (v.t) {
    case 'uuid':
    case 'hash':
      return { t: v.t, v: hex(v.v) };
    case 'null':
      return { t: 'null' };
    case 'pos':
      return { t: 'pos', x: v.v.x, y: v.v.y };
    default:
      return { t: v.t, v: v.v };
  }
}

function decodeValue(raw: unknown): Value {
  const o = raw as { t: string; v?: unknown; x?: number; y?: number };
  switch (o.t) {
    case 'uuid':
      return { t: 'uuid', v: fromHex(o.v as string) };
    case 'hash':
      return { t: 'hash', v: fromHex(o.v as string) };
    case 'null':
      return { t: 'null' };
    case 'pos':
      return { t: 'pos', v: { x: o.x as number, y: o.y as number } };
    case 'string':
      return { t: 'string', v: o.v as string };
    case 'bool':
      return { t: 'bool', v: o.v as boolean };
    case 'kind':
      return { t: 'kind', v: o.v as 'file' | 'dir' };
    default:
      throw new Error(`unknown stored value type: ${o.t}`);
  }
}

export function toStored(e: Event): StoredEvent {
  return {
    w: hex(e.writer),
    s: e.seq,
    p: e.prev === null ? null : hex(e.prev),
    l: e.lamport,
    t: hex(e.target),
    a: e.attr,
    v: encodeValue(e.value),
    wall: e.wall,
  };
}

export function fromStored(s: StoredEvent): Event {
  return {
    writer: fromHex(s.w),
    seq: s.s,
    prev: s.p === null ? null : fromHex(s.p),
    lamport: s.l,
    target: fromHex(s.t),
    attr: s.a as Event['attr'],
    value: decodeValue(s.v),
    wall: s.wall,
  };
}

/* ── Event log ─────────────────────────────────────────────────────────── */

export function loadEvents(spaceId: string): Event[] {
  const raw = localStorage.getItem(EVENTS_PREFIX + spaceId);
  if (raw === null) return [];
  try {
    return (JSON.parse(raw) as StoredEvent[]).map(fromStored);
  } catch {
    // A corrupt log is a bug worth seeing, not one to silently swallow.
    console.error(`space ${spaceId}: event log is unreadable`);
    return [];
  }
}

export function saveEvents(spaceId: string, events: readonly Event[]): void {
  localStorage.setItem(EVENTS_PREFIX + spaceId, JSON.stringify(events.map(toStored)));
}

/* ── Writer identity ───────────────────────────────────────────────────────
 * One WriterId per browser profile per space (§2). A reader never mints one
 * (§8.6), so this is only called for local and writer spaces.
 */

export function loadOrMintWriter(spaceId: string): Uint8Array {
  const key = WRITER_PREFIX + spaceId;
  const existing = localStorage.getItem(key);
  if (existing !== null) return fromHex(existing);
  const id = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(key, hex(id));
  return id;
}

/* ── Space registry ────────────────────────────────────────────────────── */

export function loadSpaces(): SpaceRecord[] {
  const raw = localStorage.getItem(SPACES_KEY);
  if (raw === null) return [];
  try {
    return JSON.parse(raw) as SpaceRecord[];
  } catch {
    console.error('space registry is unreadable');
    return [];
  }
}

export function saveSpaces(spaces: readonly SpaceRecord[]): void {
  localStorage.setItem(SPACES_KEY, JSON.stringify(spaces));
}

/* ── Blobs ─────────────────────────────────────────────────────────────────
 * Content-addressed by SHA-256 of plaintext (§6), and **shared across spaces**
 * (§8.5): one store, keyed by hash, so the same file in two spaces is stored
 * once and a cross-space move costs nothing.
 *
 * This leaks blob existence between spaces. Harmless among trusted peers,
 * unacceptable once §9's encryption arrives (§10.9).
 */

const DB_NAME = 'thing';
const DB_VERSION = 1;
const BLOB_STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(BLOB_STORE, mode);
        const req = fn(t.objectStore(BLOB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export interface StoredBlob {
  readonly bytes: Uint8Array;
  /** The browser's guess at creation time. Advisory, like `:kind` (§4.6). */
  readonly mime: string;
}

export async function putBlob(hash: Hash, bytes: Uint8Array, mime: string): Promise<void> {
  await tx('readwrite', (s) => s.put({ bytes, mime }, hex(hash)));
}

export async function getBlob(hash: Hash): Promise<StoredBlob | null> {
  const got = await tx<StoredBlob | undefined>('readonly', (s) => s.get(hex(hash)));
  return got ?? null;
}

export async function hasBlob(hash: Hash): Promise<boolean> {
  const n = await tx<number>('readonly', (s) => s.count(hex(hash)));
  return n > 0;
}

export async function blobCount(): Promise<number> {
  return tx<number>('readonly', (s) => s.count());
}
