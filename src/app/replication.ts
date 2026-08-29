/**
 * Joins a Space to a Transport (§3.4, §6.1, §7.2).
 *
 * Mode 2: metadata replicates to every peer, blobs are fetched on demand. This
 * is where the two halves meet — the fold on one side, the wire on the other.
 */
import { type Event, hex } from '../fold/index.js';
import { Transport, type BlobStore, type EventLog } from '../net/peer.js';
import type { WireEvent } from '../net/protocol.js';
import { PeerJsSignalling } from '../net/peerjs-signalling.js';
import { getBlob, putBlob, fromStored, toStored, type StoredEvent } from './storage.js';
import type { Space } from './space.js';

/**
 * The shared, content-addressed blob store (§8.5) seen as the transport's
 * store. Blobs arriving from a peer land here and are then visible to every
 * space, which is the same sharing that makes cross-space moves free.
 */
const blobStore: BlobStore = {
  get: async (hash) => (await getBlob(hexToBytes(hash)))?.bytes ?? null,
  put: async (hash, bytes) => {
    // MIME is not carried on the wire: it is a local rendering hint (§4.6 in
    // spirit), and the receiver can sniff or default it.
    await putBlob(hexToBytes(hash), bytes, '');
  },
};

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface ReplicationEvents {
  /** State changed — the UI should re-derive. */
  onChange?: () => void;
  onPeerOpen?: (peerId: string) => void;
  onPeerClose?: (peerId: string) => void;
  onError?: (err: string) => void;
  onStall?: (writer: string, from: number, to: number) => void;
  onBlobProgress?: (hash: string, received: number, total: number) => void;
  onBlobDone?: (hash: string) => void;
  onBlobUnavailable?: (hash: string) => void;
}

export class Replication {
  private transport: Transport;
  /** How many of the space's events have been broadcast. */
  private broadcast = 0;

  constructor(
    private space: Space,
    private events: ReplicationEvents = {},
  ) {
    this.transport = new Transport(new PeerJsSignalling(), blobStore, {
      onOpen: (p) => this.events.onPeerOpen?.(p),
      onClose: (p) => this.events.onPeerClose?.(p),
      onError: (e) => this.events.onError?.(e),
      onStall: (w, f, t) => this.events.onStall?.(w, f, t),
      onEvents: () => this.events.onChange?.(),
      onProgress: (h, r, t) => this.events.onBlobProgress?.(h, r, t),
      onBlob: (h) => {
        this.events.onBlobDone?.(h);
        this.events.onChange?.();
      },
      onNoBlob: (h) => this.events.onBlobUnavailable?.(h),
    });

    const log: EventLog = {
      all: () => this.space.log,
      apply: async (incoming) => {
        await this.space.applyRemote(incoming);
        // Remote events extend the log, so the broadcast watermark moves with
        // them — they must not be echoed back to the peer that sent them.
        this.broadcast = this.space.log.length;
      },
      toWire: (e: Event) => toStored(e) as unknown as WireEvent,
      fromWire: (w: WireEvent) => fromStored(w as unknown as StoredEvent),
    };
    this.transport.attach(space.record.id, log);
  }

  get peerId(): string | null {
    return this.transport.peerId;
  }

  get peers(): string[] {
    return this.transport.connectedPeers;
  }

  async start(): Promise<string> {
    const id = await this.transport.start();
    this.broadcast = this.space.log.length;
    return id;
  }

  connect(peerId: string): Promise<void> {
    return this.transport.connect(peerId);
  }

  /** Push anything written locally since the last call (§3.4). */
  flush(): void {
    const fresh = this.space.since(this.broadcast);
    if (fresh.length === 0) return;
    this.transport.broadcast(fresh);
    this.broadcast = this.space.log.length;
  }

  /** Ask peers for a blob — the fetch the preview pane triggers (§6.1, §8.2). */
  want(hash: Uint8Array): void {
    this.transport.want(hex(hash));
  }

  stop(): void {
    this.transport.close();
  }
}
