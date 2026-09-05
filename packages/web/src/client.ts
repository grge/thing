/**
 * The browser client: spaces, connections, and what a view needs to draw.
 *
 * **All of it lives here rather than in a component.** The previous
 * implementation kept twenty-odd pieces of reactive state in one 1000-line
 * component, and the cost was that no part of it could be reasoned about or
 * tested without a browser. Here the view subscribes and draws; nothing about
 * syncing, storage or connection lifecycle is a UI concern.
 *
 * This is the browser's counterpart to `@thing/node`'s `Peer`, and deliberately
 * the same shape: hold spaces, connect, sync. What differs is reachability —
 * a browser cannot be dialled, so it dials or is introduced (ARCHITECTURE.md
 * §5.6).
 */
import { codeFor, type Event, hex, type KeyPair, type PublicKey } from '@thing/core';
import { type Divergence, Session } from '@thing/net';
import { Space } from '@thing/peer';
import { namesFor, type SpaceNames, type SpaceStore } from '@thing/store';
import { IdbStore } from './idbstore.js';
import { type Keystore, LocalKeystore } from './keystore.js';
import { WebSocketSignalling } from './signalling.js';
import { connectVia, type RtcConnection, type RtcOptions } from './webrtc.js';
import { acquireWriteLock, type WriteLock } from './writelock.js';

/** How a peer got here, which is the only thing that differs between them. */
export type PeerKind = 'direct' | 'introduced';

export interface PeerStatus {
  readonly id: string;
  readonly kind: PeerKind;
  readonly space: string;
  readonly since: number;
  /** Where the connection got to, for a connection that did not open. */
  readonly state: 'connecting' | 'open' | 'failed';
  readonly detail?: string;
}

/**
 * Something worth showing an operator.
 *
 * Not protocol: a peer that says nothing is one you cannot tell is working, and
 * the three channels (§10) are otherwise invisible. Kept bounded, because this
 * is a debugging aid and not a log.
 */
export interface Activity {
  readonly at: number;
  readonly channel: 'connection' | 'log' | 'blob' | 'ephemeral' | 'signalling';
  readonly space: string | null;
  readonly text: string;
}

/** What a view needs to know about one space, without folding anything itself. */
export interface SpaceStatus {
  readonly id: string;
  readonly names: SpaceNames;
  readonly writable: boolean;
  /**
   * This browser has the key, but another tab is writing with it (§7.3).
   *
   * Distinct from a plain replica: the difference matters to a person, because
   * one is "you cannot write here" and the other is "you cannot write here
   * *yet*".
   */
  readonly openElsewhere: boolean;
  readonly peers: number;
  /** Chains that have diverged (§2.3). Reported, never silently ignored. */
  readonly forks: readonly Divergence[];
}

export interface ClientOptions {
  readonly iceServers?: readonly RTCIceServer[];
  /** Where to be introduced, for browser-to-browser connections. */
  readonly signallingUrl?: string;
  readonly rtc?: RtcOptions;
}

interface Held {
  readonly key: PublicKey;
  /** Whether this browser holds a writing key at all, lock aside. */
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

export class Client {
  private readonly store = new IdbStore();
  private readonly held = new Map<string, Held>();
  private readonly listeners = new Set<() => void>();
  private signalling: WebSocketSignalling | null = null;
  /** Recent activity, newest first. Bounded: a debugging aid, not a log. */
  private readonly activity: Activity[] = [];
  private static readonly ACTIVITY_LIMIT = 200;

  constructor(
    private readonly keys: Keystore = new LocalKeystore(),
    private readonly options: ClientOptions = {},
  ) {}

  /** Subscribe to any change worth redrawing for. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Note something an operator might want to see. */
  private note(channel: Activity['channel'], space: string | null, text: string): void {
    this.activity.unshift({ at: Date.now(), channel, space, text });
    if (this.activity.length > Client.ACTIVITY_LIMIT) this.activity.length = Client.ACTIVITY_LIMIT;
    this.changed();
  }

  /** Recent activity across all three channels, newest first. */
  recent(): readonly Activity[] {
    return this.activity;
  }

  /** What a peer told us it holds, for a space (§2.4, §10). */
  availability(id: string): { peer: string; blobs: number }[] {
    const entry = this.held.get(id);
    if (entry === undefined) return [];
    return [...entry.sessions].map(([peer, session]) => ({
      peer,
      // Only what this session's peer advertised; presence is per-connection.
      blobs: session.ephemeral.present().size,
    }));
  }

  /* ── spaces ───────────────────────────────────────────────────────────── */

  /** Every space this browser holds, with everything a view needs. */
  spaces(): SpaceStatus[] {
    return [...this.held.values()]
      .map((h) => ({
        id: hex(h.key),
        names: namesFor(h.key, { petname: this.keys.petname(hex(h.key)) }),
        writable: h.space.writable,
        // A key this browser holds, but another tab is writing with (§7.3).
        openElsewhere: !h.space.writable && h.hasKey,
        peers: h.connections.size,
        forks: h.forks,
      }))
      .sort((a, b) => (a.names.display < b.names.display ? -1 : 1));
  }

  space(id: string): Space | null {
    return this.held.get(id)?.space ?? null;
  }

  /** Where a space was last reached, if this browser remembers (§5.3). */
  lastLocator(id: string): string | null {
    return this.keys.locator(id);
  }

  /** Open every space this browser has a record of. */
  async restore(): Promise<void> {
    for (const id of await this.keys.spaces()) {
      await this.hold(fromHex(id));
    }
    this.changed();

    // Reconnect where a space was last reached. Without this a reload leaves
    // every space held but connected to nobody, so metadata is there and
    // asking peers for a blob asks no one (§2.4).
    //
    // A cached locator is stale by default (§5.3): it is tried, and failing is
    // ordinary rather than an error worth reporting.
    for (const id of this.held.keys()) {
      const url = this.keys.locator(id);
      if (url === null) continue;
      try {
        await this.connectTo(id, url);
      } catch {
        this.note('connection', id, `${url} did not answer; it may have moved`);
      }
    }
  }

  /**
   * Mint a space. This browser holds the key, so it is the only writer.
   */
  async create(name?: string): Promise<string> {
    const key = await this.keys.mint();
    const space = await this.hold(key.publicKey, key);
    if (name !== undefined && name !== '' && space !== null) {
      // The suggested name goes on the root, written by the space key (§3.5).
      await space.write(new Uint8Array(16), ':name', new TextEncoder().encode(name));
    }
    this.changed();
    return hex(key.publicKey);
  }

  /**
   * Hold a space, opening it from storage.
   *
   * Without a writing key this is a replica: it stores, verifies and serves,
   * and cannot write (§6.1).
   */
  async hold(key: PublicKey, writer?: KeyPair): Promise<Space | null> {
    const id = hex(key);
    const existing = this.held.get(id);
    if (existing !== undefined) return existing.space;

    const store = await this.store.open(id, key);
    const own = writer ?? (await this.keys.keyFor(id));

    // §7.3: two tabs sharing one key would fork that writer's chain. Within a
    // browser they can simply agree, so a second tab opens read-only rather
    // than writing a branch that would later lose.
    const lock = own === null ? { held: false, release: async () => {} } : await acquireWriteLock(id);
    const space = await Space.open(
      store,
      own === null || !lock.held ? { key } : { key, writer: own },
    );

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
    await this.keys.remember(id);

    // A local write must reach connected peers: reconciliation runs once, when
    // vectors are exchanged, so without this a live connection goes stale.
    space.onChange(() => {
      void this.pushNew(id);
      this.changed();
    });

    this.changed();
    return space;
  }

  /** Forget a space entirely: its log, its blobs, its key. */
  async forget(id: string): Promise<void> {
    const entry = this.held.get(id);
    if (entry !== undefined) {
      for (const conn of entry.connections.values()) conn.close();
      await entry.space.close();
      await entry.lock.release();
      this.held.delete(id);
    }
    await this.store.destroy(id);
    await this.keys.forget(id);
    this.changed();
  }

  /* ── connections ──────────────────────────────────────────────────────── */

  /**
   * Dial a peer at a known address.
   *
   * The straightforward case: a peer with a stable address can be reached
   * directly, and needs no introduction (§5.6).
   */
  async connectTo(id: string, url: string): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined) throw new Error('not holding that space');

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not reach ${url}`)), {
        once: true,
      });
    });

    const session = this.attach(entry, `ws:${url}`, 'direct', {
      send: (frame) => socket.send(frame.slice().buffer as ArrayBuffer),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    });

    socket.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data;
      if (data instanceof ArrayBuffer) void session.receive(new Uint8Array(data));
    });
    socket.addEventListener('close', () => {
      this.note('connection', id, `${url} closed`);
      this.detach(entry, `ws:${url}`);
    });

    entry.connections.set(`ws:${url}`, {
      close: () => socket.close(),
      kind: 'direct',
      since: Date.now(),
      state: 'open',
    });
    // Remembered so a reload reconnects rather than needing the address again.
    this.keys.rememberLocator(id, url);
    this.note('connection', id, `dialled ${url}`);
    await session.start();
    this.changed();
  }

  /**
   * Wait at a rendezvous token, and connect to whoever else appears.
   *
   * Two browsers cannot dial each other, so a share link carries a token and
   * the signalling server matches them. It is never told which space they are
   * meeting about (§5.7).
   */
  async meetAt(id: string, token: string): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined) throw new Error('not holding that space');

    const url = this.options.signallingUrl;
    if (url === undefined) throw new Error('no signalling server configured');

    const signalling = new WebSocketSignalling(url);
    this.signalling = signalling;

    signalling.onPeer((peer) => {
      this.note('signalling', id, `introduced to ${peer}`);
      void (async () => {
        try {
          const conn = await connectVia(signalling, peer, {
            ...(this.options.iceServers === undefined
              ? {}
              : { iceServers: this.options.iceServers }),
            ...this.options.rtc,
          });
          this.adopt(entry, conn);
        } catch (err) {
          // A peer that could not be reached is ordinary — it may have gone,
          // or be behind something ICE could not traverse. Worth saying so
          // rather than failing silently.
          this.note(
            'connection',
            id,
            `could not reach ${peer}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        }
      })();
    });

    this.note('signalling', id, `waiting at ${token}`);
    await signalling.join(token);
  }

  private adopt(entry: Held, conn: RtcConnection): void {
    const session = this.attach(entry, conn.peer, 'introduced', conn.channel);
    conn.onFrame((data) => void session.receive(data));
    conn.onClose(() => this.detach(entry, conn.peer));
    entry.connections.set(conn.peer, {
      close: () => conn.close(),
      kind: 'introduced',
      since: Date.now(),
      state: 'open',
    });
    this.note('connection', hex(entry.key), `data channel open to ${conn.peer}`);
    void session.start();
    this.changed();
  }

  private attach(
    entry: Held,
    peer: string,
    _kind: PeerKind,
    channel: { send(frame: Uint8Array): void; readonly bufferedAmount: number },
  ): Session {
    const session = new Session(entry.store, channel, {
      peer,
      onFork: (fork) => {
        // §2.3: reported, never silently ignored, and never fatal — a fork is
        // confined to one writer's chain.
        entry.forks = [...entry.forks, fork];
        this.note(
          'log',
          hex(entry.key),
          `FORK: writer ${fork.writer.slice(0, 8)} diverged at ${fork.frontier}`,
        );
      },
      onEvents: (events) => {
        // The session appended these already, so the fold is advanced directly
        // — `receive` would refuse them as duplicates and fold nothing.
        entry.space.absorb(events);
        this.note('log', hex(entry.key), `${events.length} event(s) from ${peer}`);
      },
      onBlob: (hash, bytes) =>
        this.note('blob', hex(entry.key), `${hex(hash).slice(0, 8)} — ${bytes.length} bytes`),
    });
    entry.sessions.set(peer, session);
    return session;
  }

  private detach(entry: Held, peer: string): void {
    this.note('connection', hex(entry.key), `${peer} gone`);
    entry.sessions.get(peer)?.close();
    entry.sessions.delete(peer);
    entry.connections.delete(peer);
    this.changed();
  }

  /** Send anything a peer has not seen. */
  private async pushNew(id: string): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined || entry.sessions.size === 0) return;
    const events: Event[] = [];
    for await (const e of entry.store.readAll()) events.push(e);
    for (const session of entry.sessions.values()) {
      if (!session.isClosed) session.push(events);
    }
  }

  /** Ask every connected peer for a blob (§2.4). */
  requestBlob(id: string, hash: Uint8Array): void {
    const entry = this.held.get(id);
    if (entry === undefined) return;
    for (const session of entry.sessions.values()) {
      if (!session.isClosed) session.requestBlob(hash);
    }
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

  /* ── sharing ──────────────────────────────────────────────────────────── */

  /**
   * A link that introduces someone to a space (§5.4).
   *
   * The key goes in the **fragment**, so it never reaches a server. `t` is the
   * rendezvous token, and `l` an optional address — a link that names a
   * reachable peer works without any signalling at all.
   */
  shareLink(id: string, options: { locator?: string } = {}): string {
    const entry = this.held.get(id);
    if (entry === undefined) throw new Error('not holding that space');

    const name = entry.space.state.root.get(':name')?.value;
    const params = new URLSearchParams();
    params.set('k', id);
    if (typeof name === 'string' && name !== '') params.set('n', name);
    params.set('t', codeFor(entry.key));
    if (options.locator !== undefined) params.set('l', options.locator);

    const base = `${location.origin}${location.pathname}`;
    return `${base}#${params.toString()}`;
  }

  async close(): Promise<void> {
    for (const entry of this.held.values()) {
      for (const conn of entry.connections.values()) conn.close();
      await entry.space.close();
      await entry.lock.release();
    }
    this.held.clear();
    this.signalling?.close();
    await this.store.close();
  }
}

/**
 * What a share link says (§5.4).
 *
 * Parsed from the fragment, which never reaches a server. A link carries full
 * verification because it names the key; a typed code carries only a hint.
 */
export interface ShareLink {
  readonly key: string;
  readonly name: string | null;
  readonly token: string | null;
  readonly locator: string | null;
}

export function parseShareLink(fragment: string): ShareLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const key = params.get('k');
  if (key === null || key.length !== 64 || !/^[0-9a-f]+$/i.test(key)) return null;
  return {
    key: key.toLowerCase(),
    name: params.get('n'),
    token: params.get('t'),
    locator: params.get('l'),
  };
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
