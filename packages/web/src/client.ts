/**
 * The browser client: spaces, connections, and what a view needs to draw.
 *
 * **All of it lives here rather than in a component.** The previous
 * implementation kept twenty-odd pieces of reactive state in one 1000-line
 * component, and the cost was that no part of it could be reasoned about or
 * tested without a browser. Here the view subscribes and draws; nothing about
 * syncing, storage or connection lifecycle is a UI concern.
 *
 * Holding spaces and syncing them is not here at all — that is `@thing/engine`'s
 * `Client`, the same code a headless peer runs. What remains is genuinely
 * browser-shaped: IndexedDB, `localStorage` keys, Web Locks, `WebSocket` and
 * WebRTC, and the view model a Svelte component reads. What differs from a
 * server is reachability — a browser cannot be dialled, so it dials or is
 * introduced (ARCHITECTURE.md §5.6) — which is why nothing here listens.
 */
import {
  type Activity,
  Client as PeerClient,
  codeFor,
  type Connection,
  type Divergence,
  hex,
  type KeyPair,
  namesFor,
  type PeerKind,
  type PeerStatus,
  type PublicKey,
  type Space,
  type SpaceNames,
} from '@thing/engine';

import { IdbStore } from './idbstore.js';
import { browserLocalState, type LocalPetnames } from './local.js';
import { WebSocketSignalling } from './signalling.js';
import { connectVia, type RtcConnection, type RtcOptions } from './webrtc.js';
import { acquireWriteLock } from './writelock.js';

export type { Activity, PeerKind, PeerStatus };

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

export class Client extends PeerClient {
  private readonly listeners = new Set<() => void>();
  private signalling: WebSocketSignalling | null = null;
  /** Failed attempts per address, for backing off. */
  private readonly retries = new Map<string, number>();

  private readonly local: ReturnType<typeof browserLocalState>;

  constructor(
    local: ReturnType<typeof browserLocalState> = browserLocalState(),
    private readonly browser: ClientOptions = {},
  ) {
    super({
      store: new IdbStore(),
      keys: { keyFor: (id) => local.keys.keyFor(id) },
      lock: (id) => acquireWriteLock(id),
    });
    this.local = local;
    this.observe({ onChange: () => this.changed() });
  }

  /** The petname store, typed so a view can ask id -> name. */
  private petnamesOf(): LocalPetnames {
    return this.local.petnames;
  }

  /** Subscribe to any change worth redrawing for. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected override changed(): void {
    for (const listener of this.listeners) listener();
  }

  /* ── spaces ───────────────────────────────────────────────────────────── */

  /** Every space this browser holds, with everything a view needs. */
  spaces(): SpaceStatus[] {
    return this.holding()
      .map((id) => {
        const h = this.entry(id)!;
        return {
          id,
          names: namesFor(h.key, { petname: this.petnamesOf().nameFor(id) }),
          writable: h.space.writable,
          // A key this browser holds, but another tab is writing with (§7.3).
          openElsewhere: !h.space.writable && h.hasKey,
          peers: h.connections.size,
          forks: h.forks,
        };
      })
      .sort((a, b) => (a.names.display < b.names.display ? -1 : 1));
  }

  /** Where a space was last reached, if this browser remembers (§5.3). */
  lastLocator(id: string): string | null {
    return this.local.locators.get(id);
  }

  override async hold(key: PublicKey, writer?: KeyPair): Promise<Space> {
    const space = await super.hold(key, writer);
    await this.local.inventory.remember(hex(key));
    return space;
  }

  /** Open every space this browser has a record of. */
  async restore(): Promise<void> {
    for (const id of await this.local.inventory.all()) {
      await this.hold(fromHex(id));
    }
    this.changed();

    // Reconnect where a space was last reached. Without this a reload leaves
    // every space held but connected to nobody, so metadata is there and
    // asking peers for a blob asks no one (§2.4).
    //
    // A cached locator is stale by default (§5.3): it is tried, and failing is
    // ordinary rather than an error worth reporting.
    for (const id of this.holding()) {
      const url = this.local.locators.get(id);
      if (url === null) continue;
      try {
        await this.connectTo(id, url);
      } catch {
        this.note('connection', id, `${url} did not answer; it may have moved`);
      }
    }
  }

  /** Mint a space. This browser holds the key, so it is the only writer. */
  async create(name?: string): Promise<string> {
    const key = await this.local.keys.mint();
    const space = await this.hold(key.publicKey, key);
    if (name !== undefined && name !== '') {
      // The suggested name goes on the root, written by the space key (§3.5).
      await space.write(new Uint8Array(16), ':name', new TextEncoder().encode(name));
    }
    this.changed();
    return hex(key.publicKey);
  }

  /** Forget a space entirely: its log, its blobs, its key. */
  override async forget(id: string): Promise<void> {
    await super.forget(id);
    await this.local.keys.forget(id);
    await this.local.inventory.forget(id);
    this.local.locators.forget(id);
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
    if (this.entry(id) === undefined) throw new Error('not holding that space');

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not reach ${url}`)), {
        once: true,
      });
    });

    const session = await this.attach(
      socketConnection(socket, `ws:${url}`),
      id,
      'direct',
      // This address has proved itself, so a later drop starts from a short
      // delay rather than wherever the backoff had climbed to.
      () => this.retries.delete(url),
    );
    if (session === null) throw new Error('not holding that space');

    socket.addEventListener('close', () => {
      this.note('connection', id, `${url} closed`);
      // A peer that restarted, a laptop that slept, a network that moved.
      // None of these should mean a space silently stops syncing until
      // someone notices and reconnects by hand.
      this.scheduleRetry(id, url);
    });

    // Remembered so a reload reconnects rather than needing the address again.
    this.local.locators.set(id, url);
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
    if (this.entry(id) === undefined) throw new Error('not holding that space');

    const url = this.browser.signallingUrl;
    if (url === undefined) throw new Error('no signalling server configured');

    const signalling = new WebSocketSignalling(url);
    this.signalling = signalling;

    signalling.onPeer((peer) => {
      this.note('signalling', id, `introduced to ${peer}`);
      void (async () => {
        try {
          const conn = await connectVia(signalling, peer, {
            ...(this.browser.iceServers === undefined
              ? {}
              : { iceServers: this.browser.iceServers }),
            ...this.browser.rtc,
          });
          await this.join(id, rtcConnection(conn), 'introduced');
          this.note('connection', id, `data channel open to ${conn.peer}`);
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

  /**
   * Reconnect after a drop, backing off.
   *
   * Doubling from a second to a minute: quick enough that a peer restarting is
   * barely noticed, slow enough that a peer that is genuinely gone is not
   * hammered. Cleared only once a connection has *delivered* something —
   * clearing on open would reset the backoff for a peer that accepts the socket
   * and then refuses the space, turning a retry into a hot loop.
   */
  private scheduleRetry(id: string, url: string): void {
    if (this.closed) return;
    const attempt = (this.retries.get(url) ?? 0) + 1;
    this.retries.set(url, attempt);
    // Give up after a while rather than retrying forever: a peer that has
    // refused a dozen times is not coming back on its own, and the connect
    // control is there for when it does.
    if (attempt > 8) {
      this.note('connection', id, `giving up on ${url} after ${attempt - 1} attempts`);
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** (attempt - 1));

    setTimeout(() => {
      const entry = this.entry(id);
      if (this.closed || entry === undefined) return;
      // Someone may have reconnected by hand in the meantime.
      if (entry.connections.size > 0) return;
      void this.connectTo(id, url).catch(() => {
        this.note('connection', id, `${url} still unreachable`);
      });
    }, delay);
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
    const entry = this.entry(id);
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

  override async close(): Promise<void> {
    await super.close();
    this.signalling?.close();
  }
}

/** A `Connection` over a browser WebSocket. */
function socketConnection(socket: WebSocket, peer: string): Connection {
  const frames: ((data: Uint8Array) => void)[] = [];
  const closes: (() => void)[] = [];
  socket.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data;
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      for (const h of frames) h(bytes);
    }
  });
  socket.addEventListener('close', () => {
    for (const h of closes) h();
  });
  return {
    peer,
    channel: {
      send: (frame) => socket.send(frame.slice().buffer as ArrayBuffer),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    },
    onFrame: (h) => frames.push(h),
    onClose: (h) => closes.push(h),
    close: () => socket.close(),
  };
}

/** A `Connection` over a WebRTC data channel, which already has the shape. */
function rtcConnection(conn: RtcConnection): Connection {
  return {
    peer: conn.peer,
    channel: conn.channel,
    onFrame: (h) => conn.onFrame(h),
    onClose: (h) => conn.onClose(h),
    close: () => conn.close(),
  };
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
