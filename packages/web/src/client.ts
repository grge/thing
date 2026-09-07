/**
 * The browser client: tabs over spaces.
 *
 * **A client with an interface holds several spaces at once, as tabs**
 * (`docs/design/MAIN-SPACE.md`). That is the whole difference from a server, and it
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
  codeFor,
  type Connection,
  type Divergence,
  hex,
  type KeyPair,
  links,
  type Locator,
  parseLocator,
  referencedBlobs,
  type PeerKind,
  type PeerStatus,
  type PublicKey,
  type State,
} from '@thing/engine';

import { IdbStore } from './idbstore.js';
import { browserLocalState, readSettings, type Settings, writeSettings } from './local.js';
import { WebSocketSignalling } from './signalling.js';
import { connectVia, type RtcConnection, type RtcOptions } from './webrtc.js';

export type { Activity, PeerKind, PeerStatus };

/** One open space, as a view sees it. */
/** One blob, and whether the space's content still points at it. */
export interface BlobRow {
  readonly hash: string;
  /** Some object's body names this hash. */
  readonly referenced: boolean;
  /** The bytes are in this browser. */
  readonly held: boolean;
}

/** One space in this browser's storage (`docs/design/WEB-CLIENT.md`, the storage view). */
export interface StoredSpace {
  readonly id: string;
  /** Whether a tab currently shows it. */
  readonly inTab: boolean;
  /** Whether it is open — held spaces include ones cached to expand a link. */
  readonly held: boolean;
  readonly name: string | null;
  /** How many events it holds, or null if it is not open to be counted. */
  readonly events: number | null;
}

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
  /**
   * Whether this space keeps a copy of the content it names (§2.4).
   *
   * Off by default: a tab is for looking, and mirroring every blob in a space
   * opened once would be an expensive surprise on a phone. Turning it on is
   * what "keep a copy of this" means, and it is also what makes this client
   * able to serve the content to someone else.
   */
  readonly mirrors: boolean;
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
   * with no inventory (`docs/design/MAIN-SPACE.md`), a lost tab list means a space
   * you made yourself becomes unfindable, since nothing else records that it
   * exists. `docs/design/WEB-CLIENT.md` called this "a UI question, deliberately not a design
   * one, since losing it costs reopening a tab" — which was wrong. It costs
   * the space.
   */
  private tabs: { key: PublicKey; name: string | null }[] = [];
  private signalling: WebSocketSignalling | null = null;
  /** Failed addresses, for backing off. */
  private readonly retries = new Map<string, number>();

  constructor(private readonly browser: ClientOptions = {}) {
    // Built here and kept, rather than constructed inline in the `super`
    // call: the storage view needs to ask *this* store whether its listing is
    // complete, and `capabilities.store` is a `Store`, which has no
    // `canEnumerate` — that is an IndexedDB fact, not a general one. A second
    // `IdbStore` would answer about a different object; a module-level one
    // would be shared by every client in a process, which is wrong for tests
    // even though a page only ever has one.
    const store = new IdbStore();
    super({
      store,
      keys: { keyFor: (id) => this.local.keys.keyFor(id) },
      // Through a facade: `local` is a field, so it is not initialised when
      // this object is built for `super`. The engine only ever calls these.
      locators: {
        get: (id) => this.local.locators.get(id),
        remember: (id, l) => this.local.locators.remember(id, l),
        succeeded: (id, l) => this.local.locators.succeeded(id, l),
        failed: (id, l) => this.local.locators.failed(id, l),
        forget: (id) => this.local.locators.forget(id),
      },
      // A browser has no address of its own. When it is meeting through a
      // signalling server it can name that session, which is §5.2's second
      // locator shape and the only way a browser is reachable by someone it
      // has not already met.
      locatorsOfSelf: () => this.selfLocators(),
      dial: (locator) => this.dialLocator(locator),
      // No lock. Two tabs sharing a key mint separate append points and extend
      // separate chains (§2.1), so there is nothing to contend for — which is
      // what `writelock.ts` existed to prevent and no longer can happen.
    });
    this.idb = store;
    this.observe({ onChange: () => this.changed() });
  }

  /** This client's store, typed — see the constructor. */
  private readonly idb: IdbStore;

  /**
   * Reopen what was open last time.
   *
   * Call once on start. Spaces themselves live in IndexedDB and survive a
   * reload on their own; what needs restoring is which were open and what this
   * client called them.
   */
  async restore(): Promise<void> {
    const remembered = await this.local.inventory.all();

    // Drop names for spaces that are not in the inventory. Closing a tab used
    // to leave its petname behind, where nothing could read it and it went on
    // holding the name against a future space. Anyone who closed a few tabs
    // before this was fixed has a handful of them.
    const held = new Set(remembered);
    for (const [name, id] of await this.local.petnames.all()) {
      if (!held.has(id)) await this.local.petnames.remove(name);
    }

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

  /**
   * How this browser can be reached (§5.2).
   *
   * Only while it is meeting through a signalling server: `{via, peer}` names
   * that session, and dies with it. A browser not currently meeting has no
   * locator at all, which is the ordinary case — it is reached on connections
   * it opened, which is what an announcement with no address means.
   */
  private selfLocators(): readonly Locator[] {
    const url = this.browser.signallingUrl;
    const id = this.signalling?.id;
    if (url === undefined || id === undefined || id === '') return [];
    return [{ kind: 'via', url, peer: id }];
  }

  /**
   * Open a connection to a locator.
   *
   * A direct address is a socket. A session is a meeting: the same path
   * `meetAt` takes, since being told "reach me through this signalling server
   * at this session" is what a short code turns into.
   */
  private async dialLocator(locator: Locator): Promise<Connection> {
    if (locator.kind === 'ws') {
      const socket = new WebSocket(locator.url);
      socket.binaryType = 'arraybuffer';
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error(`could not reach ${locator.url}`)), {
          once: true,
        });
      });
      return socketConnection(socket, `ws:${locator.url}`);
    }
    throw new Error('dialling a session locator is not wired yet');
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
    // A writing identity for this space, minted if there is none (§5.1:
    // identity is per-space, and we make a new writer id for every space we
    // touch). Idempotent, so a space this client *owns* keeps the key that is
    // its own identity rather than gaining a second one.
    //
    // **This writes nothing to the space.** The key lives in local storage and
    // never replicates; the identity becomes visible to anyone else only when
    // this client actually signs something. So `open` still writes nothing,
    // which is what makes a tab free — and the alternative, minting lazily on
    // first write, would mean reopening the space, since `Space` takes its
    // writer at open (`space.ts`) and every control asking `writable` would
    // show read-only until then.
    const writer = await this.local.keys.mintFor(id);
    await this.hold(key, writer);
    // Remembered so a reload reopens it. Not an inventory in the model's sense
    // — nothing replicates this — but a client that forgets what it had open
    // has no other way back to a space it made.
    await this.local.inventory.remember(id);
    // Only if it has none: an incoming name should not silently rename a space
    // this client has already given one.
    if (name !== null && this.local.petnames.nameFor(id) === null) {
      const taken = this.local.petnames.free(name, id);
      await this.local.petnames.set(taken, id);
      // The tab shows what was actually taken, not what was asked for — two
      // spaces called `untitled` would otherwise both display the same label
      // while only one of them held the name.
      const tab = this.tabs.find((t) => hex(t.key) === id);
      if (tab !== undefined) tab.name = taken;
    }
    this.changed();
    return this.tabOf(id)!;
  }

  /**
   * Close a tab, and **delete the space**.
   *
   * Closing is destructive, deliberately. The alternative — closing leaves the
   * log behind — means spaces accumulate silently with no way to remove one,
   * and a browser that has visited a few hubs is holding every space it ever
   * expanded.
   *
   * The rule chosen instead is simple enough to say in a sentence: *closing a
   * tab deletes it*. That is a footgun, and it is one nothing can take away —
   * **a client cannot know whether its copy is the last one**, so deciding
   * what is safe to close is the person's job however this behaves. Better
   * that they know the rule than that a policy guess for them.
   *
   * Spaces held only to expand a link go too, unless another open tab is
   * showing them.
   */
  async closeTab(id: string): Promise<void> {
    const at = this.tabs.findIndex((t) => hex(t.key) === id);
    if (at !== -1) this.tabs.splice(at, 1);

    await this.local.inventory.forget(id);
    // The petname goes too. Nothing can read it back — `restore` iterates the
    // inventory, so a name for a space that is not in it is unreachable — and
    // leaving it behind means the name stays *taken*, so a later space cannot
    // have it. That is how `untitled 8` happens with no other untitled open.
    const name = this.local.petnames.nameFor(id);
    if (name !== null) await this.local.petnames.remove(name);

    // **The writing key stays.** Closing a tab discards a local copy, and
    // §5.1.1 is unambiguous that a discarded key cannot be recovered: reopening
    // the space later would make this client a stranger to its own past
    // events, which stay in the log under an identity it can no longer extend.
    // Keeping it costs one seed in local storage and nothing in any space —
    // the key never replicates, and an identity nobody has written under is
    // invisible to everyone else.
    await this.forget(id);
    await this.dropUnreferenced();
    this.changed();
  }

  /**
   * Delete spaces held only to expand a link, once nothing shows them.
   *
   * Not reference counting, which cannot work here: links live *inside* spaces
   * this client may not hold, so the graph cannot be walked without already
   * holding all of it, and it has cycles by design. The rule is narrower —
   * **a space that is not a tab is cached** — and cached spaces are disposable
   * because losing one costs a fetch.
   *
   * The one thing that keeps a cached space alive is an open tab linking to it,
   * checked one hop deep. Deeper expansions are re-fetched when expanded again.
   */
  private async dropUnreferenced(): Promise<void> {
    const open = new Set(this.tabs.map((t) => hex(t.key)));
    const referenced = new Set<string>();
    for (const tabId of open) {
      const space = this.space(tabId);
      if (space === null) continue;
      for (const l of links(space.state)) referenced.add(hex(l.target));
    }
    for (const held of this.holding()) {
      if (open.has(held) || referenced.has(held)) continue;
      await this.forget(held);
    }
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
      mirrors: this.mirrors(id),
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

  /* ── settings ─────────────────────────────────────────────────────────── */

  /**
   * What this browser is configured to do.
   *
   * Read from storage rather than held in a field, so a second tab that
   * changed them is not overwritten by this one's stale copy.
   */
  settings(): Settings {
    return readSettings();
  }

  /**
   * Change them.
   *
   * **Takes effect on reload**, and says so rather than pretending otherwise.
   * The signalling URL is read when a meeting starts and the ICE list when a
   * peer connection is built, so existing connections keep whatever they were
   * made with — reconnecting everything to apply a preference would drop live
   * transfers to no purpose.
   */
  saveSettings(next: Settings): void {
    writeSettings(next);
    this.changed();
  }

  /**
   * This client's writing key for a space, as a hex seed.
   *
   * **The one operation that deliberately hands out a secret**, which is why
   * it is here rather than on `Keyring`: §5.1.1 calls key loss the largest
   * unresolved risk in the design, and a client with no way to export is one
   * where clearing site data is unrecoverable by construction.
   */
  exportKey(id: string): string | null {
    return this.local.keys.exportKey(id);
  }

  /* ── what is actually in storage ──────────────────────────────────────── */

  /**
   * Every space this browser holds, whether or not a tab shows it.
   *
   * Closing a tab deletes its space and there is no inventory, so **a space in
   * storage that no tab points at is unreachable**: nothing lists it, nothing
   * opens it, nothing removes it. That should not happen — closing sweeps and
   * `restore` reopens what was open — but "should not happen" is exactly the
   * class of thing that wants a way to look (`docs/design/WEB-CLIENT.md`).
   *
   * `complete` is false where the browser cannot enumerate its own databases,
   * in which case this can only report what is already open — the case where
   * it is least useful, and so the one worth admitting to rather than showing
   * a short list that looks authoritative.
   */
  async storage(): Promise<{ complete: boolean; spaces: StoredSpace[] }> {
    const known = await this.list();
    const open = new Set(this.tabs.map((t) => hex(t.key)));
    const spaces = await Promise.all(
      known.map(async (id): Promise<StoredSpace> => {
        const held = this.entry(id);
        return {
          id,
          inTab: open.has(id),
          held: held !== undefined,
          name: this.local.petnames.nameFor(id),
          events: held === undefined ? null : await held.store.count(),
        };
      }),
    );
    return {
      complete: this.idb.canEnumerate,
      spaces: spaces.sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
  }

  /**
   * Put a space in storage back into a tab.
   *
   * The route back to data whose tab was lost — if the tab list and storage
   * ever disagree, there is no other one.
   */
  async restoreToTab(id: string): Promise<Tab | null> {
    const key = fromHex(id);
    if (key.length !== 32) return null;
    return this.open(key, this.local.petnames.nameFor(id));
  }

  /**
   * Delete a space from storage outright.
   *
   * Distinct from closing a tab, which also deletes: this reaches a space no
   * tab points at, which closing cannot.
   */
  async deleteFromStorage(id: string): Promise<void> {
    const name = this.local.petnames.nameFor(id);
    if (name !== null) await this.local.petnames.remove(name);
    await this.local.inventory.forget(id);
    await this.forget(id);
    this.changed();
  }

  /**
   * The blobs one space holds, and which of them its content refers to.
   *
   * Two sets that are not the same, and the difference is worth seeing:
   * **referenced but absent** is a file whose bytes have not arrived — the
   * "Fetching…" case — and **held but unreferenced** is content whose object
   * was deleted, which nothing collects yet (§2.4 blobs are a cache; §9 has
   * the compaction that would reclaim them).
   */
  async blobs(id: string): Promise<BlobRow[]> {
    const held = this.entry(id);
    if (held === undefined) return [];

    const referenced = referencedBlobs(held.space.state);
    const stored = new Set<string>();
    for await (const h of held.store.blobHashes()) stored.add(hex(h));

    const rows: BlobRow[] = [];
    for (const [key] of referenced) {
      rows.push({ hash: key, referenced: true, held: stored.has(key) });
    }
    for (const key of stored) {
      if (!referenced.has(key)) rows.push({ hash: key, referenced: false, held: true });
    }
    return rows.sort((a, b) => (a.hash < b.hash ? -1 : 1));
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
      // Distinct from the petname: this one replicates and is what the space
      // calls *itself*, where a petname is what this client calls it (§5.5).
      await space.write(new Uint8Array(16), ':name', new TextEncoder().encode(name));
    }
    return this.open(key.publicKey, name ?? null);
  }

  /**
   * Rename a space, for this client only.
   *
   * A petname is local and never replicated (§5.5) — renaming here changes
   * nothing anyone else sees, and does not touch what the space calls itself.
   * Returns the name actually taken, which differs if the asked-for one was in
   * use by another space.
   */
  async rename(id: string, name: string): Promise<string> {
    const taken = this.local.petnames.free(name, id);
    await this.local.petnames.set(taken, id);
    const tab = this.tabs.find((t) => hex(t.key) === id);
    if (tab !== undefined) tab.name = taken;
    this.changed();
    return taken;
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

    // **`join`, not `attach`.** `attach` deliberately does not wire frame
    // delivery — an adopted connection reads its own frames to learn which
    // space it is about, and would otherwise deliver each one twice — so a
    // caller that dials must use `join`, which wires it. Calling `attach`
    // here meant frames arrived at the socket and went nowhere: the space
    // stayed empty and the connection looked healthy.
    const conn = socketConnection(socket, `ws:${url}`);
    conn.onFrame(() => this.retries.delete(url));
    await this.join(id, conn);
    // Remember it, and that it worked. A locator typed or pasted by a person
    // is the same kind of thing as one a peer announced, and this is how
    // reopening a tab stops meaning pasting an address again (§5.3).
    const locator = parseLocator(url);
    if (locator !== null) {
      this.local.locators.remember(id, locator);
      this.local.locators.succeeded(id, locator);
    }

    socket.addEventListener('close', () => {
      this.note('connection', id, `${url} closed`);
      // A peer that restarted, a laptop that slept, a network that moved. None
      // of these should mean a space silently stops syncing.
      this.scheduleRetry(id, url);
    });

    this.note('connection', id, `dialled ${url}`);
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

  /**
   * A link that introduces someone to a space (§5.4).
   *
   * **The key is in the fragment**, so it never reaches a server — which is
   * what lets a link be shared through anything without the host of that
   * anything learning what was shared.
   *
   * `t` is the space's short code, used as the rendezvous token. Deterministic
   * from the key, so two people holding the same link wait in the same place
   * without agreeing on one first; and safe to be guessable, because an
   * impostor who answers still cannot produce events that verify (§5.4).
   *
   * `l` is optional and is the one locator source that works before you know
   * anybody (`docs/design/LOCATORS.md`). It belongs in a *share* link and never in a
   * stored one: a share link's staleness is fixed by resharing it, where a
   * rotted address inside a space propagates to everyone holding it.
   */
  shareLink(id: string, options: { locator?: string } = {}): string {
    const entry = this.entry(id);
    if (entry === undefined) throw new Error('that space is not open');

    const name = entry.space.state.root.get(':name')?.value;
    const params = new URLSearchParams();
    params.set('k', id);
    if (typeof name === 'string' && name !== '') params.set('n', name);
    params.set('t', codeFor(entry.key));
    if (options.locator !== undefined && options.locator !== '') {
      params.set('l', options.locator);
    }

    const base = `${location.origin}${location.pathname}`;
    return `${base}#${params.toString()}`;
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
 * source that works before you know anybody (`docs/design/LOCATORS.md`).
 */
export interface ShareLink {
  readonly key: string;
  readonly name: string | null;
  readonly token: string | null;
  readonly locator: string | null;
}

/**
 * A space key from whatever someone pasted.
 *
 * Accepts a bare 64-character key or a full share link, since both are things
 * people copy and neither is distinguishable by asking. **Not a short code**:
 * that is derived from the hash of a key and cannot be reversed (§5.4) — it
 * narrows where to look, and a client that has never seen the space has nothing
 * to look through.
 *
 * Returns the key and whatever else the paste carried, so a caller can dial the
 * hint or wait at the token.
 */
export function parsePasted(text: string): ShareLink | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const hash = trimmed.indexOf('#');
  if (hash !== -1) return parseShareLink(trimmed.slice(hash));

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return { key: trimmed.toLowerCase(), name: null, token: null, locator: null };
  }
  return null;
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
