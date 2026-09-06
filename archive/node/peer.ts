/**
 * A peer outside the browser.
 *
 * Almost nothing: `Client` is the peer (see `@thing/engine`'s `client/`), and
 * this supplies what a server has that a browser does not — a directory, key
 * files, and **an address**. Being reachable is the whole difference, and it is
 * a capability rather than a rank (ARCHITECTURE.md §5.6): this peer has no
 * authority a browser tab lacks, runs the same protocol, the same fold, the
 * same verification.
 *
 * That asymmetry is why `listen` lives here and not in the engine. A browser
 * cannot accept connections, so accepting cannot be part of being a peer; it is
 * something a peer that happens to have an address also does, feeding each
 * connection to `Client.adopt`.
 */
import {
  Client,
  type ClientObserver,
  type Divergence,
  type Event,
  hex,
  type KeyPair,
  type PublicKey,
  type Session,
  type Space,
  type SpaceId,
} from '@thing/engine';

import { FileStore } from './filestore.js';
import { dial, PeerServer } from './transport.js';

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

export class Peer {
  private readonly client: Client;
  private server: PeerServer | null = null;

  constructor(private readonly options: PeerOptions) {
    // The callbacks are named from the operator's side — peer first, since that
    // is what a log line leads with — so they are adapted rather than passed.
    const observer: ClientObserver = {
      ...(options.onFork === undefined ? {} : { onFork: options.onFork }),
      ...(options.onEvents === undefined ? {} : { onEvents: options.onEvents }),
      ...(options.onBlob === undefined ? {} : { onBlob: options.onBlob }),
      ...(options.onConnect === undefined
        ? {}
        : { onConnect: (space, peer) => options.onConnect?.(peer, space) }),
      ...(options.onDisconnect === undefined
        ? {}
        : { onDisconnect: (_space, peer) => options.onDisconnect?.(peer) }),
      ...(options.onRefused === undefined
        ? {}
        : { onRefused: (space, peer) => options.onRefused?.(peer, space) }),
    };

    this.client = new Client(
      {
        store: new FileStore(options.dir),
        ...(options.acceptUnknownSpaces === undefined
          ? {}
          : { acceptUnknownSpaces: options.acceptUnknownSpaces }),
      },
      observer,
    );
  }

  /** Start accepting connections, if this peer has an address. */
  async start(): Promise<void> {
    if (this.options.listen === undefined) return;
    this.server = new PeerServer(this.options.listen);
    this.server.onConnection((conn) => this.client.adopt(conn));
    await this.server.ready();
  }

  /** The port actually bound, which matters when 0 was requested. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Hold a space, opening it from disk.
   *
   * `writer` is absent for a peer that only stores and serves — the ordinary
   * case for a hub, and the one §6.1 says is possible without ever being able
   * to read.
   */
  async hold(key: PublicKey, writer?: KeyPair): Promise<Space> {
    return this.client.hold(key, writer);
  }

  /** Spaces this peer has on disk. */
  async list(): Promise<readonly SpaceId[]> {
    return this.client.list();
  }

  space(id: SpaceId): Space | null {
    return this.client.space(id);
  }

  /**
   * Connect to a peer and sync one space with it.
   *
   * How an unreachable peer participates: it cannot be dialled, so it dials.
   * The connection is symmetric once open — the protocol does not care who
   * started it.
   */
  async connect(url: string, key: PublicKey): Promise<Session> {
    const id = hex(key);
    await this.hold(key);
    const conn = await dial(url);
    this.options.onConnect?.(conn.peer, id);
    return this.client.join(id, conn);
  }

  requestBlob(id: SpaceId, hash: Uint8Array): void {
    this.client.requestBlob(id, hash);
  }

  async close(): Promise<void> {
    await this.client.close();
    if (this.server !== null) await this.server.close();
  }
}
