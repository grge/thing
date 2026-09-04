/**
 * Trust on first use (ADDRESSING.md §5.5).
 *
 * A typed share code is a rendezvous hint, not an identity — it carries no
 * authority, so an impostor can claim the slot and answer you. Opening a *link*
 * closes that gap outright, because the link carries the key. This module
 * closes it for the typed path the only way that path allows: on first
 * successful join, pin whatever key actually answered against the handle the
 * user typed, and refuse a different one later.
 *
 * That is SSH's model. An impostor can fool someone **once**, on a typed code,
 * for a space they have never visited — and never again, and never for a space
 * they already know.
 *
 * A mismatch is deliberately not self-healing: the caller is expected to stop
 * and tell the user, not to re-pin. Re-pinning on mismatch would make the pin
 * decorative.
 */
import type { SpaceId } from './address.js';

const PINS_KEY = 'thing:pins';

/** handle (a typed code) -> the space id that answered it first. */
type Pins = Record<string, SpaceId>;

function load(): Pins {
  const raw = localStorage.getItem(PINS_KEY);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as Pins;
  } catch {
    console.error('pin store is unreadable');
    return {};
  }
}

function save(p: Pins): void {
  localStorage.setItem(PINS_KEY, JSON.stringify(p));
}

export function pinnedFor(handle: string): SpaceId | null {
  return load()[handle] ?? null;
}

export type PinResult =
  | { readonly ok: true; readonly first: boolean }
  /** The handle is already pinned to a different key. Do not proceed. */
  | { readonly ok: false; readonly expected: SpaceId; readonly got: SpaceId };

/**
 * Check a key against what this handle resolved to before, pinning it if this
 * is the first time. Idempotent for a matching key.
 */
export function checkOrPin(handle: string, id: SpaceId): PinResult {
  const pins = load();
  const existing = pins[handle];
  if (existing === undefined) {
    pins[handle] = id;
    save(pins);
    return { ok: true, first: true };
  }
  if (existing !== id) return { ok: false, expected: existing, got: id };
  return { ok: true, first: false };
}

/** Drop a pin. For when the user has decided the new key is the real one. */
export function unpin(handle: string): void {
  const pins = load();
  delete pins[handle];
  save(pins);
}
