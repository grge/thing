/**
 * The wire protocol (ARCHITECTURE.md §2.3, §2.4, §10).
 *
 * Defined independently of any transport, so the same protocol runs over WebRTC
 * in a browser and WebSockets in Node — which is what makes a headless peer the
 * same kind of participant rather than a different one (§5.6).
 *
 * **Three channels share one connection**, distinguished by a tag byte:
 *
 *   0x01 CONTROL    JSON — sync, blob requests
 *   0x02 CHUNK      raw blob bytes, framed
 *   0x03 EPHEMERAL  JSON — availability, presence, resolution (§10)
 *
 * The split matters because the three have different durability: control
 * messages drive what enters the log, chunks carry content, and ephemeral
 * messages expire and are never stored. Keeping them apart on the wire means a
 * receiver cannot accidentally persist something that was only ever about the
 * present moment.
 */

/**
 * Bumped whenever the wire format changes incompatibly.
 *
 * Peers on different versions share no readable messages, so the handshake
 * rejects the mismatch — which is all this field is for. Nothing migrates.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Chunk size for blob transfer.
 *
 * 16 KiB, against the SCTP message limit that applies to a WebRTC data channel.
 * Chosen rather than measured; the previous implementation of this system
 * recorded it as untuned and that is still true.
 */
export const CHUNK_SIZE = 16 * 1024;

/* ── version vectors on the wire ────────────────────────────────────────── */

/**
 * What a peer knows of one writer's chain (§2.3).
 *
 * `tip` is hex. It is what makes a fork *detectable*: two peers can agree on a
 * frontier while holding different histories, and comparing numbers alone would
 * miss that entirely.
 */
export interface WireFrontier {
  readonly frontier: number;
  readonly tip: string;
}

/**
 * chain -> frontier, where a chain is `writer/point` in hex.
 *
 * Keyed by chain rather than by writer because one identity may write from
 * several processes at once, each extending its own chain (§2.1's `Point`).
 */
export type WireVersionVector = Record<string, WireFrontier>;

/* ── control messages ───────────────────────────────────────────────────── */

/**
 * Opens a connection: which space, which protocol, and what I hold.
 *
 * The space is named so a receiver knows which store to check against, and
 * because the space key is in every event's signed preimage (§2.1) — an event
 * cannot be verified without knowing which space it claims to be in.
 */
export interface Hello {
  readonly type: 'HELLO';
  readonly space: string;
  readonly protocol: number;
  readonly vv: WireVersionVector;
}

/** Events, in chain order. */
export interface Events {
  readonly type: 'EVENTS';
  readonly events: readonly WireEvent[];
}

/**
 * Ask for a range of one chain.
 *
 * Used to fill a gap: a peer holding 0–47 and 49 asks for 48. `to` is
 * exclusive, and absent means "as far as you have".
 *
 * A chain is `(writer, point)`, so both are named. `chain` carries the pair as
 * one string because that is how the version vector is keyed and how a store
 * looks one up — splitting it here would mean rejoining it everywhere.
 */
export interface Want {
  readonly type: 'WANT';
  readonly chain: string;
  readonly from: number;
  readonly to?: number;
}

/**
 * This chain has forked (§2.3).
 *
 * Sent when two peers report the same frontier under different tips. It is a
 * report, not a repair: fetching the competing branch needs a request this
 * protocol deliberately does not have yet (§9.2). What matters is that the
 * divergence is *said* rather than silently failing to sync — and that it does
 * not stall the rest of the space, since a fork is confined to one chain.
 */
export interface Forked {
  readonly type: 'FORKED';
  /** `writer/point` — see `chainOf`. */
  readonly chain: string;
  readonly frontier: number;
  /** The tip this peer holds at that frontier. */
  readonly mine: string;
  /** The tip the other peer reported. */
  readonly theirs: string;
}

/** Ask for a blob, resuming from a chunk index (§2.4). */
export interface WantBlob {
  readonly type: 'WANT_BLOB';
  readonly hash: string;
  readonly fromChunk: number;
}

/**
 * I do not hold that blob.
 *
 * Without this, a request for a blob the peer never had is indistinguishable
 * from a slow transfer, and a caller waits forever rather than asking elsewhere.
 */
export interface NoBlob {
  readonly type: 'NO_BLOB';
  readonly hash: string;
}

/**
 * Ask whether the peer is as recent as this vector (§2.3.1).
 *
 * `HELLO` carries a vector too, but only once, at open. A writer that connects,
 * writes, and wants to know whether the write landed is asking about a moment
 * strictly after the handshake, which needs a question that can be asked again.
 *
 * `id` pairs the answer with the question, so several may be outstanding and a
 * late reply to an abandoned one is recognisable.
 */
export interface Synced {
  readonly type: 'SYNCED?';
  readonly id: number;
  readonly vv: WireVersionVector;
}

/**
 * The answer: whether that vector is covered, and what is missing if not.
 *
 * `behind` names the chains the peer lacks and `forked` the ones it disagrees
 * with — a fork is not lag and no amount of waiting resolves it, so a caller
 * that polls needs to be able to tell them apart.
 */
export interface SyncedIs {
  readonly type: 'SYNCED';
  readonly id: number;
  readonly covered: boolean;
  readonly behind?: readonly string[];
  readonly forked?: readonly string[];
}

export type ControlMessage =
  | Hello
  | Events
  | Want
  | Forked
  | WantBlob
  | NoBlob
  | Synced
  | SyncedIs;

/* ── ephemeral messages ─────────────────────────────────────────────────── */

/**
 * Blob availability (§2.4).
 *
 * Ephemeral because it describes what a peer holds *now*. A version vector
 * describes events and never blobs, so without this "who has this content" is
 * unanswerable once the original writer is gone.
 */
export interface Have {
  readonly type: 'HAVE';
  readonly hashes: readonly string[];
}

/**
 * Presence: who is here, and whatever they want others to see.
 *
 * The payload is opaque to the protocol — a view decides what presence means
 * for its own application, and nothing here interprets it.
 */
export interface Presence {
  readonly type: 'PRESENCE';
  readonly payload: unknown;
  /** Milliseconds after which a receiver should forget this (§10.1). */
  readonly ttl: number;
}

/**
 * I serve these spaces (§5.3's push half).
 *
 * Sent on connect and when what a peer serves changes, to the peers it is
 * already connected to — so availability is maintained by the same traffic that
 * does the work, with no crawl and no polling. A peer that stops announcing is
 * gone within one TTL, which makes serving a genuine opt-in rather than a
 * commitment that cannot be withdrawn.
 *
 * `at` is how the announcer says it can be reached. Absent means *on this
 * connection* — a peer that dialled you needs no address, and a browser has
 * none to give.
 */
export interface Announce {
  readonly type: 'ANNOUNCE';
  /** Space ids, hex. */
  readonly spaces: readonly string[];
  /** Locators in compact form (`formatLocator`), or absent for "reach me here". */
  readonly at?: readonly string[];
  /** Milliseconds after which a receiver should forget this (§10.1). */
  readonly ttl: number;
}

/**
 * Where is this space? (§5.3's pull half.)
 *
 * Asked of connected peers in parallel; answers merge rather than being taken
 * from the first responder. `id` pairs answers with the question, since several
 * may be outstanding.
 */
export interface Resolve {
  readonly type: 'RESOLVE';
  readonly id: number;
  /** The space id, hex. */
  readonly space: string;
}

/**
 * The answer, which distinguishes three cases (§5.3).
 *
 * They call for different behaviour, so collapsing them into "no locators"
 * would lose the difference between *stop asking this peer* and *ask again
 * later*:
 *
 * - `unknown` — I do not track this space.
 * - `none` — I track it and nobody is serving; `lastSeen` if I ever saw one.
 * - locators — dial these.
 */
export interface Resolved {
  readonly type: 'RESOLVED';
  readonly id: number;
  readonly space: string;
  readonly known: boolean;
  /** Locators in compact form. Empty with `known` true is "nobody serving". */
  readonly at: readonly string[];
  /** When this peer last saw anyone serving it, if it did. */
  readonly lastSeen?: number;
}

export type EphemeralMessage = Have | Presence | Announce | Resolve | Resolved;

/**
 * An event on the wire.
 *
 * Byte arrays are hex, so a control message is ordinary JSON. That costs size
 * against a binary encoding and buys a protocol that can be read in a log
 * during development — a trade worth revisiting once there is traffic to
 * measure, and not before.
 */
export interface WireEvent {
  readonly w: string;
  /** The append point: which of this writer's chains (§2.1). */
  readonly pt: string;
  readonly s: number;
  readonly p: string | null;
  /** Dependencies: what this writer had seen (§2.1's `deps`). */
  readonly d: readonly string[];
  readonly l: number;
  readonly t: string;
  readonly a: string;
  readonly v: string;
  readonly wall: number;
  readonly sig: string;
}

/* ── framing ────────────────────────────────────────────────────────────── */

export const TAG_CONTROL = 0x01;
export const TAG_CHUNK = 0x02;
export const TAG_EPHEMERAL = 0x03;

/** 1 tag + 32 hash + 4 index + 4 chunks + 4 total. */
export const CHUNK_HEADER_BYTES = 45;

const HASH_BYTES = 32;
const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();

function encodeJson(tag: number, msg: unknown): Uint8Array {
  const json = UTF8.encode(JSON.stringify(msg));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

export function encodeControl(msg: ControlMessage): Uint8Array {
  return encodeJson(TAG_CONTROL, msg);
}

export function encodeEphemeral(msg: EphemeralMessage): Uint8Array {
  return encodeJson(TAG_EPHEMERAL, msg);
}

export interface ChunkFrame {
  readonly hash: string;
  readonly index: number;
  readonly chunks: number;
  readonly total: number;
  readonly bytes: Uint8Array;
}

/**
 * A blob chunk.
 *
 * The header repeats `chunks` and `total` on every frame, so a receiver can
 * size its buffer and show progress from whichever frame arrives first — which
 * matters when a transfer resumes mid-stream.
 */
export function encodeChunk(
  hashHex: string,
  index: number,
  chunks: number,
  total: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(CHUNK_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out[0] = TAG_CHUNK;
  for (let i = 0; i < HASH_BYTES; i++) {
    out[1 + i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  view.setUint32(33, index, false);
  view.setUint32(37, chunks, false);
  view.setUint32(41, total, false);
  out.set(payload, CHUNK_HEADER_BYTES);
  return out;
}

export type Frame =
  | { readonly kind: 'control'; readonly msg: ControlMessage }
  | { readonly kind: 'ephemeral'; readonly msg: EphemeralMessage }
  | { readonly kind: 'chunk'; readonly chunk: ChunkFrame };

/**
 * Decode a frame, or null if it is malformed.
 *
 * **Never throws at a peer's data.** A malformed frame is a peer being broken
 * or hostile, and neither should be able to stop this one.
 */
export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length === 0) return null;

  const tag = data[0];
  if (tag === TAG_CONTROL || tag === TAG_EPHEMERAL) {
    try {
      const msg = JSON.parse(FROM_UTF8.decode(data.subarray(1)));
      if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return null;
      return tag === TAG_CONTROL
        ? { kind: 'control', msg: msg as ControlMessage }
        : { kind: 'ephemeral', msg: msg as EphemeralMessage };
    } catch {
      return null;
    }
  }

  if (tag === TAG_CHUNK) {
    if (data.length < CHUNK_HEADER_BYTES) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let hash = '';
    for (let i = 0; i < HASH_BYTES; i++) hash += data[1 + i]!.toString(16).padStart(2, '0');
    return {
      kind: 'chunk',
      chunk: {
        hash,
        index: view.getUint32(33, false),
        chunks: view.getUint32(37, false),
        total: view.getUint32(41, false),
        bytes: data.subarray(CHUNK_HEADER_BYTES),
      },
    };
  }

  return null;
}

export function chunkCount(total: number): number {
  return Math.max(1, Math.ceil(total / CHUNK_SIZE));
}
