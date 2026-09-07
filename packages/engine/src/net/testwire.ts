/**
 * Fake transports, for testing the protocol without a network.
 *
 * **Two layers, because there are two things to fake**, and using the wrong one
 * is how a test ends up measuring its own harness:
 *
 * - `channelPair` is a pair of `Channel`s driven by hand. The test owns the
 *   clock: nothing moves until `settle()` is called, which delivers until
 *   quiescent. Right for `Session`, where the interesting cases are multi-round
 *   exchanges and you want to inspect the state between them.
 * - `connectionPair` is a pair of `Connection`s that deliver themselves. Right
 *   for anything above `Session` — a `Client` holding spaces — where the point
 *   is that syncing happens without the test arranging it.
 *
 * This file exists because both were written separately, months apart, and the
 * second one got the delivery discipline wrong in a way that cost real time to
 * diagnose. The rules below are the whole reason to have one copy.
 *
 * ## Three rules a fake transport must follow
 *
 * **1. Never deliver inside `send`.** A real transport always yields first. A
 * `Session` that saw its own frames arrive re-entrantly would be tested against
 * conditions it never meets.
 *
 * **2. Deliver one frame at a time, in order.** A socket does. `Session.receive`
 * is asynchronous and reads the store *before* appending, so two overlapping
 * deliveries can both see the same event as new and report it twice. A test
 * built on that measures the fake rather than the code — this is the bug that
 * motivated the file.
 *
 * **Rule 2 needs the handler's cooperation, which is the subtle part.**
 * `onFrame` is typed to return `void`, so a handler written the ordinary way —
 * `conn.onFrame((d) => void session.receive(d))`, which is exactly what the
 * real client does — drops the promise and leaves this file nothing to await.
 * Frames then overlap however carefully the queue here is written. A test that
 * needs strict ordering must return the promise from its handler;
 * `testwire.test.ts` demonstrates both halves.
 *
 * This is not a flaw in the fake. Production is genuinely fire-and-forget, and
 * the resulting overlap is real: a peer may send one range twice
 * (reconciliation on HELLO, then answering a WANT), and the store deduplicates
 * so nothing breaks. What must not happen is a *test* concluding something
 * about the client from an artifact of its harness.
 *
 * **3. Copy the frame.** `send` may hand over a buffer its caller intends to
 * reuse, so holding the original means delivering whatever it later became.
 */
import type { Channel } from './blobs.js';
import type { Session } from './session.js';

/* ── the Channel layer: the test drives delivery ────────────────────────── */

/**
 * Two channels whose traffic the test delivers by hand.
 *
 * Assign `a` and `b` before calling `settle`.
 */
export class ChannelPair {
  private toA: Uint8Array[] = [];
  private toB: Uint8Array[] = [];
  a!: Session;
  b!: Session;

  channelFor(side: 'a' | 'b'): Channel {
    const queue = side === 'a' ? this.toB : this.toA;
    return {
      send: (frame) => queue.push(frame.slice()),
      get bufferedAmount() {
        return 0;
      },
    };
  }

  /**
   * Deliver until nothing is left to deliver.
   *
   * The limit is a stuck-protocol detector, not a timeout: an exchange that has
   * not quiesced in this many rounds is looping, and failing loudly beats a
   * test that passes because it gave up.
   */
  async settle(limit = 100): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const a = this.toA.splice(0);
      const b = this.toB.splice(0);
      if (a.length === 0 && b.length === 0) return;
      for (const f of a) await this.a.receive(f);
      for (const f of b) await this.b.receive(f);
    }
    throw new Error('exchange did not settle');
  }
}

export function channelPair(): ChannelPair {
  return new ChannelPair();
}

/* ── the Connection layer: delivery happens on its own ──────────────────── */

/** What a `Connection` needs, without importing the client layer. */
interface ConnectionLike {
  readonly peer: string;
  readonly channel: Channel;
  onFrame(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface FakeConnection extends ConnectionLike {
  /** Push a frame in as though it arrived. */
  deliver(data: Uint8Array): Promise<void>;
  /** Run the close handlers on this side only. */
  fireClose(): void;
  /**
   * How many handlers are registered.
   *
   * Exposed because "exactly one owner of delivery" is a real invariant and an
   * invisible one: a second handler makes every frame process twice, which the
   * store deduplicates, so nothing fails — it just does the work twice.
   */
  readonly handlers: { frames: number; closes: number };
  /**
   * Hold frames from this endpoint until `release` is called.
   *
   * For asserting that a caller *waited* rather than merely that it eventually
   * arrived. On a fake transport delivery is fast enough that a test which
   * checks state after a call passes whether or not the call waited — the race
   * is always won. Stalling makes the difference observable without depending
   * on timing at all: while stalled the peer cannot have the events, so
   * anything that claims otherwise is wrong.
   */
  stall(): void;
  release(): Promise<void>;
}

function endpoint(name: string): FakeConnection & { link(peer: FakeConnection): void } {
  const frames: ((data: Uint8Array) => void)[] = [];
  const closes: (() => void)[] = [];
  let other: FakeConnection | null = null;
  /** Rule 2: one frame at a time, in order. */
  let queue: Promise<void> = Promise.resolve();
  /** Frames held back by `stall`, in send order. */
  let stalled: Uint8Array[] | null = null;

  const self = {
    peer: name,
    channel: {
      send(frame: Uint8Array): void {
        const copy = frame.slice(); // rule 3
        if (stalled !== null) {
          stalled.push(copy);
          return;
        }
        // rule 1: a turn later, never inside `send`.
        queue = queue.then(async () => {
          await other?.deliver(copy);
        });
      },
      bufferedAmount: 0,
    },
    onFrame(handler: (data: Uint8Array) => void): void {
      frames.push(handler);
    },
    onClose(handler: () => void): void {
      closes.push(handler);
    },
    close(): void {
      self.fireClose();
      other?.fireClose();
    },
    async deliver(data: Uint8Array): Promise<void> {
      // Handlers may be async; awaiting each keeps one frame from overtaking
      // the one before it.
      for (const handler of frames) await handler(data);
    },
    fireClose(): void {
      for (const handler of closes) handler();
    },
    get handlers() {
      return { frames: frames.length, closes: closes.length };
    },
    link(peer: FakeConnection): void {
      other = peer;
    },
    stall(): void {
      stalled ??= [];
    },
    async release(): Promise<void> {
      const held = stalled ?? [];
      stalled = null;
      // In order, one at a time — rule 2 still applies to what was held.
      for (const frame of held) {
        queue = queue.then(async () => {
          await other?.deliver(frame);
        });
      }
      await queue;
    },
  };
  return self;
}

/** Two connections wired to each other, delivering on their own. */
export function connectionPair(
  nameA = 'a',
  nameB = 'b',
): [FakeConnection, FakeConnection] {
  const a = endpoint(nameA);
  const b = endpoint(nameB);
  a.link(b);
  b.link(a);
  return [a, b];
}

/**
 * Wait until something is true, rather than for a fixed number of turns.
 *
 * A fixed count passes on a fast machine and fails on a slow one, which is the
 * kind of test that fails once a fortnight and gets rerun rather than read.
 */
export async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the exchange to settle');
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
  }
}
