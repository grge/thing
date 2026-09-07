/**
 * Who may write to a space, and who moderates (ARCHITECTURE.md §7.2).
 *
 * The fold already *enforces* this — `writerSetFrom` reads the root's
 * `:writers`, phase 2 admits only those writers (§7.2.1). What lives here is
 * the other half: reading the membership as something a person can be shown,
 * and changing it.
 *
 * **Only the space key can change it.** Root events are admitted on a signature
 * from the space key alone, which is what breaks the circularity of "to know
 * who may write, fold the log; to fold the log, know who may write" (§7.2).
 * Everything in this file therefore either reads the fold, or writes the root
 * and will be silently dropped unless the caller holds the space key.
 *
 * **Moderators hold their own keys and never the space key** (§7.2.2). Sharing
 * the space key to get several administrators would fork the one chain that
 * decides who may write. A moderator is an ordinary writer with an attribute,
 * so their actions stay attributable — *Alice removed Bob*, not *Bob was
 * removed*.
 */
import { hex, type PublicKey, type State, writerSetFrom } from './core/index.js';

/** The root attribute naming who may write (§7.2.1). */
export const WRITERS = ':writers';

/** The root attribute naming which of those writers moderate (§7.2.2). */
export const MODERATORS = ':moderators';

const UTF8 = new TextEncoder();

/**
 * A comma-separated list of writer keys.
 *
 * The encoding is deliberately dull: a register holding a string, folded by the
 * same rule as `:name`. §7.4 leaves open whether membership should instead be
 * add/remove operations — see `openQuestions` in this file's tests and
 * `docs/working/OPEN.md` question 7.
 */
function parseList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').filter((s) => s.length > 0);
}

function formatList(keys: Iterable<string>): string {
  // Sorted, so that two clients computing the same membership produce the same
  // bytes. Nothing depends on the order, and a stable one makes a diff legible.
  return [...new Set(keys)].sort().join(',');
}

/**
 * Everyone who may write, as the fold sees it.
 *
 * An empty result means **no set is declared**, which admits everyone — the
 * single-writer case, where the space key is the only writer and a set would be
 * ceremony. `writers()` returning `null` and returning `[spaceKey]` are
 * different states, and the difference is visible to a person, so it is not
 * flattened here.
 */
export function writers(state: State, space: PublicKey): readonly string[] | null {
  const set = writerSetFrom(state.root, hex(space));
  return set === null ? null : [...set].sort();
}

/** Whether a key may write anything but the root. */
export function mayWrite(state: State, space: PublicKey, who: PublicKey): boolean {
  const set = writerSetFrom(state.root, hex(space));
  return set === null || set.has(hex(who));
}

/**
 * Writers marked as moderators (§7.2.2).
 *
 * A moderator is an ordinary writer with an attribute. Being listed here grants
 * nothing the fold enforces — moderator *actions* are ordinary events on
 * ordinary objects, and whatever consumes them checks this list. The substrate
 * deliberately has no opinion about what moderating means.
 */
export function moderators(state: State, space: PublicKey): readonly string[] {
  const declared = parseList(state.root.get(MODERATORS)?.value);
  const may = writerSetFrom(state.root, hex(space));
  // A moderator who is no longer a writer is not a moderator. Otherwise
  // removing someone from the writer set would leave them moderating.
  return declared.filter((k) => may === null || may.has(k)).sort();
}

export function isModerator(state: State, space: PublicKey, who: PublicKey): boolean {
  return moderators(state, space).includes(hex(who));
}

/** What a membership change looks like, before it is written. */
export interface MembershipChange {
  readonly attr: typeof WRITERS | typeof MODERATORS;
  readonly value: Uint8Array;
}

/**
 * The event body that adds a writer, or null if they are already one.
 *
 * Returned rather than written, because writing needs a `Space` and this
 * package's lower layers have no I/O. `Space.addWriter` is the ordinary way in.
 *
 * **A whole-list register, not an operation** (§7.4). The list is recomputed
 * from the current fold and written entire, so two concurrent changes do not
 * merge — the later one wins and the earlier one's addition is lost. That is a
 * real cost and it grew with per-process append points, since one identity can
 * now write the root from two processes at once. It is accepted for now because
 * the alternative reintroduces the circularity §7.2.1 closes: an add/remove
 * operation needs causal context, and root events must stay self-authorising.
 */
export function addWriter(
  state: State,
  space: PublicKey,
  who: PublicKey,
): MembershipChange | null {
  const current = writerSetFrom(state.root, hex(space));
  const key = hex(who);
  // No declared set means everyone may write; naming one writer *narrows* that
  // to exactly them plus the space key, which is a change worth making.
  if (current !== null && current.has(key)) return null;
  const next = new Set(current ?? []);
  next.add(key);
  return { attr: WRITERS, value: UTF8.encode(formatList(next)) };
}

/**
 * The event body that removes a writer, or null if they are not one.
 *
 * **Removal means "may no longer write", never "was never here"** (§7.2.3).
 * Their existing events stay in the log, validly signed, and keep folding. A
 * design that unwrote them would make what a peer computes depend on when it
 * heard about the removal, which is a fork manufactured by the security
 * mechanism itself.
 */
export function removeWriter(
  state: State,
  space: PublicKey,
  who: PublicKey,
): MembershipChange | null {
  const current = writerSetFrom(state.root, hex(space));
  const key = hex(who);
  if (current === null || !current.has(key)) return null;
  // The space key cannot be removed: it is the authority the set derives from,
  // so removing it would mean the set no longer had anyone able to change it.
  if (key === hex(space)) return null;
  const next = new Set(current);
  next.delete(key);
  return { attr: WRITERS, value: UTF8.encode(formatList(next)) };
}

/** Mark a writer as a moderator (§7.2.2). They must already be a writer. */
export function addModerator(
  state: State,
  space: PublicKey,
  who: PublicKey,
): MembershipChange | null {
  if (!mayWrite(state, space, who)) return null;
  const current = moderators(state, space);
  const key = hex(who);
  if (current.includes(key)) return null;
  return { attr: MODERATORS, value: UTF8.encode(formatList([...current, key])) };
}

export function removeModerator(
  state: State,
  space: PublicKey,
  who: PublicKey,
): MembershipChange | null {
  const current = moderators(state, space);
  const key = hex(who);
  if (!current.includes(key)) return null;
  return {
    attr: MODERATORS,
    value: UTF8.encode(formatList(current.filter((k) => k !== key))),
  };
}
