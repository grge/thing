/**
 * The locator cache's logic, once (§5.3).
 *
 * Both backends store a JSON blob and differ only in *where*, so the ranking —
 * which is the part with decisions in it — lives here and each supplies a
 * `load`/`save` pair.
 *
 * **The order is what makes this useful.** §5.3's "first tried, first
 * discarded" is a claim about ordering, and a cache with one entry per space
 * cannot express it. What is kept per candidate is the last time it worked and
 * how many times it has failed since, which is enough to answer *try this one
 * first* without pretending to model the network.
 */
import { type Locator, locatorKey, parseLocator } from './net/locator.js';
import type { SpaceId } from './store/index.js';

/** One candidate, with what this client knows about using it. */
export interface Attempt {
  readonly locator: Locator;
  /** When it last worked, or 0 if it never has. */
  readonly worked: number;
  /** Failures since it last worked. Reset on success. */
  readonly failures: number;
}

/**
 * How many candidates to keep per space.
 *
 * Bounded because a space announced by many peers would otherwise accumulate
 * one entry per peer forever, and because the point of the list is to try a few
 * things quickly rather than to be a directory. Unmeasured — §5.3 says these
 * numbers belong in a measurement against a real network, and this is a
 * starting value, not a finding.
 */
export const KEEP_PER_SPACE = 8;

/**
 * Failures before a candidate that has *never* worked is dropped.
 *
 * One that has worked before is kept regardless: a peer that is merely offline
 * should not be forgotten, which is the difference between "this address is
 * wrong" and "nobody is home right now".
 */
export const DROP_AFTER = 3;

/** Best first: what worked most recently, then what has failed least. */
export function rank(a: Attempt, b: Attempt): number {
  if (a.worked !== b.worked) return b.worked - a.worked;
  return a.failures - b.failures;
}

export type Stored = Record<SpaceId, Attempt[]>;

/**
 * The cache logic over a plain object, which a backend persists.
 *
 * Mutates in place and calls `save` after every change, because the alternative
 * — batching writes — means a client that closes mid-session forgets where it
 * just connected, which is the one thing this exists to prevent.
 */
export class Locators {
  constructor(
    private readonly state: Stored,
    private readonly save: (state: Stored) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get(space: SpaceId): readonly Locator[] {
    return this.attempts(space).map((a) => a.locator);
  }

  /**
   * Every candidate with what is known about it — for a debug view.
   *
   * **Tolerates whatever is on disk.** This cache is persisted by the client
   * and an earlier version stored one URL string per space; a client that
   * upgrades finds those still there. Reading them as a lone candidate that
   * has never been tried is better than either crashing — which is what a
   * bare `.map` did — or silently dropping an address someone typed.
   */
  attempts(space: SpaceId): readonly Attempt[] {
    const held: unknown = this.state[space];
    if (Array.isArray(held)) return held as Attempt[];
    if (typeof held === 'string') {
      const l = parseLocator(held);
      return l === null ? [] : [{ locator: l, worked: 0, failures: 0 }];
    }
    return [];
  }

  remember(space: SpaceId, locator: Locator): void {
    const list = [...this.attempts(space)];
    // Known already: leave its history alone. Hearing about a locator again is
    // not evidence that it works, and overwriting would discard the failures
    // that had sunk it.
    if (list.some((a) => locatorKey(a.locator) === locatorKey(locator))) return;
    this.state[space] = trim([...list, { locator, worked: 0, failures: 0 }]);
    this.save(this.state);
  }

  succeeded(space: SpaceId, locator: Locator): void {
    const key = locatorKey(locator);
    const list = this.attempts(space).filter((a) => locatorKey(a.locator) !== key);
    this.state[space] = trim([{ locator, worked: this.now(), failures: 0 }, ...list]);
    this.save(this.state);
  }

  failed(space: SpaceId, locator: Locator): void {
    const key = locatorKey(locator);
    const list = this.attempts(space).map((a) =>
      locatorKey(a.locator) === key ? { ...a, failures: a.failures + 1 } : a,
    );
    // Drop only what has never worked. A locator that worked once and is now
    // failing is a peer that may come back; one that has only ever failed is a
    // wrong guess, and keeping it costs a dial timeout every reconnect.
    this.state[space] = trim(list.filter((a) => a.worked > 0 || a.failures < DROP_AFTER));
    this.save(this.state);
  }

  forget(space: SpaceId): void {
    delete this.state[space];
    this.save(this.state);
  }
}

function trim(list: Attempt[]): Attempt[] {
  return [...list].sort(rank).slice(0, KEEP_PER_SPACE);
}
