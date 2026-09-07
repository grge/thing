/**
 * A headless peer: one space, served.
 *
 * **It holds exactly one space, and that is not a limitation being worked
 * around** (`docs/design/MAIN-SPACE.md`). A server has no interface — it is a store, a
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
  type Coverage,
  hex,
  type KeyPair,
  type PublicKey,
  type Locator,
  type LocatorCache,
  parseLocator,
  type Space,
} from '@thing/engine';

import { FileStore } from './filestore.js';
import { FileKeyring, FileLocators } from './local.js';
import { dial, PeerServer } from './transport.js';

export interface ServerOptions {
  /** Where the store, keys and everything else live. */
  readonly dir: string;
  /** The space this peer serves. Its key: identity, not an address (§5.1). */
  readonly space: PublicKey;
  /** Accept connections here. Absent means dial-only — the NAT case (§5.6). */
  readonly listen?: { readonly port: number; readonly host?: string };
  readonly observer?: ClientObserver;
  /**
   * How far to follow links out of the main space, hosting what it finds.
   *
   * **This is what makes a hub a hub.** Adding a link to your own space in a
   * server's main space is how you ask it to host that space: the link is the
   * authorisation, it is written by someone who may write the main space, and
   * unlinking withdraws it. `0` holds only the main space, which is what a
   * peer that is not a hub wants.
   *
   * Depth beyond 1 hosts what the linked spaces themselves link to — a hub of
   * hubs. Bounded because the graph has cycles by design.
   */
  readonly hostDepth?: number;
}

/**
 * One hop, by default: host what you were linked, not what they linked.
 *
 * Deeper is a legitimate choice and a different product — a hub of hubs — so
 * it is asked for rather than assumed.
 */
const DEFAULT_HOST_DEPTH = 1;

export class Server {
  private readonly client: Client;
  private readonly keyring: FileKeyring;
  private locators: LocatorCache | undefined;
  private listener: PeerServer | null = null;
  private held: Space | null = null;
  private hosted: readonly string[] = [];
  private readonly watching = new Set<string>();

  constructor(private readonly options: ServerOptions) {
    this.keyring = new FileKeyring(options.dir);
    this.client = new Client(
      {
        store: new FileStore(options.dir),
        keys: { keyFor: (id) => this.keyring.keyFor(id) },
        // No lock. Per-process append points mean two processes writing one
        // space extend separate chains and never contend (§2.1), so a lock
        // would prevent something that is no longer a hazard.
        //
        // **Blobs are mirrored, and that is what makes this a relay.** §2.4
        // makes blobs pull-only, so a peer holds a file's event and not its
        // bytes unless it goes and gets them. For a server that is the whole
        // job: two clients that can reach each other only through here cannot
        // exchange content at all if here keeps none of it. A browser tab
        // defaults the other way — see `mirrorBlobs` in `client/types.ts`.
        mirrorBlobs: true,
        // Where this peer can be reached, if it listens. A dial-only peer
        // (§5.6's NAT case) supplies nothing and is reached on connections it
        // opened — which is what an announcement with no address means.
        locatorsOfSelf: () => this.selfLocators(),
        // Read through a wrapper because the cache is loaded in `start` while
        // capabilities are built in the constructor. The engine only ever
        // calls these, so a facade is enough and avoids a two-phase client.
        locators: {
          get: (id) => this.locators?.get(id) ?? [],
          remember: (id, l) => this.locators?.remember(id, l),
          succeeded: (id, l) => this.locators?.succeeded(id, l),
          failed: (id, l) => this.locators?.failed(id, l),
          forget: (id) => this.locators?.forget(id),
        },
        dial: async (locator) => {
          if (locator.kind !== 'ws') {
            // A `{via, peer}` locator needs a signalling server and WebRTC,
            // which a headless peer does not have. Refusing is honest: the
            // caller tries the next candidate.
            throw new Error('this peer can only dial ws locators');
          }
          return dial(locator.url);
        },
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
    this.locators = await FileLocators.load(this.options.dir);
    const writer = await this.keyring.keyFor(hex(this.options.space));
    this.held = await this.client.hold(
      this.options.space,
      writer === null ? undefined : writer,
    );

    // Everything the main space links to, held and mirrored (§2.4). Done
    // before listening, so a peer that connects immediately finds the hosted
    // spaces already open rather than being refused.
    await this.rehost();
    // A link added later must take effect without a restart — dragging a space
    // into a hub *is* the request to host it, and a restart would make that a
    // two-step operation with a delay in the middle.
    this.watch(hex(this.options.space));

    if (this.options.listen !== undefined) {
      this.listener = new PeerServer(this.options.listen);
      // Whoever can listen feeds what it accepts to the client; accepting is
      // not part of *being* a peer, since a browser cannot do it (§5.6).
      this.listener.onConnection((conn) => this.client.adopt(conn));
      await this.listener.ready();
    }
  }

  /**
   * Dial another holder of this space (§5.6).
   *
   * **`join`, not `adopt`.** A dialled connection has to be attached to the
   * space it is for, and `join` is what wires frame delivery to a session; a
   * caller that dials and forgets that gets a connection which opens, greets,
   * and then silently delivers nothing.
   */
  async connect(url: string): Promise<void> {
    if (this.held === null) throw new Error('not started');
    const conn = await dial(url);
    await this.client.join(hex(this.options.space), conn);
  }

  /**
   * Wait until every connected peer holds what this one has written (§2.3.1).
   *
   * What a one-shot write needs before it exits: not "my append returned" but
   * "the holder I was pointed at is no longer relying on me".
   */
  async synced(options: { timeoutMs?: number } = {}): Promise<Coverage> {
    if (this.held === null) return { kind: 'behind', chains: [] };
    return this.client.synced(hex(this.options.space), options);
  }

  /**
   * Hold and mirror everything the main space links to.
   *
   * Idempotent, and called again on every change to the main space, so linking
   * hosts a space and unlinking stops the hosting from growing. **It does not
   * delete anything.** A mis-drag would otherwise destroy what may be the only
   * copy of someone's space; withdrawing hosting is a matter of no longer
   * serving, and discarding the data is a separate, deliberate act.
   */
  private async rehost(): Promise<void> {
    if (this.held === null) return;
    const depth = this.options.hostDepth ?? DEFAULT_HOST_DEPTH;
    const before = new Set(this.hosted);
    this.hosted = await this.client.hostLinked(hex(this.options.space), depth);
    for (const id of this.hosted) {
      // **Every hosted space is watched, not only the main one.** Beyond depth
      // 1 the links that matter live in spaces that arrive *after* the walk —
      // a hub holds the middle space before it has any of its events, so its
      // links are not visible until they replicate. Watching only the main
      // space would make deeper hosting work on restart and not before.
      this.watch(id);
      if (!before.has(id) && id !== hex(this.options.space)) {
        this.options.observer?.onActivity?.({
          at: Date.now(),
          channel: 'connection',
          space: id,
          text: `hosting ${id.slice(0, 8)} — linked from the main space`,
        });
      }
    }
  }

  /**
   * Re-run the hosting walk whenever this space changes.
   *
   * Once per space: `onChange` has no dedup of its own, so subscribing again
   * on each pass would add a listener per rehost and turn one fold into a
   * cascade of walks.
   */
  private watch(id: string): void {
    if (this.watching.has(id)) return;
    const space = this.client.entry(id)?.space;
    if (space === undefined) return;
    this.watching.add(id);
    space.onChange(() => void this.rehost());
  }

  /**
   * Tell this peer where a space can be reached (§5.3).
   *
   * The out-of-band half: a share link, a pasted address, an operator who
   * knows. Everything else — announce, query — moves knowledge between peers
   * already in contact, and something has to start that.
   */
  remember(space: string, locator: string): void {
    const parsed = parseLocator(locator);
    if (parsed !== null) this.locators?.remember(space, parsed);
  }

  /** Any space this peer holds, by id. Null if it holds none such. */
  spaceOf(space: string): Space | null {
    return this.client.entry(space)?.space ?? null;
  }

  /** Every space this peer holds: its main space and whatever it hosts. */
  get hosting(): readonly string[] {
    return this.hosted;
  }

  /**
   * A blob from any space this peer holds, or null.
   *
   * Named per space because a hub holds several, and the main space's store is
   * not where a hosted space's content lives.
   */
  async blobOf(space: string, hash: Uint8Array): Promise<Uint8Array | null> {
    return (await this.client.entry(space)?.space.getBlob(hash)) ?? null;
  }

  /**
   * How this peer says it can be reached (§5.2).
   *
   * Empty until it is listening, and empty forever if it never does — which is
   * correct rather than a gap: a peer behind NAT dials out and is reached on
   * the connection it opened.
   *
   * The host is what it was *told* to bind, so `0.0.0.0` becomes nothing: it
   * is a bind address, not somewhere anyone can dial. An operator who wants a
   * dialable address supplies one.
   */
  private selfLocators(): readonly Locator[] {
    const listen = this.options.listen;
    if (listen === undefined || this.listener === null) return [];
    const host = listen.host;
    if (host === undefined || host === '0.0.0.0' || host === '::') return [];
    return [{ kind: 'ws', url: `ws://${host}:${this.listener.port}` }];
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
