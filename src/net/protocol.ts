/**
 * Wire messages (§3.4, §6).
 *
 * Defined independently of PeerJS so the transport can be swapped and so this
 * file reads as the protocol rather than as a binding to one library.
 *
 * Events and blobs travel by different paths: metadata is replicated to every
 * peer, blobs are fetched on demand (§6.1).
 */

export const PROTOCOL_VERSION = 1;

/**
 * Chunk size for blob transfer (§6).
 *
 * 16 KiB, as the spec says, sized against the SCTP message limit — which is the
 * limit that actually applies now that blob chunks go to the data channel as
 * raw bytes rather than through a library's messaging layer.
 *
 * Recorded in §10.4 as untuned: chosen, not measured.
 */
export const CHUNK_SIZE = 16 * 1024;

/** A peer's knowledge: writer -> highest *contiguous* seq held (§3.1). */
export type VersionVector = Record<string, number>;

/** An event on the wire. Byte arrays are hex; see storage.ts for the rationale. */
export interface WireEvent {
  readonly w: string;
  readonly s: number;
  readonly p: string | null;
  readonly l: number;
  readonly t: string;
  readonly a: string;
  readonly v: unknown;
  readonly wall: number;
}

export interface Hello {
  readonly type: 'HELLO';
  readonly space: string;
  readonly protocol: number;
  readonly vv: VersionVector;
}

export interface Events {
  readonly type: 'EVENTS';
  readonly events: readonly WireEvent[];
}

/** Request a specific range of one writer's chain, used on gap detection (§3.3). */
export interface Gap {
  readonly type: 'GAP';
  readonly writer: string;
  readonly from: number;
  readonly to: number;
}

export interface Want {
  readonly type: 'WANT';
  readonly hash: string;
  /** Resume point: the first chunk index the requester still needs (§6). */
  readonly fromChunk: number;
}

/**
 * The peer does not hold this blob (§6).
 *
 * Without this, a WANT for a blob the peer never received is indistinguishable
 * from a slow transfer, and the UI spins forever instead of saying so (§8.2).
 */
export interface NoBlob {
  readonly type: 'NOBLOB';
  readonly hash: string;
}

export type Message = Hello | Events | Gap | Want | NoBlob;

/**
 * Framing (§6).
 *
 * Two kinds of thing travel on one data channel, and one byte tells them apart:
 *
 *   CONTROL  0x01  UTF-8 JSON — HELLO, EVENTS, GAP, WANT, NOBLOB
 *   CHUNK    0x02  [tag][32-byte hash][u32 index][u32 chunks][u32 total][bytes]
 *
 * Blob payloads are raw. They were previously base64 inside JSON, which cost
 * 34% and capped a chunk at ~11 KiB against a library limit; sending bytes as
 * bytes removes both. See FINDINGS.md.
 *
 * The chunk header repeats `chunks` and `total` on every frame so a receiver
 * can size its buffer and show progress from the first frame that arrives,
 * whichever one that is.
 */
export const TAG_CONTROL = 0x01;
export const TAG_CHUNK = 0x02;

/** 1 tag + 32 hash + 4 index + 4 chunks + 4 total. */
export const CHUNK_HEADER_BYTES = 45;

const HASH_BYTES = 32;

export function encodeControl(msg: Message): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(1 + json.length);
  out[0] = TAG_CONTROL;
  out.set(json, 1);
  return out.buffer;
}

export interface ChunkFrame {
  readonly hash: string;
  readonly index: number;
  readonly chunks: number;
  readonly total: number;
  readonly bytes: Uint8Array;
}

export function encodeChunkFrame(
  hashHex: string,
  index: number,
  chunks: number,
  total: number,
  payload: Uint8Array,
): ArrayBuffer {
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
  return out.buffer;
}

export type Frame =
  | { readonly kind: 'control'; readonly msg: Message }
  | { readonly kind: 'chunk'; readonly chunk: ChunkFrame };

/** Decode a frame, or null if it is malformed — never throw at a peer's data. */
export function decodeFrame(data: ArrayBuffer | string): Frame | null {
  // A string can only be a control message; some transports deliver text.
  if (typeof data === 'string') {
    try {
      return { kind: 'control', msg: JSON.parse(data) as Message };
    } catch {
      return null;
    }
  }

  const bytes = new Uint8Array(data);
  if (bytes.length === 0) return null;

  if (bytes[0] === TAG_CONTROL) {
    try {
      const json = new TextDecoder().decode(bytes.subarray(1));
      return { kind: 'control', msg: JSON.parse(json) as Message };
    } catch {
      return null;
    }
  }

  if (bytes[0] === TAG_CHUNK) {
    if (bytes.length < CHUNK_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let hash = '';
    for (let i = 0; i < HASH_BYTES; i++) hash += bytes[1 + i]!.toString(16).padStart(2, '0');
    return {
      kind: 'chunk',
      chunk: {
        hash,
        index: view.getUint32(33, false),
        chunks: view.getUint32(37, false),
        total: view.getUint32(41, false),
        bytes: bytes.subarray(CHUNK_HEADER_BYTES),
      },
    };
  }

  return null;
}

export function chunkCount(total: number): number {
  return Math.max(1, Math.ceil(total / CHUNK_SIZE));
}
