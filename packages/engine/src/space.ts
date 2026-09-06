/**
 * An open space: a log, its folded state, and a way to write to it.
 *
 * This is the seam where a peer stops being a library. `core` computes, `store`
 * persists, and this holds the two together and keeps them consistent: every
 * event that reaches storage also reaches the fold, and nothing reaches the
 * fold that storage refused.
 *
 * **The fold is not persisted.** It is recomputed from the log on open and
 * advanced incrementally thereafter (ARCHITECTURE.md §11: events are the truth,
 * everything else is cache). A peer that restarts replays and gets identical
 * state, which `folder.test.ts` checks over generated histories.
 */
import {
  type Event,
  Folder,
  type Hash,
  hex,
  type KeyPair,
  type PublicKey,
  resumeFrom,
  ROOT,
  type State,
  type Uuid,
  Writer,
} from './core/index.js';
import type { AppendResult, SpaceStore, VersionVector } from './store/index.js';
import {
  addModerator,
  addWriter,
  mayWrite,
  type MembershipChange,
  moderators,
  removeModerator,
  removeWriter,
  writers,
} from './members.js';

/** What a space needs to exist. */
export interface SpaceOptions {
  /** The space's public key: its identity, and the sole authority over the root. */
  readonly key: PublicKey;
  /** This peer's writing key, absent for a read-only replica. */
  readonly writer?: KeyPair;
  /**
   * Where `wall` comes from.
   *
   * Injected rather than read from a clock, so a caller can make writes
   * reproducible. `wall` is display-only and resolves nothing (§2.1).
   */
  readonly now?: () => number;
}

/** Emitted after every change, so a view can redraw without polling. */
export type ChangeListener = (state: State) => void;

export class Space {
  private readonly folder: Folder;
  private readonly listeners = new Set<ChangeListener>();
  private writerState: Writer | null = null;
  private closed = false;

  private constructor(
    private readonly store: SpaceStore,
    private readonly options: SpaceOptions,
  ) {
    this.folder = new Folder(options.key);
  }

  /**
   * Open a space over a store, replaying its log.
   *
   * The replay is the only full fold: everything afterwards is incremental.
   */
  static async open(store: SpaceStore, options: SpaceOptions): Promise<Space> {
    const space = new Space(store, options);

    const events: Event[] = [];
    for await (const e of store.readAll()) events.push(e);
    space.folder.apply(events);

    if (options.writer !== undefined) {
      // Open a *new* append point rather than resuming an old one (§2.1). Which
      // of this identity's chains a previous process was on is not knowable
      // here, and guessing wrong is the fork this design removes. What must
      // carry over is the Lamport clock, which `resumeFrom` takes from the
      // events and `observe` then raises past everything else in the log.
      const own = events.filter((e) => hex(e.writer) === hex(options.writer!.publicKey));
      space.writerState = new Writer(options.key, options.writer, resumeFrom(options.key, own));
      space.writerState.observe(events);
    }

    return space;
  }

  get id(): string {
    return this.store.space;
  }

  /** The current folded state. */
  get state(): State {
    return this.folder.state;
  }

  /** Whether this peer can write. False for a replica with no key. */
  get writable(): boolean {
    return this.writerState !== null;
  }

  /**
   * Whether this space's writer is actually admitted (§7.2.1).
   *
   * Distinct from `writable`, which only asks whether a key is held. A key that
   * is not in the writer set signs events that every peer will store and no
   * peer will fold — which looks like working and is not, so it is worth being
   * able to ask before writing rather than after.
   */
  get admitted(): boolean {
    const writer = this.options.writer;
    if (writer === null || writer === undefined) return false;
    return mayWrite(this.state, this.options.key, writer.publicKey);
  }

  /* ── membership (§7.2) ────────────────────────────────────────────────── */

  /** Everyone who may write, or null if no set is declared (admits everyone). */
  get writers(): readonly string[] | null {
    return writers(this.state, this.options.key);
  }

  /** Writers marked as moderators (§7.2.2). */
  get moderators(): readonly string[] {
    return moderators(this.state, this.options.key);
  }

  /**
   * Add a writer. Returns the event, or null if they could already write.
   *
   * **Only the space key can do this**, and a caller holding any other key gets
   * an event every peer will drop (§7.2.1). That is checked here rather than
   * left to fail silently at the fold.
   */
  async addWriter(who: PublicKey): Promise<Event | null> {
    return this.changeMembership(addWriter(this.state, this.options.key, who));
  }

  /**
   * Remove a writer. Their existing events remain and keep folding (§7.2.3):
   * removal means "may no longer write", never "was never here".
   */
  async removeWriter(who: PublicKey): Promise<Event | null> {
    return this.changeMembership(removeWriter(this.state, this.options.key, who));
  }

  async addModerator(who: PublicKey): Promise<Event | null> {
    return this.changeMembership(addModerator(this.state, this.options.key, who));
  }

  async removeModerator(who: PublicKey): Promise<Event | null> {
    return this.changeMembership(removeModerator(this.state, this.options.key, who));
  }

  private async changeMembership(change: MembershipChange | null): Promise<Event | null> {
    if (change === null) return null;
    const writer = this.options.writer;
    if (writer === undefined || hex(writer.publicKey) !== hex(this.options.key)) {
      throw new Error('only the space key may change membership (§7.2.1)');
    }
    return this.write(ROOT, change.attr, change.value);
  }

  /**
   * Take in events from anywhere — a peer, a file, this process.
   *
   * Storage verifies and admits; only what it accepted reaches the fold. That
   * ordering is the invariant: the fold never sees an event the log does not
   * hold, so a restart cannot produce different state.
   */
  async receive(events: readonly Event[]): Promise<AppendResult> {
    this.assertOpen();
    const result = await this.store.append(events);
    if (result.appended.length > 0) {
      this.folder.apply(result.appended);
      this.writerState?.observe(result.appended);
      this.emit();
    }
    return result;
  }

  /**
   * Fold events that are already in the log.
   *
   * For a caller that appended them itself — a sync session, which must write
   * to storage before acknowledging anything (§2.3), and then needs the fold to
   * catch up. Going through `receive` would refuse them as duplicates and fold
   * nothing, which is the correct behaviour for *new* events and the wrong one
   * here.
   *
   * Safe because folding is idempotent: an event folded twice changes nothing.
   */
  absorb(events: readonly Event[]): void {
    // A connection can deliver events while the space is closing, and there is
    // nothing wrong with that: the events are already in the log, so dropping
    // the *fold* of them loses nothing — reopening replays them. Throwing here
    // would turn an ordinary shutdown race into an unhandled rejection.
    if (this.closed || events.length === 0) return;
    this.folder.apply(events);
    this.writerState?.observe(events);
    this.emit();
  }

  /**
   * Write one event: mint, sign, append, fold.
   *
   * Goes through `receive`, so a local write takes exactly the same path as a
   * remote one — including verification. A writer that produced an invalid
   * event should find that out here, not when a peer rejects it.
   */
  async write(target: Uuid, attr: string, value: Uint8Array): Promise<Event> {
    this.assertOpen();
    const writer = this.writerState;
    if (writer === null) throw new Error('space is not writable: no writing key');

    const wall = (this.options.now ?? Date.now)();
    const event = await writer.write(target, attr, value, wall);

    const result = await this.receive([event]);
    if (result.appended.length === 0) {
      const why = result.rejected[0]?.why.kind ?? 'unknown';
      throw new Error(`a freshly minted event was rejected: ${why}`);
    }
    return event;
  }

  /** Store bytes, returning the hash a `:body` should name (§2.4). */
  putBlob(bytes: Uint8Array): Promise<Hash> {
    this.assertOpen();
    return this.store.putBlob(bytes);
  }

  getBlob(hash: Hash): Promise<Uint8Array | null> {
    this.assertOpen();
    return this.store.getBlob(hash);
  }

  /** What this peer knows, for reconciliation (§2.3). */
  versionVector(): Promise<VersionVector> {
    this.assertOpen();
    return this.store.versionVector();
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.store.close();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.folder.state;
    for (const listener of this.listeners) listener(state);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('space is closed');
  }
}
