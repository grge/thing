/**
 * What a client is handed, and what it hands back.
 *
 * The engine reaches for nothing (see `../index.ts`), so everything platform-
 * bound arrives through these types. A browser fills them with IndexedDB, Web
 * Locks and a `WebSocket`; a server with a directory, a lock file and a TCP
 * socket. Neither is the privileged case.
 */
import type { Channel, Locator } from '../net/index.js';
import type { LocatorCache } from '../local.js';
import type { KeyPair, PublicKey } from '../core/index.js';
import type { Divergence } from '../net/sync.js';
import type { Event } from '../core/index.js';
import type { SpaceId } from '../store/index.js';

/**
 * A live link to one other peer.
 *
 * The layer above `Channel`: a `Channel` can only send, and reconciling needs
 * somewhere for frames to arrive and a way to learn the link is gone. Both
 * runtimes already built this shape — `node/transport.ts` named it, the web
 * client built it inline — so naming it once is what lets one client serve
 * both.
 */
export interface Connection {
  /** Stable identifier, for attributing ephemeral messages to a sender. */
  readonly peer: string;
  readonly channel: Channel;
  onFrame(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/**
 * The right to write to a space, held against other processes or tabs.
 *
 * Two writers resuming from the same `seq` and `prev` produce two different
 * events at one sequence number, **both validly signed** — signing cannot catch
 * it (§7.3). Where the writers can agree cheaply they should, so the engine
 * asks for a lock and opens read-only when it cannot have one.
 */
export interface WriteLock {
  readonly held: boolean;
  release(): Promise<void>;
}

/** A lock nobody holds: for a replica, or a runtime without the mechanism. */
export const NO_LOCK: WriteLock = { held: false, release: async () => {} };

/** How a peer got here, which is the only thing that differs between them. */
export type PeerKind = 'direct' | 'introduced';

/**
 * Something worth showing an operator.
 *
 * Not protocol: a peer that says nothing is one you cannot tell is working, and
 * the three channels (§10) are otherwise invisible.
 */
export interface Activity {
  readonly at: number;
  readonly channel: 'connection' | 'log' | 'blob' | 'ephemeral' | 'signalling';
  readonly space: SpaceId | null;
  readonly text: string;
}

/**
 * What a client tells whoever embeds it.
 *
 * One observer set rather than a callback per event, because the browser's view
 * model and the CLI's activity log want the same facts in different shapes.
 * Everything here is advisory — nothing the protocol depends on.
 */
export interface ClientObserver {
  /** Anything worth redrawing for. */
  readonly onChange?: () => void;
  readonly onActivity?: (activity: Activity) => void;
  /** A chain that diverged (§2.3). Reported, never silently ignored. */
  readonly onFork?: (space: SpaceId, fork: Divergence) => void;
  readonly onEvents?: (space: SpaceId, events: readonly Event[]) => void;
  readonly onConnect?: (space: SpaceId | null, peer: string) => void;
  readonly onDisconnect?: (space: SpaceId | null, peer: string) => void;
  /** A connection refused because this client will not hold that space. */
  readonly onRefused?: (space: SpaceId, peer: string) => void;
  readonly onBlob?: (space: SpaceId, hash: string, bytes: number) => void;
  /**
   * A peer said it does not hold a blob (§2.4).
   *
   * The counterpart to `onBlob`, and its absence was a bug: a refusal looked
   * exactly like a slow transfer, so a view could only ever show "fetching"
   * and never "nobody here has this".
   */
  readonly onNoBlob?: (space: SpaceId, hash: string, peer: string) => void;
}

/**
 * How a client resolves the key it should write a space with.
 *
 * Supplied rather than assumed, because a browser reads `localStorage` and a
 * server reads a key file — and a hub has no writing key at all, which §6.1
 * says is an ordinary way to participate rather than a degraded one.
 */
export interface WriterSource {
  keyFor(space: SpaceId): Promise<KeyPair | null>;
}

/** Everything platform-bound that a client needs. */
export interface ClientCapabilities {
  /** Where spaces live. */
  readonly store: import('../store/index.js').Store;
  /** The writing key for a space, if this peer has one. */
  readonly keys?: WriterSource;
  /**
   * Take the write lock for a space, or report that someone else has it.
   *
   * Absent means unlocked — correct only where nothing else can be writing.
   */
  readonly lock?: (space: SpaceId) => Promise<WriteLock>;
  /**
   * Serve any space a connection asks about, or only spaces already held.
   *
   * `false` is the safe default: a peer that accepts anything offered becomes
   * free storage for strangers. `true` is what a hub run for a known group
   * wants, so it can hold a space nobody has introduced it to yet.
   */
  readonly acceptUnknownSpaces?: boolean;
  /**
   * Fetch blobs this peer folds but does not hold (§2.4).
   *
   * **A policy, not a protocol rule, and that is why it is a flag.** §2.4 says
   * blobs are pulled by whoever wants them: a peer that mirrors everything is
   * choosing to spend disk on content it may never read. The right answer
   * differs by *why the peer exists* rather than by what kind of program it is:
   *
   * - A **hub** exists to serve others. Holding a file's event but not its
   *   bytes makes it a poor relay — the case this was added for, where two
   *   browsers reach each other only through a server and neither can fetch
   *   what the other wrote.
   * - A **browser tab** holds a space to look at it. Mirroring every blob in a
   *   space opened once would be a surprise, and an expensive one on a phone.
   *
   * So it is off by default and turned on by the peer that wants it. A client
   * may vary it per space, which is what a "keep a copy of this space" control
   * means.
   */
  readonly mirrorBlobs?: boolean;
  /**
   * Where this client remembers reaching spaces (§5.3).
   *
   * Optional, because a client can sync perfectly well without one — it just
   * has to be told an address every time. Supplied rather than built here for
   * the same reason as the store: where it persists is a platform question.
   */
  readonly locators?: LocatorCache;
  /**
   * How this peer says it can be reached, if it can be.
   *
   * Empty is the ordinary case for a browser and for anything behind NAT: a
   * peer with no address of its own still serves, and whoever is already
   * connected can reach it on that connection. A server with a listening port
   * supplies one so its announcements are dialable by peers it has never met.
   */
  readonly locatorsOfSelf?: () => readonly Locator[];
  /**
   * Open a connection to a locator (§5.2).
   *
   * Supplied rather than built here, because dialling is the one thing the
   * engine cannot do: a browser opens a `WebSocket` or negotiates WebRTC
   * through a signalling server, a server opens a socket, and neither is
   * available to platform-free code.
   *
   * Rejecting is ordinary — a locator is stale by default (§5.3), and a failed
   * dial is what tells the cache to sink it.
   */
  readonly dial?: (locator: Locator) => Promise<Connection>;
}

/** A space id is its public key in hex, so the key is recoverable from it. */
export function keyFromId(id: SpaceId): PublicKey | null {
  if (id.length !== 64 || !/^[0-9a-f]+$/.test(id)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return out;
}
