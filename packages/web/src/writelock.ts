/**
 * One writer per space, per browser (ARCHITECTURE.md §7.3).
 *
 * A key in browser storage is shared by every same-origin tab. Two tabs opening
 * one space both resume from the same log, both hold the same `seq` and `prev`,
 * and both write — producing **two different events at the same sequence
 * number, both validly signed**. Signing cannot catch it, because the key
 * genuinely signed both.
 *
 * §7.3 resolves such a fork deterministically, so the network still converges,
 * but one branch's writes are dropped. That is worth avoiding when it is this
 * cheap to avoid: within one browser the tabs can simply agree, and the Web
 * Locks API is exactly that agreement. Across devices nothing can prevent it,
 * which is why the resolution exists.
 *
 * Two details, both learned from the API rather than assumed:
 *
 * - **A held lock is a callback that never settles**, and the browser releases
 *   it when the tab closes. There is no cleanup path that can leak a lock and
 *   shut a user out of their own space.
 * - **Releasing is asynchronous.** Settling the callback does not free the lock
 *   in the same turn, so a caller that closes and immediately reopens meets its
 *   own stale hold. `release` is therefore awaitable.
 */

export interface WriteLock {
  /** True if this tab may write. */
  readonly held: boolean;
  release(): Promise<void>;
}

/** A lock nobody holds: for a replica, or a runtime without the API. */
const NOT_HELD: WriteLock = {
  held: false,
  release: async () => {},
};

/**
 * Try to become the writing tab for a space.
 *
 * Returns immediately: a tab that cannot have the lock opens read-only rather
 * than waiting, because waiting would leave a user staring at a space that
 * never loads.
 */
export async function acquireWriteLock(space: string): Promise<WriteLock> {
  const locks = navigator.locks;
  if (locks === undefined) return NOT_HELD;

  let releaseNow: (() => void) | null = null;
  const released = new Promise<void>((resolve) => {
    releaseNow = resolve;
  });

  const granted = await new Promise<boolean>((resolve) => {
    void locks
      .request(`thing:write:${space}`, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          resolve(false);
          return;
        }
        resolve(true);
        // Held until released: the callback is the lock's lifetime.
        await released;
      })
      .catch(() => resolve(false));
  });

  if (!granted) return NOT_HELD;

  return {
    held: true,
    async release(): Promise<void> {
      releaseNow?.();
      // Give the browser a turn to actually free it, so a close-then-reopen
      // does not meet its own stale hold.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
