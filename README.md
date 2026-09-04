# thing

A peer-to-peer substrate for collaborative applications, running in the browser.
Append-only logs of signed events, replicated between browser peers over WebRTC,
with no server holding the data.

**The design is being rewritten.** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
describes the intended system whole, from no prior context. It is not what the
code in `src/` currently does — see *Status* below.

| Doc | What it is |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **The design.** Self-contained, assumes no prior context. Every section marked Proven / Decided / Open |
| [docs/PLAN.md](docs/PLAN.md) | **The implementation plan** — stages, what each answers, what moves to archive |
| [docs/OPEN.md](docs/OPEN.md) | Open questions. Mutable — changes as questions close |
| [archive/](archive/) | The previous implementation, and the fold prototype. Not built |
| [docs/v1/](docs/v1/) | Archived — the design that came before, and the reasoning behind it |
| [docs/v0/](docs/v0/) | Archived — the original proof of concept |

## The shape of it

Three layers, strictly separated, and the separation is the design:

```
VIEW        draws the state          type-specific · ships over the network
FOLD        events → state           universal · one algorithm · declaration-driven
SUBSTRATE   stores and replicates    payload-blind · never interprets a value
```

A **space** is the unit of everything — identity, sharing, storage, replication.
A space is a log; a log folds into a tree of objects. Every space has the same
structure — objects with attributes, in a `:parent` tree — and what varies is
what an individual object's **body** means: a file, a message, a co-edited
document. A space is an Ed25519 keypair, and an optional second symmetric key
decides who can read it, so **a peer can hold and serve a space it cannot
read.**

## Status

**Stage 0 of [docs/PLAN.md](docs/PLAN.md) is done**: the workspace is scaffolded
and the previous implementation has moved to [archive/](archive/), which is kept
readable but is not built, tested, or imported.

```
packages/core/    events, canonical encoding, signing, the fold   no I/O
packages/net/     protocol, sync, blob transfer, resolution       no platform
packages/store/   storage interface + browser and Node backends
packages/peer/    a peer: core + net + store, wired together
packages/web/     the browser client — WebRTC, UI
packages/node/    the headless peer — WebSockets, CLI
```

The split is enforced rather than intended: `core`, `net`, `store` and `peer`
compile with no DOM and no Node types, so a stray `localStorage` is a compile
error rather than something the headless peer discovers at run time.

**Nothing is owed to what exists.** No data migration, no wire compatibility, no
stored-state compatibility. Old spaces are not readable and are not meant to be.

## Working on it

```
npm install
npm test          # every package
npm run check     # tsc --build: typechecks and enforces the boundary
```

There is no app to run yet — the browser client is stage 7.
