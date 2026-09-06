# The previous server

Kept readable, not built, not tested, not imported. Reference only.

Archived when `packages/node` was rebuilt against the main-space model
(`docs/MAIN-SPACE.md`), because the shape changed enough that keeping the old
code risked carrying assumptions that no longer hold.

## What changed, and why this could not be adapted

- **A peer held many spaces.** `Peer` took a directory and held everything in
  it. A server now holds **exactly one** — its main space — and reaches others
  by following links. `PeerOptions.dir` plus `hold()` per space is the old
  shape throughout.
- **Petnames, keys and the space list were separate stores.** They are now
  a link's `:name`, a keyring, and the main space's own contents.
  `FilePetnames` survives; the CLI's key handling and space listing do not.
- **The CLI resolved names against a local index.** `resolveName` over a
  petname file and a directory listing. Resolution is now following a link, or
  §5.3's query — see `docs/LOCATORS.md`.
- **`thing join <key> <url>` acquired a space by address.** Addresses are no
  longer how a space is named or found.

## What was *not* archived, and why

Four files stayed in `packages/node/src`, because they are capability
implementations rather than server logic — the things the engine is handed
(`docs/MAIN-SPACE.md`'s "store, transports, keyring") and unchanged by the
model:

- `filestore.ts` — a `Store` over append-only segments, with its conformance
  and durability tests. Passes the same 22-case suite as IndexedDB.
- `transport.ts` — WebSocket, both halves, wrapping sockets in a `Connection`.
- `local.ts` — the keyring, inventory and locator cache, against the shared
  contract.
- `petnames.ts` — `PetnameStore`, whose interface is in the engine.

Plus `boundary.test.ts`, which is not server code at all: it guards the
*engine's* platform split and lives here only because it reads files, which the
package it checks cannot do. Archiving it would have silently dropped that
guard.
