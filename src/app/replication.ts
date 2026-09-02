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
import { loadSettings, turnCredentialsUrl } from './settings.js';
import { getBlob, putBlob, fromStored, toStored, type StoredEvent } from './storage.js';
import type { Space } from './space.js';
import { checkOrPin } from './pins.js';

/**
 * The shared, content-addressed blob store (§8.5) seen as the transport's
 * store. Blobs arriving from a peer land here and are then visible to every
 * space, which is the same sharing that makes cross-space moves free.
 */
const blobStore: BlobStore = {
  get: async (hash) => (await getBlob(hexToBytes(hash)))?.bytes ?? null,
  put: async (hash, bytes) => {
    // No MIME here: format is an attribute of the object (§4.7), replicated
    // with the metadata, so nothing about it belongs beside the bytes.
    await putBlob(hexToBytes(hash), bytes);
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
  /**
   * A space joined by typed code turned out to be served by a key other than
   * the one that answered that code before (ADDRESSING.md §5.5). Loud and
   * blocking by contract: the caller must tell the user, not paper over it.
   */
  onIdentityMismatch?: (expected: string, got: string) => void;
}

export class Replication {
  private transport: Transport;
  /** How many of the space's events have been broadcast. */
  private broadcast = 0;

  constructor(
    private space: Space,
    private events: ReplicationEvents = {},
  ) {
    // Read at construction: a settings change takes effect for spaces opened
    // after it, which is when the user would expect it to, and avoids
    // reconfiguring a connection that is already up.
    const credentials = turnCredentialsUrl(loadSettings());

    this.transport = new Transport(new PeerJsSignalling(credentials), blobStore, {
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
        // A space joined by *link* was verified before contact — the key was in
        // the link. A space joined by *code* was not: the code is a rendezvous
        // hint carrying no authority, so the first events to arrive are the
        // first evidence of who is actually answering. Pin that, and refuse a
        // substitution later (ADDRESSING.md §5.5).
        if (!this.checkIdentity(incoming)) return;
        await this.space.applyRemote(incoming);
        // Remote events extend the log, so the broadcast watermark moves with
        // them — they must not be echoed back to the peer that sent them.
        this.broadcast = this.space.log.length;
      },
      toWire: (e: Event) => toStored(e) as unknown as WireEvent,
      fromWire: (w: WireEvent) => fromStored(w as unknown as StoredEvent),
    };
    // A space joined by typed code has no verified identity yet — its record id
    // is the code, which is a locator and would never match the writer's key.
    // Announce nothing rather than announce something that cannot match; the
    // identity arrives with the first signed events and is pinned there.
    this.transport.attach(space.record.handle === undefined ? space.record.id : '', log);
  }

  /**
   * Trust on first use, for a space joined by typed code.
   *
   * Every event is already signature-verified at the wire boundary (DESIGN.md
   * §5), so `writer` here is a key someone demonstrably holds — the question is
   * only whether it is the *same* key as last time. Returns false to reject the
   * batch outright: accepting events from an unexpected identity is exactly the
   * substitution the pin exists to prevent.
   */
  private checkIdentity(incoming: readonly Event[]): boolean {
    const handle = this.space.record.handle;
    if (handle === undefined || incoming.length === 0) return true;
    const presented = hex(incoming[0]!.writer);
    const result = checkOrPin(handle, presented);
    if (!result.ok) {
      this.events.onIdentityMismatch?.(result.expected, result.got);
      return false;
    }
    return true;
  }

  get peerId(): string | null {
    return this.transport.peerId;
  }

  get peers(): string[] {
    return this.transport.connectedPeers;
  }

  /**
   * Register with signalling. A writer claims the peer id its share code
   * names, so a reader can dial it knowing only the code; a reader takes
   * whatever id it is given, since nobody dials it (§3.4 star topology).
   */
  async start(preferredId?: string): Promise<string> {
    const id = await this.transport.start(preferredId);
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
