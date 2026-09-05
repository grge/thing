/**
 * A peer outside the browser.
 *
 * Holds spaces on disk and syncs them with anyone it is connected to, over
 * connections it accepted or opened. It has no authority a browser tab lacks
 * (ARCHITECTURE.md §5.6) — the same protocol, the same fold, the same
 * verification. What it has is an address, or the ability to dial one.
 *
 * **Two peers that cannot reach each other converge through this one, and there
 * is no relay code.** A peer that syncs with both ends up holding the same log
 * as both, so convergence is what sync already does rather than a feature.
 * Unlike a byte-forwarding relay it also survives disconnection: the events are
 * *here*, so the other side can collect them whenever it next connects.
 */
import { type Divergence, type Event, hex, type KeyPair, type PublicKey, Session, Space, type SpaceId, type SpaceStore } from '@thing/engine';

import { FileStore } from './filestore.js';
import { type Connection, dial, PeerServer } from './transport.js';

export interface PeerOptions {
  /** Where spaces live on disk. */
  readonly dir: string;
  /** Accept connections here. Absent means dial-only — the NAT case. */
  readonly listen?: { readonly port: number; readonly host?: string };
  /**
   * Serve any space a connection asks about, or only spaces already held.
   *
   * `false` is the safe default: a peer that accepts anything offered becomes
   * free storage for strangers. `true` is what a hub run for a known group
   * wants, so it can hold a space nobody has introduced it to yet.
   */
  readonly acceptUnknownSpaces?: boolean;
  readonly onFork?: (space: SpaceId, fork: Divergence) => void;
  readonly onEvents?: (space: SpaceId, events: readonly Event[]) => void;
  /**
   * Connections opening and closing, and what space they are about.
   *
   * A long-running peer that says nothing is one you cannot tell is working, so
   * these exist for an operator rather than for the protocol. `space` is null
   * until a connection says which space it is for.
   */
  readonly onConnect?: (peer: string, space: SpaceId | null) => void;
  readonly onDisconnect?: (peer: string) => void;
  /** A connection refused because this peer will not hold that space. */
  readonly onRefused?: (peer: string, space: SpaceId) => void;
  /** Blob bytes received, so a transfer is visible while it happens. */
  readonly onBlob?: (space: SpaceId, hash: string, bytes: number) => void;
}

interface OpenSpace {
  readonly store: SpaceStore;
  readonly space: Space | null;
  readonly key: PublicKey;
  /** Live connections for this space, so a local write can reach them. */
  readonly sessions: Set<Session>;
}

export class Peer {
  private readonly store: FileStore;
  private readonly spaces = new Map<SpaceId, OpenSpace>();
  private readonly sessions = new Set<Session>();
  private server: PeerServer | null = null;

  constructor(private readonly options: PeerOptions) {
    this.store = new FileStore(options.dir);
  }

  /** Start accepting connections, if this peer has an address. */
  async start(): Promise<void> {
    if (this.options.listen === undefined) return;
    this.server = new PeerServer(this.options.listen);
    this.server.onConnection((conn) => void this.adopt(conn));
    await this.server.ready();
  }

  /** The port actually bound, which matters when 0 was requested. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Hold a space, opening it from disk.
   *
   * `writer` is absent for a peer that only stores and serves — which is the
   * ordinary case for a hub, and the one §6.1 says is possible without ever
   * being able to read.
   */
  async hold(key: PublicKey, writer?: KeyPair): Promise<Space | null> {
    const id = hex(key);
    const existing = this.spaces.get(id);
    if (existing !== undefined) return existing.space;

    const store = await this.store.open(id, key);
    const space = await Space.open(store, writer === undefined ? { key } : { key, writer });
    const held: OpenSpace = { store, space, key, sessions: new Set() };
    this.spaces.set(id, held);

    // A local write has to reach connected peers. Reconciliation only runs when
    // vectors are exchanged, so without this a live connection goes stale the
    // moment either side writes something new.
    // Forwarding what arrives is not an accident: it is how two peers that can
    // only reach a hub converge (§5.6). A peer that suppressed it would sync
    // with each of them and let them stay ignorant of each other.
    space.onChange(() => void this.pushNew(id));

    return space;
  }

  /** Spaces this peer holds. */
  async list(): Promise<readonly SpaceId[]> {
    return this.store.list();
  }

  space(id: SpaceId): Space | null {
    return this.spaces.get(id)?.space ?? null;
  }

  /**
   * Connect to a peer and sync one space with it.
   *
   * How an unreachable peer participates: it cannot be dialled, so it dials.
   * The connection is symmetric once open — the protocol does not care who
   * started it.
   */
  async connect(url: string, key: PublicKey): Promise<Session> {
    await this.hold(key);
    const conn = await dial(url);
    const session = await this.attach(conn, hex(key));
    if (session === null) throw new Error('could not start a session');

    // Frames only reach the session because of this. Attaching builds it; the
    // connection has to be told where to deliver.
    this.options.onConnect?.(conn.peer, hex(key));
    conn.onFrame((data) => void session.receive(data));
    conn.onClose(() => {
      this.options.onDisconnect?.(conn.peer);
      session.close();
      this.sessions.delete(session);
      this.spaces.get(hex(key))?.sessions.delete(session);
    });

    await session.start();
    return session;
  }

  /**
   * Ask every connected peer for a blob.
   *
   * §2.4: events replicate to everyone, blobs are pulled by whoever wants them.
   * Asking all of them costs a message each and means a peer does not have to
   * know which one holds it — the `HAVE` exchange refines this later.
   */
  requestBlob(id: SpaceId, hash: Uint8Array): void {
    const held = this.spaces.get(id);
    if (held === undefined) return;
    for (const session of held.sessions) {
      if (!session.isClosed) session.requestBlob(hash);
    }
  }

  /**
   * Take an incoming connection.
   *
   * Which space it is about is not known until the peer says so, so the
   * connection is held until its HELLO arrives — a peer opening a connection
   * always greets first.
   */
  private async adopt(conn: Connection): Promise<void> {
    let session: Session | null = null;

    this.options.onConnect?.(conn.peer, null);

    conn.onFrame((data) => {
      void (async () => {
        if (session === null) {
          const space = spaceFromHello(data);
          if (space === null) return;
          session = await this.attach(conn, space);
          if (session === null) {
            // A space this peer does not hold and will not accept. Closing is
            // the honest answer: there is nothing to sync.
            this.options.onRefused?.(conn.peer, space);
            conn.close();
            return;
          }
          this.options.onConnect?.(conn.peer, space);
        }
        await session.receive(data);
      })();
    });

    conn.onClose(() => {
      this.options.onDisconnect?.(conn.peer);
      if (session !== null) {
        session.close();
        this.sessions.delete(session);
        for (const held of this.spaces.values()) held.sessions.delete(session);
      }
    });
  }

  /** Wire a connection to a space's store, if this peer holds it. */
  private async attach(conn: Connection, id: SpaceId): Promise<Session | null> {
    let held = this.spaces.get(id);

    if (held === undefined) {
      if (this.options.acceptUnknownSpaces !== true) return null;
      // A space named by its own key, so holding it needs nothing but the key
      // the connection already named.
      const key = keyFromId(id);
      if (key === null) return null;
      await this.hold(key);
      held = this.spaces.get(id);
      if (held === undefined) return null;
    }

    const session = new Session(held.store, conn.channel, {
      peer: conn.peer,
      onFork: (fork) => this.options.onFork?.(id, fork),
      onEvents: (events) => {
        // The session already appended these, so the fold has to be advanced
        // directly — `receive` would refuse them as duplicates and fold
        // nothing.
        //
        // Absorbing fires onChange, which would push straight back to the peer
        // that just sent them. Harmless — the receiver deduplicates — but it is
        // a round trip of pure echo, so the push is suppressed while a session
        // is delivering.
        held.space?.absorb(events);
        this.options.onEvents?.(id, events);
      },
      onBlob: (hash, bytes) => this.options.onBlob?.(id, hexOf(hash), bytes.length),
    });

    this.sessions.add(session);
    held.sessions.add(session);
    return session;
  }

  /**
   * Send anything a peer has not seen.
   *
   * Recomputed from the store rather than tracked, because what a session has
   * sent is exactly what the store holds that the peer's vector does not — and
   * the receiver deduplicates anyway, so an over-send costs a message.
   */
  private async pushNew(id: SpaceId): Promise<void> {
    const held = this.spaces.get(id);
    if (held === undefined || held.sessions.size === 0) return;

    const events: Event[] = [];
    for await (const e of held.store.readAll()) events.push(e);
    for (const session of held.sessions) {
      if (!session.isClosed) session.push(events);
    }
  }

  async close(): Promise<void> {
    for (const session of this.sessions) session.close();
    this.sessions.clear();
    for (const held of this.spaces.values()) await held.space?.close();
    this.spaces.clear();
    await this.store.close();
    if (this.server !== null) await this.server.close();
  }
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Peek at a HELLO to learn which space a connection is about. */
function spaceFromHello(data: Uint8Array): SpaceId | null {
  if (data.length < 2 || data[0] !== 0x01) return null;
  try {
    const msg = JSON.parse(new TextDecoder().decode(data.subarray(1)));
    if (msg?.type !== 'HELLO' || typeof msg.space !== 'string') return null;
    return msg.space;
  } catch {
    return null;
  }
}

/** A space id is its public key in hex, so the key is recoverable from it. */
function keyFromId(id: SpaceId): PublicKey | null {
  if (id.length !== 64 || !/^[0-9a-f]+$/.test(id)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return out;
}
