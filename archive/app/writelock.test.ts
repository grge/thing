/**
 * One writer per space, per origin (I23).
 *
 * These run against the real Web Locks API — Node provides one — so they test
 * the actual semantics rather than a stand-in, including the async release that
 * is the easiest thing to get wrong here.
 */
import { describe, expect, it } from 'vitest';
import { acquireWriteLock, isWriteLocked } from './writelock.js';

/** A fresh id per test, since locks are process-wide and outlive a test. */
let n = 0;
const id = (): string => `lock-test-${n++}`;

describe('write locks', () => {
  it('the first caller gets the lock', async () => {
    const k = id();
    const release = await acquireWriteLock(k);
    expect(release).not.toBeNull();
    expect(await isWriteLocked(k)).toBe(true);
    await release!();
  });

  it('a second caller is refused rather than made to wait', async () => {
    // Waiting would hang opening a space whose other tab is merely still open,
    // which is the normal case rather than an error.
    const k = id();
    const first = await acquireWriteLock(k);
    expect(await acquireWriteLock(k)).toBeNull();
    await first!();
  });

  it('releasing lets the next caller in', async () => {
    const k = id();
    const first = await acquireWriteLock(k);
    await first!();
    const second = await acquireWriteLock(k);
    expect(second).not.toBeNull();
    await second!();
  });

  it('release is not complete until awaited', async () => {
    // The subtle one. Settling the request callback does not free the lock in
    // the same turn, so a caller that releases and immediately reacquires would
    // meet its own stale hold. Awaiting the releaser is what makes reopening a
    // space work.
    const k = id();
    const release = await acquireWriteLock(k);
    const pending = release!();
    expect(await isWriteLocked(k)).toBe(true);
    await pending;
    expect(await isWriteLocked(k)).toBe(false);
  });

  it('locks are per space, not global', async () => {
    const a = id();
    const b = id();
    const ra = await acquireWriteLock(a);
    const rb = await acquireWriteLock(b);
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    await ra!();
    await rb!();
  });

  it('reports an unheld space as unlocked', async () => {
    expect(await isWriteLocked(id())).toBe(false);
  });
});
