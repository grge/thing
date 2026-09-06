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
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | What building this taught, for whenever the design is rewritten again |
| [docs/CLIENTS.md](docs/CLIENTS.md) | How the CLI, TUI and browser relate to a running peer — the engine's API as the only way in |
| [docs/APPEND-POINTS.md](docs/APPEND-POINTS.md) | Splitting `writer` into an identity and a per-process append point: the trace, and the decisions |
| [docs/EQUIVOCATION.md](docs/EQUIVOCATION.md) | Literature review — why per-writer sequence numbers force one writer per key |
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

**Stages 0–7.5 of [docs/PLAN.md](docs/PLAN.md) are done**: the substrate, the
fold, storage, a space, the sync protocol, a headless peer, a browser client,
and one shared implementation of being a peer. The previous implementation is in
[archive/](archive/), kept readable but not built, tested, or imported.

Next is stage 7.6, which changes the event envelope — see
[docs/APPEND-POINTS.md](docs/APPEND-POINTS.md).

```
packages/engine/  the peer, platform-agnostic
  core/             events, canonical encoding, signing, the fold
  store/            where events live — an interface, and its contract
  net/              protocol, sync, blob transfer, the ephemeral channel
  fs/               the filesystem model over the fold
  client/           holding many spaces, and the connections between them
packages/node/    disk, sockets, CLI — supplies what the engine needs
packages/web/     IndexedDB, WebRTC, Svelte — likewise
```

The engine is the program: it holds spaces, folds their logs, reconciles with
other peers. It reaches for nothing — storage, connections and somewhere to keep
keys are *supplied to it*, because the same code runs in a browser tab and in a
headless server, and those differ in exactly those places and nowhere else.

That is enforced rather than intended: the engine compiles with `"types": []`
and an ES2022-only `lib`, so a stray `localStorage` is a compile error rather
than something a server discovers at run time.

**Nothing is owed to what exists.** No data migration, no wire compatibility, no
stored-state compatibility. Old spaces are not readable and are not meant to be.

## Working on it

```
npm install
npm test          # every package
npm run check     # tsc --build: typechecks and enforces the boundary
```

There is no app to run yet — the browser client is stage 7.
