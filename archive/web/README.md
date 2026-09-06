# The previous browser client

Kept readable, not built, not tested, not imported. Reference only.

Archived when `packages/web` was rebuilt against the main-space model
(`docs/MAIN-SPACE.md`), alongside the server. The UI in particular is worth
reading: the design tokens and component structure carried real decisions, and
the rebuild should take them rather than start from nothing.

## What changed, and why this could not be adapted

- **A client held a set of spaces, all at once.** `Client.restore()` opened
  everything in the inventory and reconnected each. A client now opens spaces as
  **tabs** — a few at a time, on purpose — and holds no inventory at all.
- **Browsing was acquiring.** Opening a space meant `hold()`, which meant it was
  yours until you forgot it. Following a link now opens a tab and writes
  nothing; *keeping* a space is a separate, deliberate act.
- **Petnames were a store.** `keys.petname(id)` looked up a local map. A
  petname is now a link's `:name`, folded like any other attribute.
- **Locators were a store.** `keys.locator(id)` and `rememberLocator`. Addresses
  are no longer kept per client in a side map — see `docs/LOCATORS.md`.
- **The view model was per-client.** `SpaceStatus` merged what a space *is*
  (writable, forks) with what this client is *doing* (peers connected). Those
  separate now: a space's contents replicate, connection state is ephemeral and
  is not meaningful to replicate at all.

## `writelock.ts` is gone, not moved aside

It existed to stop two tabs sharing one key from writing at the same `seq` —
*"two different events at the same sequence number, both validly signed"*. Per-
process append points (§2.1, PLAN stage 7.6) mean two tabs mint separate points
and extend separate chains, so there is nothing to contend for. The hazard it
prevented cannot occur.

Kept here because the reasoning is worth reading: it documents the fork hazard
precisely, and it is where the append-point work started.

## What was *not* archived, and why

Four files stayed in `packages/web/src`, because they are capability
implementations rather than client logic — what the engine is handed, and
unchanged by the model:

- `idbstore.ts` — a `Store` over IndexedDB, passing the same 22-case conformance
  suite as the filesystem backend.
- `webrtc.ts` — data channels wrapped as a `Connection`.
- `signalling.ts` — the rendezvous interface and its one implementation.
- `local.ts` — the keyring, against the shared contract. Its inventory and
  locator implementations survive the move but the model no longer asks a
  browser for either; see `docs/MAIN-SPACE.md`.
