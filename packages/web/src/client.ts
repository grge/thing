/**
 * The browser client: tabs over spaces.
 *
 * **A client with an interface holds several spaces at once, as tabs**
 * (`docs/MAIN-SPACE.md`). That is the whole difference from a server, and it
 * comes from having a renderer: a server has nothing to draw into, so it serves
 * one space; a client can show many, so it opens many.
 *
 * Two things follow, and both were mistakes in the previous version:
 *
 * **Opening is not acquiring.** Following a link opens a tab and writes
 * nothing. Keeping a space — deciding you want it — writes a link into a space
 * of your own, and is a separate act. When browsing *was* acquiring, a log
 * accumulated a permanent record of everything ever opened, since appends are
 * forever (§2.1).
 *
 * **A client need not hold a space of its own at all.** One that only views
 * other people's spaces needs a keyring and a list of open tabs. §6.1 already
 * says storing and serving without a writing key is ordinary; this is a step
 * further — participating without holding anything.
 *
 * Everything about *being a peer* is `@thing/engine`'s `Client`, which this
 * extends. What is here is browser-shaped: IndexedDB, `localStorage` keys,
 * WebSocket and WebRTC, and the view a component reads.
 */
import {
  type Activity,
  Client as PeerClient,
  type Connection,
  type Divergence,
  hex,
  type KeyPair,
  links,
  type PeerKind,
  type PeerStatus,
  type PublicKey,
  type State,
} from '@thing/engine';

import { IdbStore } from './idbstore.js';
import { browserLocalState } from './local.js';
import { WebSocketSignalling } from './signalling.js';
import { connectVia, type RtcConnection, type RtcOptions } from './webrtc.js';

export type { Activity, PeerKind, PeerStatus };

/** One open space, as a view sees it. */
export interface Tab {
  readonly id: string;
  readonly key: PublicKey;
  /** What this client calls it: the name of the link it was opened from. */
  readonly name: string | null;
  readonly state: State;
  readonly writable: boolean;
  /** Chains that have diverged (§2.3). Reported, never silently ignored. */
  readonly forks: readonly Divergence[];
  /** How this tab's space is being reached, if at all. */
  readonly peers: number;
}

export interface ClientOptions {
  readonly iceServers?: readonly RTCIceServer[];
  readonly signallingUrl?: string;
  readonly rtc?: RtcOptions;
}

export class Client extends PeerClient {
  private readonly listeners = new Set<() => void>();
  private readonly local = browserLocalState();
  /**
   * Open tabs, in the order they were opened.
   *
   * Interface state — in no log, and never replicated. But it *is* persisted:
   * with no inventory (`docs/MAIN-SPACE.md`), a lost tab list means a space
   * you made yourself becomes unfindable, since nothing else records that it
   * exists. `docs/WEB.md` called this "a UI question, deliberately not a design
   * one, since losing it costs reopening a tab" — which was wrong. It costs
   * the space.
   */
  private tabs: { key: PublicKey; name: string | null }[] = [];
  private signalling: WebSocketSignalling | null = null;
  /** Failed addresses, for backing off. */
  private readonly retries = new Map<string, number>();

  constructor(private readonly browser: ClientOptions = {}) {
    super({
      store: new IdbStore(),
      keys: { keyFor: (id) => this.local.keys.keyFor(id) },
      // No lock. Two tabs sharing a key mint separate append points and extend
      // separate chains (§2.1), so there is nothing to contend for — which is
      // what `writelock.ts` existed to prevent and no longer can happen.
    });
    this.observe({ onChange: () => this.changed() });
  }

  /**
   * Reopen what was open last time.
   *
   * Call once on start. Spaces themselves live in IndexedDB and survive a
   * reload on their own; what needs restoring is which were open and what this
   * client called them.
   */
  async restore(): Promise<void> {
    const remembered = await this.local.inventory.all();
    for (const id of remembered) {
      const name = this.local.petnames.nameFor(id);
      try {
        await this.open(fromHex(id), name);
      } catch {
        // A space whose store will not open is one this client cannot show.
        // Dropping it from the list beats failing the whole restore.
        await this.local.inventory.forget(id);
      }
    }
    this.changed();
  }

  /** Subscribe to any change worth redrawing for. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected override changed(): void {
    for (const listener of this.listeners) listener();
  }

  /* ── tabs ─────────────────────────────────────────────────────────────── */

  /**
   * Open a space, without keeping it.
   *
   * Writes nothing. A tab is interface state: close it and no trace remains,
   * which is what makes browsing free.
   */
  async open(key: PublicKey, name: string | null = null): Promise<Tab> {
    const id = hex(key);
    if (!this.tabs.some((t) => hex(t.key) === id)) this.tabs.push({ key, name });
    await this.hold(key);
    // Remembered so a reload reopens it. Not an inventory in the model's sense
    // — nothing replicates this — but a client that forgets what it had open
    // has no other way back to a space it made.
    await this.local.inventory.remember(id);
    if (name !== null) await this.local.petnames.set(name, id);
    this.changed();
    return this.tabOf(id)!;
  }

  /** Close a tab. The space stays in storage if it was kept; otherwise it is just gone. */
  async closeTab(id: string): Promise<void> {
    const at = this.tabs.findIndex((t) => hex(t.key) === id);
    if (at !== -1) this.tabs.splice(at, 1);
    await this.local.inventory.forget(id);
    await this.release(id);
    this.changed();
  }

  /** Every open tab, for a view. */
  view(): Tab[] {
    return this.tabs.map((t) => this.tabOf(hex(t.key))).filter((t): t is Tab => t !== null);
  }

  private tabOf(id: string): Tab | null {
    const held = this.entry(id);
    const tab = this.tabs.find((t) => hex(t.key) === id);
    if (held === undefined || tab === undefined) return null;
    return {
      id,
      key: tab.key,
      name: tab.name,
      state: held.space.state,
      writable: held.space.writable,
      forks: held.forks,
      peers: held.connections.size,
    };
  }

  /**
   * Follow a link out of an open space.
   *
   * The link's name comes with it, so a tab is labelled by what the space it
   * came from called it — which is what a petname was, without a separate store.
   */
  async follow(from: string, linkName: string): Promise<Tab | null> {
    const held = this.entry(from);
    if (held === undefined) return null;
    const found = links(held.space.state).find((l) => l.entry.name === linkName);
    if (found === undefined) return null;
    return this.open(found.target, found.entry.name);
  }

  /* ── spaces of one's own ──────────────────────────────────────────────── */

  /**
   * Mint a space this client holds and can write to.
   *
   * A client that only views other people's spaces never needs this.
   */
  async create(name?: string): Promise<Tab> {
    const key = await this.local.keys.mint();
    const space = await this.hold(key.publicKey, key);
    if (name !== undefined && name !== '') {
      // The suggested name goes on the root, written by the space key (§3.5).
      await space.write(new Uint8Array(16), ':name', new TextEncoder().encode(name));
    }
    return this.open(key.publicKey, name ?? null);
  }

  /* ── connections ──────────────────────────────────────────────────────── */

  /**
   * Dial a peer at a known address.
   *
   * A browser cannot be dialled, so it dials or is introduced (§5.6).
   */
  async connect(id: string, url: string): Promise<void> {
    if (this.entry(id) === undefined) throw new Error('that space is not open');

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
    if (session === null) throw new Error('that space is not open');

    socket.addEventListener('close', () => {
      this.note('connection', id, `${url} closed`);
      // A peer that restarted, a laptop that slept, a network that moved. None
      // of these should mean a space silently stops syncing.
      this.scheduleRetry(id, url);
    });

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
    if (this.entry(id) === undefined) throw new Error('that space is not open');

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
          // A peer that could not be reached is ordinary — it may have gone, or
          // be behind something ICE could not traverse.
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
   * Cleared only once a connection has *delivered* something — clearing on open
   * would reset the backoff for a peer that accepts the socket and then refuses
   * the space, turning a retry into a hot loop.
   */
  private scheduleRetry(id: string, url: string): void {
    if (this.closed) return;
    const attempt = (this.retries.get(url) ?? 0) + 1;
    this.retries.set(url, attempt);
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
      void this.connect(id, url).catch(() => {
        this.note('connection', id, `${url} still unreachable`);
      });
    }, delay);
  }

  override async close(): Promise<void> {
    await super.close();
    this.signalling?.close();
  }

  /** A key this browser can write with, for showing whether a tab is editable. */
  async keyFor(id: string): Promise<KeyPair | null> {
    return this.local.keys.keyFor(id);
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
 * The key is in the **fragment**, so it never reaches a server. A link carries
 * full verification because it names the key; the `l=` hint is the one locator
 * source that works before you know anybody (`docs/LOCATORS.md`).
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
