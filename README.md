# thing

A peer-to-peer substrate for collaborative applications, running in the browser.
Append-only logs of signed events, replicated between browser peers over WebRTC,
with no server holding the data.

**The design is being rewritten.** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
describes the intended system whole, from no prior context. It is not what the
code in `src/` currently does — see *Status* below.

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **The design.** One document, section-numbered, self-contained. Every section marked Proven / Decided / Open, and everything else defers to it |
| [docs/design/](docs/design/) | How particular decisions were reached, in more depth than a section can hold. Check each one's status line — a design record can be superseded without being wrong |
| [docs/working/](docs/working/) | Live: the build plan, open questions, what building it taught, and what is held for later |
| [docs/archive/](docs/archive/) | Two earlier attempts, superseded. Kept for measurements and scope decisions that should not be made twice |
| [archive/](archive/) | The previous implementation, and the fold prototype. Not built |

Start with `ARCHITECTURE.md`. `docs/working/LEARNINGS.md` is worth reading
before changing anything.

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

**Most of [docs/working/PLAN.md](docs/working/PLAN.md) is done**: the substrate,
the fold, storage, spaces, the sync protocol, multi-writer, the sequence rule, a
headless peer that hosts what its main space links to, and a browser client
through all eight of its stages. The previous implementation is in
[archive/](archive/), kept readable but not built, tested, or imported.

**Next is stage 8, resolution.** A link names a space and carries no address, so
following one needs a way to ask *where is this* — and until that exists, a link
expanded in a browser holds an empty space and fetches nothing. See
[docs/design/LOCATORS.md](docs/design/LOCATORS.md) and §5.3.

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
