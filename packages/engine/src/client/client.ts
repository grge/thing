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
import type { Coverage, Divergence } from '../net/sync.js';
import { vvToWire } from '../net/wire.js';
import type { SpaceId, SpaceStore } from '../store/index.js';
import { referencedBlobs } from '../fs/files.js';
import { links } from '../fs/links.js';
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
  /**
   * Whether to fetch blobs this space folds but does not hold (§2.4).
   *
   * Per space rather than per client, because "keep a copy of this" is a
   * decision about one space: a browser may mirror the hub it contributes to
   * and browse everything else without spending disk on it. Defaults to the
   * client-wide capability.
   */
  mirrorBlobs: boolean;
  /** Blobs already asked for, so a refold does not re-ask on every event. */
  readonly asked: Set<string>;
  /**
   * Blobs a peer refused that this client still wants.
   *
   * `NO_BLOB` answers about *now*: a relay that is itself still fetching says
   * no and holds the bytes moments later. Keeping the want is what lets a
   * later `HAVE` turn into a retry rather than being ignored.
   */
  readonly wanted: Set<string>;
}

const ACTIVITY_LIMIT = 200;

export class Client {
  protected readonly held = new Map<SpaceId, Held>();
  /** Spaces being opened, so a concurrent `hold` waits rather than duplicating. */
  private readonly opening = new Map<SpaceId, Promise<Space>>();
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

    // **The promise is the guard, not the map.** Opening awaits several times
    // before anything is recorded, so two concurrent calls for one space would
    // both pass a `held.has` check and open it twice — two stores, two folds,
    // two of every session. A link graph makes that ordinary rather than
    // exotic: it has cycles by design, so a walk reaches the same space by
    // more than one path at once. Same shape as the `adopt` race.
    const opening = this.opening.get(id);
    if (opening !== undefined) return opening;

    const started = this.openSpace(id, key, writer);
    this.opening.set(id, started);
    try {
      return await started;
    } finally {
      this.opening.delete(id);
    }
  }

  private async openSpace(id: SpaceId, key: PublicKey, writer?: KeyPair): Promise<Space> {
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
      mirrorBlobs: this.capabilities.mirrorBlobs ?? false,
      asked: new Set(),
      wanted: new Set(),
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
    // Blobs missed while there was nobody to ask. `onEvents` only fires for
    // *new* events, so without this a peer that folded a `:body` while
    // disconnected would never fetch its bytes — the gap is invisible,
    // because the file is listed and only its content is absent.
    void this.mirror(id);
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
          // As in `join`: a peer that folded a `:body` with nobody to ask now
          // has somebody. This is the path a *server* takes, where mirroring
          // is on by default, so it is the one that matters most.
          void this.mirror(id);
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
        // A folded `:body` may name bytes this peer does not have. Whether to
        // go and get them is policy (§2.4), so it is asked here rather than
        // assumed.
        void this.mirror(id);
        onProgress?.();
      },
      onBlob: (hash, bytes) => {
        const key = hex(hash);
        held.asked.delete(key);
        held.wanted.delete(key);
        this.note('blob', id, `${key.slice(0, 8)} — ${bytes.length} bytes`);
        // Tell the other peers, so anyone who asked while this was still in
        // flight learns the answer has changed. A relay that stays silent
        // leaves them on a `NO_BLOB` they have no reason to retry.
        for (const [peer, s] of held.sessions) {
          if (peer !== conn.peer && !s.isClosed) s.announceBlob(key);
        }
        for (const o of this.observers) o.onBlob?.(id, key, bytes.length);
      },
      onNoBlob: (hash) => {
        // Report it rather than swallowing it: a caller waiting on these bytes
        // needs to know they are not coming from *this* peer, and the UI
        // needs to stop saying "fetching".
        //
        // Remembered as *wanted*, because "no" is an answer about this moment:
        // a relay still fetching the bytes says no and holds them a second
        // later. `onHave` is what turns that into a retry.
        held.asked.delete(hash);
        held.wanted.add(hash);
        this.note('blob', id, `${hash.slice(0, 8)} — not held by ${conn.peer}`);
        for (const o of this.observers) o.onNoBlob?.(id, hash, conn.peer);
      },
      onHave: (hashes) => {
        // A peer announced what it holds. Anything refused earlier and still
        // wanted is worth asking again — this is the retry that closes the
        // race between a client asking and a relay still fetching.
        for (const hash of hashes) {
          if (!held.wanted.has(hash)) continue;
          held.wanted.delete(hash);
          const bytes = hexToBytes32(hash);
          if (bytes !== null) this.requestBlob(id, bytes);
        }
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
   * Hold every space reachable by links from a root, to a given depth.
   *
   * **The link is the authorisation** (`docs/MAIN-SPACE.md`). A hub holds what
   * its main space links to and nothing else, which is a far narrower rule than
   * `acceptUnknownSpaces` — that one makes a peer free storage for strangers,
   * this one hosts exactly what its curators chose. Only writers of the root
   * space can add a link, so no new permission concept is involved, and
   * unlinking stops the hosting because §7.2.3's tombstone already means
   * "no longer".
   *
   * Depth is a setting because one hop and many are different products: one is
   * "host what I linked", and more is "host what they linked too", which is a
   * hub of hubs. The graph has cycles by design, so the walk tracks what it has
   * seen rather than trusting depth alone to terminate.
   *
   * Blobs are mirrored for everything held this way: hosting a space whose
   * content cannot be served is not hosting it.
   */
  async hostLinked(root: SpaceId, depth: number): Promise<readonly SpaceId[]> {
    const wanted = new Set<SpaceId>([root]);
    if (depth > 0) {
      let frontier = [root];
      for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
        const next: SpaceId[] = [];
        for (const id of frontier) {
          const space = this.space(id);
          if (space === null) continue;
          for (const { target } of links(space.state)) {
            const child = hex(target);
            // Cycles are ordinary here, so a space already queued is not
            // queued again — depth alone would not terminate.
            if (wanted.has(child)) continue;
            wanted.add(child);
            next.push(child);
          }
        }
        frontier = next;
      }
    }

    for (const id of wanted) {
      if (id === root) continue;
      const key = keyFromId(id);
      if (key === null) continue;
      // No writing key: a hub stores and serves someone else's space without
      // one, which §6.1 calls an ordinary way to participate.
      await this.hold(key);
      await this.setMirror(id, true);
    }
    return [...wanted].sort();
  }

  /**
   * Whether this space fetches blobs it folds but does not hold.
   *
   * Per space, so "keep a copy of this one" is a decision a person makes about
   * a space rather than about their whole client.
   */
  mirrors(id: SpaceId): boolean {
    return this.held.get(id)?.mirrorBlobs ?? false;
  }

  /** Turn mirroring on or off for one space, fetching what is missing if on. */
  async setMirror(id: SpaceId, on: boolean): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined || entry.mirrorBlobs === on) return;
    entry.mirrorBlobs = on;
    if (on) await this.mirror(id);
    this.changed();
  }

  /**
   * Fetch blobs this space refers to and does not hold (§2.4).
   *
   * **Only when asked to.** A peer that mirrors everything spends disk on
   * content it may never read, which is why §2.4 makes blobs pull-only — but a
   * relay that holds a file's event and not its bytes is a poor relay, and two
   * peers that can reach each other only through a hub cannot exchange content
   * at all unless the hub keeps some.
   *
   * Asks every connected peer, as `requestBlob` does: a peer need not know
   * which one holds it, and the ones that do not answer `NO_BLOB` cheaply.
   */
  protected async mirror(id: SpaceId): Promise<void> {
    const entry = this.held.get(id);
    if (entry === undefined || !entry.mirrorBlobs || entry.sessions.size === 0) return;

    for (const [key, hash] of referencedBlobs(entry.space.state)) {
      // Asked once per blob per client: a refold runs this on every batch of
      // events, and re-requesting an in-flight transfer would restart it.
      if (entry.asked.has(key)) continue;
      if (await entry.store.hasBlob(hash)) continue;
      entry.asked.add(key);
      this.requestBlob(id, hash);
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

  /**
   * Wait until a peer holds everything this client has written (§2.3.1).
   *
   * The condition under which a writer may go away. Resolves when every
   * connected peer's vector covers the one captured at the moment of the call
   * — so a caller writes, then waits, then exits, and knows the holder is not
   * relying on it.
   *
   * **The vector is captured once, up front.** Asking about "now" each round
   * would never settle on a space this client keeps writing to (§2.3.1's
   * *against a snapshot, not the present*).
   *
   * **Every session, not the first.** A client connected to two holders that
   * exits when one is caught up has told the other nothing. Waiting on all of
   * them is what "safe to disconnect" means for the connections it actually
   * has — it says nothing about peers it never spoke to, which is §2.3.1's
   * whole point about what a single peer can claim.
   *
   * Returns what stopped it: `covered` when all agreed, `behind` on timeout
   * naming what was still missing, `forked` if any chain diverged — which no
   * amount of waiting resolves, so it stops rather than spinning.
   */
  async synced(id: SpaceId, options: { timeoutMs?: number } = {}): Promise<Coverage> {
    const entry = this.held.get(id);
    if (entry === undefined) return { kind: 'behind', chains: [] };

    const mine = vvToWire(await entry.space.versionVector());
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);

    for (;;) {
      const live = [...entry.sessions.values()].filter((s) => !s.isClosed);
      // Nothing to wait for. Not "covered": no peer has said anything, and
      // reporting success would be the exact lie this exists to prevent.
      if (live.length === 0) return { kind: 'behind', chains: Object.keys(mine) };

      // Bounded, because a question can go unanswered: a stalled or wedged
      // connection is still open, so a peer that never replies would hang this
      // forever rather than reporting what is missing. An unanswered question
      // counts as behind, which is what it means.
      const remaining = Math.max(0, deadline - Date.now());
      const answers = await Promise.all(
        live.map((s) => withDeadline(s.askSynced(mine), remaining, Object.keys(mine))),
      );

      const forked = answers.flatMap((a) => (a.kind === 'forked' ? a.forks : []));
      if (forked.length > 0) return { kind: 'forked', forks: forked };

      const behind = new Set(answers.flatMap((a) => (a.kind === 'behind' ? a.chains : [])));
      if (behind.size === 0) return { kind: 'covered' };

      if (Date.now() >= deadline) return { kind: 'behind', chains: [...behind].sort() };

      // The peer is lagging, not broken: it has our events queued or is still
      // applying them. Give it a moment rather than spinning on the question.
      await new Promise<void>((r) => setTimeout(() => r(), 50));
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

/**
 * A coverage answer, or `behind` if the peer does not reply in time.
 *
 * Silence is not consent: a connection that is open but not delivering looks
 * exactly like one that is, and treating an unanswered question as anything
 * but "not yet" would report a write as landed when it went nowhere.
 */
function withDeadline(
  answer: Promise<Coverage>,
  ms: number,
  chains: readonly string[],
): Promise<Coverage> {
  return new Promise<Coverage>((resolve) => {
    // A settled flag rather than `clearTimeout`, which `platform.d.ts`
    // deliberately does not declare: the engine may touch only what both
    // runtimes genuinely provide, and a stray timer that fires after the
    // answer is harmless as long as it cannot resolve twice.
    let settled = false;
    const finish = (a: Coverage): void => {
      if (settled) return;
      settled = true;
      resolve(a);
    };
    setTimeout(() => finish({ kind: 'behind', chains }), ms);
    void answer.then(finish);
  });
}

/** A 32-byte hash from hex, or null if it is not one. */
function hexToBytes32(s: string): Uint8Array | null {
  if (s.length !== 64 || !/^[0-9a-f]+$/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
