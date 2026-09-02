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
import type { Event, Hash, KeyPair, Value } from '../fold/index.js';
import { fromHex, generateKeyPair, hex } from '../fold/index.js';

const EVENTS_PREFIX = 'thing:events:';
const WRITER_PREFIX = 'thing:writer:';
const SPACES_KEY = 'thing:spaces';

/** How a space was created (§8.3). Fixed at creation; never promoted in v0. */
export type SpaceMode = 'local' | 'writer' | 'reader';

export interface SpaceRecord {
  /**
   * The space's identity.
   *
   * For a `writer` or `reader` space this is an Ed25519 public key as hex — the
   * same 32 bytes that appear in every event's `writer` field (DESIGN.md §4.1).
   * A `local` space never leaves the device and never needs a verifiable
   * identity, so it keeps a UUID and does not burn a keypair.
   *
   * Storage keyspaces are derived from this, so reopening a link finds the
   * existing log rather than starting from zero.
   */
  readonly id: string;
  /**
   * The **petname**: what this user calls this space locally. Wins over the
   * name the space suggests, and is never an address (ADDRESSING.md §5.6).
   */
  readonly name: string;
  readonly mode: SpaceMode;
  /**
   * For a joined space, where to look right now — a locator, not an identity
   * (DESIGN.md §4.2). Derived from the id by default and re-derivable, so it is
   * cached rather than authoritative. Absent for local spaces.
   */
  readonly host?: string;
  /**
   * The handle the user actually typed, when they joined by code rather than by
   * link. Kept so the trust-on-first-use pin can be checked against the same
   * handle later (`pins.ts`). Absent when joined by link, where the key was
   * known up front and there is nothing to pin against.
   */
  readonly handle?: string;
}

/* ── Addressing ───────────────────────────────────────────────────────────
 * Space identity, the short code, locators and the share link all live in
 * address.ts now. v0 kept them here because they were the same string; they are
 * three separate layers under DESIGN.md §4 and no longer belong beside storage.
 */

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
  /** Ed25519 signature, hex (DESIGN.md §5). */
  sig: string;
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
    sig: hex(e.sig),
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
    sig: fromHex(s.sig),
  };
}

/* ── Event log ─────────────────────────────────────────────────────────── */

export function loadEvents(spaceId: string): Event[] {
  const raw = localStorage.getItem(EVENTS_PREFIX + spaceId);
  if (raw === null) return [];
  try {
    const stored = JSON.parse(raw) as StoredEvent[];
    // A v0 log has no `sig` on its events. Nothing migrates (V1.md) — the log
    // is simply not readable here — but say so precisely, because "unreadable"
    // would otherwise point at corruption rather than at a format that was
    // deliberately left behind.
    if (stored.length > 0 && stored[0]!.sig === undefined) {
      console.warn(`space ${spaceId}: pre-signing (v0) log ignored; it does not migrate`);
      return [];
    }
    return stored.map(fromStored);
  } catch {
    // A corrupt log is a bug worth seeing, not one to silently swallow.
    console.error(`space ${spaceId}: event log is unreadable`);
    return [];
  }
}

export function saveEvents(spaceId: string, events: readonly Event[]): void {
  localStorage.setItem(EVENTS_PREFIX + spaceId, JSON.stringify(events.map(toStored)));
}

/* ── Space keys ───────────────────────────────────────────────────────────
 * A space is a keypair, and the public key is both the space id and the
 * WriterId (DESIGN.md §4.1). A reader holds no private key at all — that is
 * what makes it a reader, rather than a convention about which gestures the UI
 * enables.
 *
 * Stored as a raw seed: keys are extractable on purpose (ADDRESSING.md §6),
 * because the user must be able to move an identity between devices. Key loss
 * is the largest risk in this design (DESIGN.md §5.4), and a key that cannot
 * leave the browser cannot be backed up.
 */

interface StoredKey {
  readonly pk: string;
  readonly sk: string;
}

function keyRecord(kp: KeyPair): string {
  return JSON.stringify({ pk: hex(kp.publicKey), sk: hex(kp.privateKey) } satisfies StoredKey);
}

/**
 * Mint a new space identity and store it under its own public key.
 *
 * Keyed by the key rather than by a separate space id, because for a writer
 * space they are the same string — the caller uses the returned public key *as*
 * the space id.
 */
export async function mintSpaceKey(): Promise<KeyPair> {
  const kp = await generateKeyPair();
  localStorage.setItem(WRITER_PREFIX + hex(kp.publicKey), keyRecord(kp));
  return kp;
}

/** The keypair for a space, or null if this device does not hold one. */
export function loadSpaceKey(spaceId: string): KeyPair | null {
  const raw = localStorage.getItem(WRITER_PREFIX + spaceId);
  if (raw === null) return null;
  try {
    const stored = JSON.parse(raw) as StoredKey;
    return { publicKey: fromHex(stored.pk), privateKey: fromHex(stored.sk) };
  } catch {
    console.error(`space ${spaceId}: key is unreadable`);
    return null;
  }
}

/**
 * The keypair for a space, minting one if absent.
 *
 * Only meaningful for a `local` space, whose id is a UUID and whose key is
 * therefore incidental — it signs, but nothing verifies against the id. A
 * writer space's key must already exist, because its id *is* that key; a reader
 * space must never have one.
 */
export async function loadOrMintLocalKey(spaceId: string): Promise<KeyPair> {
  const existing = loadSpaceKey(spaceId);
  if (existing !== null) return existing;
  const kp = await generateKeyPair();
  localStorage.setItem(WRITER_PREFIX + spaceId, keyRecord(kp));
  return kp;
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

/**
 * Forget a space entirely: its log, its writer identity, its registry entry.
 *
 * Blobs are **not** removed. The store is shared across spaces and addressed by
 * content (§8.5), so a blob here may be referenced by another space; deleting
 * by space would corrupt those. `purgeUnreferencedBlobs` handles reclaiming.
 */
export function forgetSpace(spaceId: string): void {
  localStorage.removeItem(EVENTS_PREFIX + spaceId);
  localStorage.removeItem(WRITER_PREFIX + spaceId);
  saveSpaces(loadSpaces().filter((s) => s.id !== spaceId));
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
}

/**
 * Blobs store bytes and nothing else.
 *
 * A MIME field used to live here, learned from the browser's `File` at upload —
 * but it was never replicated, so a peer receiving the blob stored nothing and
 * disagreed with the writer about what the file was (FINDINGS F10). Format is
 * an attribute of the *object* now (§4.7), which also lets two objects share one
 * blob and render differently.
 */
export async function putBlob(hash: Hash, bytes: Uint8Array): Promise<void> {
  await tx('readwrite', (s) => s.put({ bytes }, hex(hash)));
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

export async function blobHashes(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
  return keys.map(String);
}

export async function deleteBlob(hashHex: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(hashHex));
}

/**
 * Drop blobs no remaining space references.
 *
 * Called after forgetting a space: the shared store means a deleted space's
 * blobs are only garbage once *nothing* points at them. Returns how many went,
 * so the UI can say what it reclaimed.
 */
export async function purgeUnreferencedBlobs(referenced: ReadonlySet<string>): Promise<number> {
  const held = await blobHashes();
  let removed = 0;
  for (const h of held) {
    if (!referenced.has(h)) {
      await deleteBlob(h);
      removed += 1;
    }
  }
  return removed;
}
