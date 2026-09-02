/**
 * One writer per space, per origin (I23).
 *
 * A space key lives in localStorage, which every same-origin tab shares. Two
 * tabs open on one writer space both `Writer.resume` from the same log, so both
 * hold the same `seq` and `prev` in memory — and both then emit a *different*
 * event at that seq, validly signed. That forks the per-writer hash chain
 * (§3.2), and nothing downstream catches it: signing cannot, because the writer
 * really did sign both, and `checkWriterLamports` looks for a lamport reused
 * across differing seqs rather than the same lamport at the same seq.
 *
 * The fix is local coordination for a local problem. Web Locks are scoped to
 * the origin, so the first tab to open a space takes the lock and writes; later
 * tabs find it taken and open read-only. No protocol, no rendezvous, no
 * coordination with anyone else's machine.
 *
 * **The lock is held, never awaited.** `navigator.locks.request` holds a lock
 * for as long as its callback's promise is unresolved, so a lock meant to last
 * a tab's lifetime is a callback that never resolves. It is released
 * automatically when the tab closes or navigates — verified in Chromium, and it
 * is what the spec requires — so there is no cleanup path that can leak a lock
 * and lock a user out of their own space.
 *
 * **Releasing is asynchronous**, which matters more than it sounds. Settling the
 * callback's promise does not free the lock in the same turn, so a caller that
 * releases and immediately reacquires gets its *own* stale hold rather than a
 * fresh one. The releaser therefore returns a promise that settles once the
 * lock is genuinely gone, and callers that reopen a space must await it.
 *
 * Two devices holding the same exported key still fork, and no lock can prevent
 * that; it is the key-export territory of DESIGN.md §5.4 and wants a different
 * answer.
 */

/** Namespaced so it cannot collide with a lock some other code takes. */
function lockName(spaceId: string): string {
  return `thing:write:${spaceId}`;
}

/**
 * Try to become the writer for a space.
 *
 * Returns a release function when the lock is ours, or null when another tab
 * holds it. Never waits: a caller that blocked here would hang opening a space
 * whose other tab is simply still open, which is the normal case rather than an
 * error.
 */
export type ReleaseLock = () => Promise<void>;

export async function acquireWriteLock(spaceId: string): Promise<ReleaseLock | null> {
  // Absent in older browsers and in non-browser runtimes. Degrading to "you may
  // write" keeps those working exactly as they did; the fork it fails to
  // prevent is the same fork they had before this existed.
  if (typeof navigator === 'undefined' || navigator.locks === undefined) {
    return () => Promise.resolve();
  }

  return new Promise<ReleaseLock | null>((resolve) => {
    // `held` settles when the lock has actually been given up, which is a later
    // turn than when the callback's promise settles.
    const held = navigator.locks.request(
      lockName(spaceId),
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        if (lock === null) {
          resolve(null);
          return; // Not ours: return immediately so nothing is held.
        }
        // Ours: hand back a releaser, then keep the lock by not settling until
        // that releaser is called.
        return new Promise<void>((release) => {
          resolve(() => {
            release();
            return held.then(() => undefined);
          });
        });
      },
    );
  });
}

/** Whether some tab — possibly this one — currently holds a space's write lock. */
export async function isWriteLocked(spaceId: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return false;
  const state = await navigator.locks.query();
  return (state.held ?? []).some((l) => l.name === lockName(spaceId));
}
