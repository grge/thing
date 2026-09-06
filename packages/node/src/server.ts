/**
 * A headless peer: one space, served.
 *
 * **It holds exactly one space, and that is not a limitation being worked
 * around** (`docs/MAIN-SPACE.md`). A server has no interface — it is a store, a
 * set of connections, and nothing to render into — so one space is what it can
 * offer and one is what it has. A client with a screen opens as many as it can
 * show; a server cannot show any, so it holds its own.
 *
 * That space is the **main space**: what this peer serves, and what a client
 * connecting to it sees. Its contents are ordinary — files, folders, and links
 * to other spaces. Curating it is how a hub is made, and adding a link is how
 * you tell a server about another space; there is no admin verb for it, because
 * editing the space *is* the verb.
 *
 * **A hub is not a different program.** It is this, with someone's curation in
 * the space.
 */
import {
  Client,
  type ClientObserver,
  hex,
  type KeyPair,
  type PublicKey,
  type Space,
} from '@thing/engine';

import { FileStore } from './filestore.js';
import { FileKeyring } from './local.js';
import { PeerServer } from './transport.js';

export interface ServerOptions {
  /** Where the store, keys and everything else live. */
  readonly dir: string;
  /** The space this peer serves. Its key: identity, not an address (§5.1). */
  readonly space: PublicKey;
  /** Accept connections here. Absent means dial-only — the NAT case (§5.6). */
  readonly listen?: { readonly port: number; readonly host?: string };
  readonly observer?: ClientObserver;
}

export class Server {
  private readonly client: Client;
  private readonly keyring: FileKeyring;
  private listener: PeerServer | null = null;
  private held: Space | null = null;

  constructor(private readonly options: ServerOptions) {
    this.keyring = new FileKeyring(options.dir);
    this.client = new Client(
      {
        store: new FileStore(options.dir),
        keys: { keyFor: (id) => this.keyring.keyFor(id) },
        // No lock. Per-process append points mean two processes writing one
        // space extend separate chains and never contend (§2.1), so a lock
        // would prevent something that is no longer a hazard.
      },
      options.observer ?? {},
    );
  }

  /**
   * Open the space and start serving.
   *
   * The space is held whether or not this peer can write to it: §6.1 says
   * storing and serving without a writing key is an ordinary way to
   * participate, and it is what a hub mirroring someone else's space does.
   */
  async start(): Promise<void> {
    const writer = await this.keyring.keyFor(hex(this.options.space));
    this.held = await this.client.hold(
      this.options.space,
      writer === null ? undefined : writer,
    );

    if (this.options.listen !== undefined) {
      this.listener = new PeerServer(this.options.listen);
      // Whoever can listen feeds what it accepts to the client; accepting is
      // not part of *being* a peer, since a browser cannot do it (§5.6).
      this.listener.onConnection((conn) => this.client.adopt(conn));
      await this.listener.ready();
    }
  }

  /** The space this peer serves. Null before `start`. */
  get space(): Space | null {
    return this.held;
  }

  /** The port actually bound, which matters when 0 was requested. */
  get port(): number {
    return this.listener?.port ?? 0;
  }

  /** Whether this peer can write to the space it serves. */
  get writable(): boolean {
    return this.held?.writable ?? false;
  }

  async close(): Promise<void> {
    await this.client.close();
    if (this.listener !== null) await this.listener.close();
  }
}

/** Mint a space for a peer that has none yet. */
export async function createSpace(dir: string): Promise<KeyPair> {
  return new FileKeyring(dir).mint();
}
