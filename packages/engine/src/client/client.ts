/**
 * Being a peer: holding spaces, syncing them, tracking what is connected.
 *
 * **This is the program.** Everything above the store and below the screen.
 * It was written twice — once for a browser tab, once for a headless server —
 * and the two arrived at the same structure, down to the same comments on the
 * same non-obvious decisions, because there is only one thing here to do.
 *
 * What differs between the two is reachability, and reachability is a
 * *capability*, not a class (ARCHITECTURE.md §5.6). A browser cannot be
 * dialled, so it dials or is introduced; a server with an address can also
 * accept. Accepting therefore lives outside this class: whoever can listen
 * calls `adopt` with each connection it takes. Nothing here knows the
 * difference between a connection it opened and one that arrived.
 *
 * **Two peers that cannot reach each other converge through a third, and there
 * is no relay code.** A peer that syncs with both ends up holding the same log
 * as both, so convergence is what sync already does. Unlike byte-forwarding it
 * survives disconnection: the events are *here*, to be collected whenever the
 * other side next connects.
 */
import { type Event, hex, type KeyPair, type PublicKey } from '../core/index.js';
import { Session } from '../net/session.js';
import type { Divergence } from '../net/sync.js';
import type { SpaceId, SpaceStore } from '../store/index.js';
import { Space } from '../space.js';
import {
  type Activity,
  type ClientCapabilities,
  type ClientObserver,
  type Connection,
  keyFromId,
  NO_LOCK,
  type PeerKind,
  type WriteLock,
} from './types.js';

/** One connected peer, as an operator sees it. */
export interface PeerStatus {
  readonly id: string;
  readonly kind: PeerKind;
  readonly space: SpaceId;
  readonly since: number;
  readonly state: 'connecting' | 'open' | 'failed';
  readonly detail?: string;
}

/** A space this client holds. */
export interface Held {
  readonly key: PublicKey;
  /** Whether this peer holds a writing key at all, lock aside. */
  readonly hasKey: boolean;
  readonly store: SpaceStore;
  readonly space: Space;
  readonly sessions: Map<string, Session>;
  readonly connections: Map<
    string,
    { close(): void; kind: PeerKind; since: number; state: 'connecting' | 'open' | 'failed'; detail?: string }
  >;
  readonly lock: WriteLock;
  forks: Divergence[];
}

const ACTIVITY_LIMIT = 200;

export class Client {
  protected readonly held = new Map<SpaceId, Held>();
  private readonly activityLog: Activity[] = [];
  private readonly observers = new Set<ClientObserver>();
  protected closed = false;

  constructor(
    protected readonly capabilities: ClientCapabilities,
    observer: ClientObserver = {},
  ) {
    this.observers.add(observer);
  }

  /** Watch this client. Returns an unsubscribe. */
  observe(observer: ClientObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  protected changed(): void {
    for (const o of this.observers) o.onChange?.();
  }

  /** Note something an operator might want to see. */
  protected note(channel: Activity['channel'], space: SpaceId | null, text: string): void {
    const entry: Activity = { at: Date.now(), channel, space, text };
    this.activityLog.unshift(entry);
    // Bounded: a debugging aid, not a log. The log is the log.
    if (this.activityLog.length > ACTIVITY_LIMIT) this.activityLog.length = ACTIVITY_LIMIT;
    for (const o of this.observers) o.onActivity?.(entry);
    this.changed();
  }

  /** Recent activity across all three channels, newest first. */
  recent(): readonly Activity[] {
    return this.activityLog;
  }

  /* ── spaces ───────────────────────────────────────────────────────────── */

  /** Spaces this client currently holds. */
  holding(): readonly SpaceId[] {
    return [...this.held.keys()];
  }

  /** Every space in storage, held or not. */
  async list(): Promise<readonly SpaceId[]> {
    return this.capabilities.store.list();
  }

  space(id: SpaceId): Space | null {
    return this.held.get(id)?.space ?? null;
  }

  entry(id: SpaceId): Held | undefined {
    return this.held.get(id);
  }

  /**
   * Hold a space, opening it from storage.
   *
   * `writer` is absent for a peer that only stores and serves — the ordinary
   * case for a hub, and the one §6.1 says is possible without ever being able
   * to read. Absent it, the writing key is asked of `keys`, if there is one.
   */
  async hold(key: PublicKey, writer?: KeyPair): Promise<Space> {
    const id = hex(key);
    const existing = this.held.get(id);
    if (existing !== undefined) return existing.space;

    const store = await this.capabilities.store.open(id, key);
    const own = writer ?? (await this.capabilities.keys?.keyFor(id)) ?? null;

    // §7.3: two writers sharing one key fork that writer's chain, and both
    // branches verify. Where they can agree cheaply they should; a second
    // holder opens read-only rather than writing a branch that would later
    // lose. A replica needs no lock, so none is taken.
    //
    // **No lock capability means unlocked, not locked.** A runtime that cannot
    // exclude a second writer still writes — otherwise supplying no mechanism
    // would silently downgrade every space to read-only, which is a worse
    // failure than the fork the lock exists to prevent.
    const lock = own === null || this.capabilities.lock === undefined
      ? NO_LOCK
      : await this.capabilities.lock(id);
    const writable = own !== null && (this.capabilities.lock === undefined || lock.held);
    const space = await Space.open(store, writable ? { key, writer: own } : { key });

    const entry: Held = {
      key,
      hasKey: own !== null,
      store,
      space,
      sessions: new Map(),
      connections: new Map(),
      lock,
      forks: [],
    };
    this.held.set(id, entry);

    // A local write has to reach connected peers. Reconciliation only runs when
    // vectors are exchanged, so without this a live connection goes stale the
    // moment either side writes something new.
    //
    // Forwarding what arrives is not an accident: it is how two peers that can
    // only reach a hub converge (§5.6). A peer that suppressed it would sync
    // with each of them and let them stay ignorant of each other.
    space.onChange(() => {
      void this.pushNew(id);
      this.changed();
    });

    this.changed();
    return space;
  }

  /** Stop holding a space, without destroying it. */
  async release(id: SpaceId): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined) return;
    for (const conn of entry.connections.values()) conn.close();
    for (const session of entry.sessions.values()) session.close();
    await entry.space.close();
    await entry.lock.release();
    this.held.delete(id);
    this.changed();
  }

  /** Forget a space entirely: its log and its blobs. */
  async forget(id: SpaceId): Promise<void> {
    await this.release(id);
    await this.capabilities.store.destroy(id);
    this.changed();
  }

  /* ── connections ──────────────────────────────────────────────────────── */

  /**
   * Sync a space over a connection that is already open.
   *
   * Symmetric: the protocol does not care who dialled. Whoever opened the
   * connection — a WebSocket, a data channel, a Unix socket — hands it here.
   */
  async join(id: SpaceId, conn: Connection, kind: PeerKind = 'direct'): Promise<Session> {
    const session = await this.attach(conn, id, kind);
    if (session === null) throw new Error('not holding that space');
    // Delivery is wired here rather than in `attach`, because the two ways in
    // differ in exactly this: an adopted connection has to read its own frames
    // to learn which space it is about, and would otherwise deliver each one
    // twice.
    conn.onFrame((data) => void session.receive(data));
    conn.onClose(() => this.dropped(conn.peer));
    await session.start();
    this.changed();
    return session;
  }

  /**
   * Take a connection that arrived, whichever space it turns out to be about.
   *
   * Which space is not known until the peer says so, so the connection is held
   * until its HELLO arrives — a peer opening a connection always greets first.
   * This is the only asymmetry between dialling and being dialled, and it is
   * about *knowing*, not about authority.
   */
  adopt(conn: Connection): void {
    // The *promise* is the guard, not the session. `attach` is asynchronous —
    // it may open a store — so several frames can arrive before the first one
    // finishes, and a `session === null` check would let each of them start
    // another. Three sessions on one connection is three of everything:
    // three copies of every event delivered, three vectors exchanged.
    let starting: Promise<Session | null> | null = null;

    for (const o of this.observers) o.onConnect?.(null, conn.peer);

    conn.onFrame((data) => {
      void (async () => {
        if (starting === null) {
          const id = spaceFromHello(data);
          // Not a greeting, and nothing has claimed this connection yet.
          if (id === null) return;
          starting = this.attach(conn, id, 'direct');
          const opened = await starting;
          if (opened === null) {
            // A space this peer does not hold and will not accept. Closing is
            // the honest answer: there is nothing to sync.
            this.note('connection', id, `refused ${conn.peer}: not holding that space`);
            for (const o of this.observers) o.onRefused?.(id, conn.peer);
            conn.close();
            return;
          }
          for (const o of this.observers) o.onConnect?.(id, conn.peer);
          this.changed();
        }

        // Frames that arrived while the session was opening wait for it here,
        // in the order they arrived, rather than being dropped or duplicated.
        const session = await starting;
        if (session === null) return;
        await session.receive(data);
      })();
    });

    conn.onClose(() => this.dropped(conn.peer));
  }

  /**
   * Wire a connection to a space's store, if this client holds it.
   *
   * Builds the session and records the connection; **it does not wire frame
   * delivery or close**, because the caller already knows which of those it
   * owns — `adopt` reads frames itself to find the space, `join` does not.
   *
   * `onProgress` fires when the peer actually delivers events — which is the
   * only proof a connection is useful. A socket that opens and is then refused
   * has proved nothing, so a caller backing off must not count it as success.
   */
  protected async attach(
    conn: Connection,
    id: SpaceId,
    kind: PeerKind,
    onProgress?: () => void,
  ): Promise<Session | null> {
    let entry = this.held.get(id);

    if (entry === undefined) {
      if (this.capabilities.acceptUnknownSpaces !== true) return null;
      // A space is named by its own key, so holding it needs nothing beyond
      // what the connection already said.
      const key = keyFromId(id);
      if (key === null) return null;
      await this.hold(key);
      entry = this.held.get(id);
      if (entry === undefined) return null;
    }

    const held = entry;
    const session = new Session(held.store, conn.channel, {
      peer: conn.peer,
      onFork: (fork) => {
        // §2.3: reported, never silently ignored, and never fatal — a fork is
        // confined to one chain.
        held.forks = [...held.forks, fork];
        this.note('log', id, `FORK: chain ${fork.chain.slice(0, 8)} diverged at ${fork.frontier}`);
        for (const o of this.observers) o.onFork?.(id, fork);
      },
      onEvents: (events) => {
        // The session appended these already, so the fold is advanced directly
        // — `receive` would refuse them as duplicates and fold nothing.
        held.space.absorb(events);
        this.note('log', id, `${events.length} event(s) from ${conn.peer}`);
        for (const o of this.observers) o.onEvents?.(id, events);
        onProgress?.();
      },
      onBlob: (hash, bytes) => {
        this.note('blob', id, `${hex(hash).slice(0, 8)} — ${bytes.length} bytes`);
        for (const o of this.observers) o.onBlob?.(id, hex(hash), bytes.length);
      },
    });

    held.sessions.set(conn.peer, session);
    held.connections.set(conn.peer, {
      close: () => conn.close(),
      kind,
      since: Date.now(),
      state: 'open',
    });
    return session;
  }

  /** A connection went away, whichever space it was for. */
  protected dropped(peer: string): void {
    for (const [id, entry] of this.held) {
      const session = entry.sessions.get(peer);
      if (session === undefined && !entry.connections.has(peer)) continue;
      session?.close();
      entry.sessions.delete(peer);
      entry.connections.delete(peer);
      this.note('connection', id, `${peer} gone`);
      for (const o of this.observers) o.onDisconnect?.(id, peer);
    }
    this.changed();
  }

  /**
   * Send anything a peer has not seen.
   *
   * Recomputed from the store rather than tracked, because what a session has
   * sent is exactly what the store holds that the peer's vector does not — and
   * the receiver deduplicates anyway, so an over-send costs a message.
   */
  protected async pushNew(id: SpaceId): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined || entry.sessions.size === 0) return;
    const events: Event[] = [];
    for await (const e of entry.store.readAll()) events.push(e);
    for (const session of entry.sessions.values()) {
      if (!session.isClosed) session.push(events);
    }
  }

  /**
   * Ask every connected peer for a blob.
   *
   * §2.4: events replicate to everyone, blobs are pulled by whoever wants them.
   * Asking all of them costs a message each and means a peer need not know
   * which one holds it — the `HAVE` exchange refines this later.
   */
  requestBlob(id: SpaceId, hash: Uint8Array): void {
    const entry = this.held.get(id);
    if (entry === undefined) return;
    for (const session of entry.sessions.values()) {
      if (!session.isClosed) session.requestBlob(hash);
    }
  }

  /** What each connected peer says it holds, for a space (§2.4, §10). */
  availability(id: SpaceId): { peer: string; blobs: number }[] {
    const entry = this.held.get(id);
    if (entry === undefined) return [];
    // Only what this session's peer advertised; presence is per-connection.
    return [...entry.sessions].map(([peer, s]) => ({ peer, blobs: s.ephemeral.present().size }));
  }

  peers(): PeerStatus[] {
    const out: PeerStatus[] = [];
    for (const [id, entry] of this.held) {
      for (const [peer, conn] of entry.connections) {
        out.push({
          id: peer,
          kind: conn.kind,
          space: id,
          since: conn.since,
          state: conn.state,
          ...(conn.detail === undefined ? {} : { detail: conn.detail }),
        });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.held.values()) {
      for (const conn of entry.connections.values()) conn.close();
      for (const session of entry.sessions.values()) session.close();
      await entry.space.close();
      await entry.lock.release();
    }
    this.held.clear();
    await this.capabilities.store.close();
  }
}

/** Peek at a HELLO to learn which space a connection is about. */
export function spaceFromHello(data: Uint8Array): SpaceId | null {
  if (data.length < 2 || data[0] !== 0x01) return null;
  try {
    const msg = JSON.parse(new TextDecoder().decode(data.subarray(1)));
    if (msg?.type !== 'HELLO' || typeof msg.space !== 'string') return null;
    return msg.space;
  } catch {
    return null;
  }
}
