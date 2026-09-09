# Implementation plan

The route from [ARCHITECTURE.md](../ARCHITECTURE.md) to a running system, in stages
that each land green and each answer something.

Two rules throughout:

- **Every stage ends with the tree building, tests passing, and the app in a
  usable state.** No stage leaves a half-migrated codebase behind.
- **Details are decided at the stage that needs them**, not now. Where a stage
  has an open decision, it is named in that stage rather than guessed at here.

---

## What is being built

A peer-to-peer substrate where a **space** is a log of signed events folding into
a tree of objects, replicated between browsers over WebRTC and between browsers
and **headless peers** over WebSockets. The headless peer is in scope from the
start, not bolted on: §5.6 says a peer with a stable address is not a new kind of
participant, and the only way to keep that true is to build it alongside.

Two clients, one protocol. Where they differ is reachability and storage, and
both differences are behind interfaces.

---

## Migration: what moves to archive

The current tree implements the previous design. It moves to `archive/` whole, in
one commit, before anything new is written. Nothing is deleted, nothing is
migrated in place, and no new code imports from it.

```
archive/            what src/ is today — kept readable, not built, not tested
packages/
  engine/           the peer, platform-agnostic — reaches for nothing
    core/             events, canonical encoding, signing, the fold
    store/            where events live — an interface, and its contract
    net/              protocol, sync, blob transfer, the ephemeral channel
    fs/               the filesystem model over the fold
    client/           holding many spaces, and the connections between them
  node/             disk, sockets, CLI — supplies what the engine needs
  web/              IndexedDB, WebRTC, Svelte — likewise
```

**This started as six packages and is now three.** `core`, `net`, `store` and
`peer` were separate until stage 7.5; nothing imported a subset of them, nothing
was published, and the split cost more than it bought — `peer` looked like a real
boundary, so nobody noticed it had stopped one level short of its own doc
comment, and the multi-space client it described grew independently in `node`
and `web` until it was the same 300 lines twice.

What matters is the line between **platform-free and platform-bound**, not the
lines between `core` and `net`. That one is still a package boundary and still
enforced: `engine` compiles with `"types": []` and an ES2022-only `lib`, so a
`localStorage` reference in it is a compile error. The layering inside `engine`
is a reading order, and a directory expresses it fine.

**What is worth borrowing**, having read it: `net/blobtransfer.ts` (its whole
dependency is a two-method `Channel`), `net/protocol.ts`'s framing, `net/sync.ts`
(pure, no I/O), `net/signalling.ts`'s interface shape, `fold/sign.ts`'s dual
backend, and `fold/encode.ts`'s canonical writer. All of it needs revision for
the new envelope; none of it needs reinvention.

**What is not worth borrowing**: `app/storage.ts` (localStorage-bound and
rewrites the whole log per commit), `fold/fold.ts` (the hardcoded switch this
design replaces), and the UI, which follows the new state shape.

`archive/proto/` is the exception to all of this: it was written against the
*current* architecture rather than the previous one, and it is the fold's
reference implementation. Its tests carry into stage 2 nearly unchanged.

---

**A note on stage names.** Stages 1–5 were built when `core`, `store`, `net` and
`peer` were separate packages. They are now directories inside `engine`
(stage 7.5), and the stage headings say `engine/core` and so on to match the
tree as it is. What each stage built is unchanged.

## Stage 0 — Scaffold and archive

Move `src/` and `proto/` to `archive/`. Set up the workspace, TypeScript project
references, one test runner across packages, and CI. Write the property-test
helpers, because every later stage leans on them.

**Done when:** `npm test` runs green over an empty-but-wired workspace, the
archived tree is untouched and unbuilt, and **the platform boundary is enforced
by the compiler** — the platform-free packages build with `"types": []` and an
ES2022-only `lib`, so a `localStorage` reference in any of them is a compile
error. (Four packages then, `engine` now; the boundary is the same line.)

**Done.** The boundary is asserted by a test over the tsconfigs as well, since
widening `types` to fix one import would otherwise silently lose the property.

---

## Stage 1 — `engine/core`: events, encoding, signing

The envelope (§2.1) and the two things that must be right before any log exists.

- Event type; canonical encoding with fixed tags, length prefixes, no floats.
- **The space key in the signed preimage** (§2.1). Not optional and not later.
- **Signing is domain-separated and generic** (§2.1). The primitive is
  `sign(tag, preimage, key)`, with the event's preimage construction as *one
  caller*, not the only shape the module knows. The ephemeral channel signs
  things too (§10.2), and a narrow `signEvent` would have to be refactored at
  stage 5 with tests already built around it. Establishing the tag registry now
  costs a line and prevents a cross-protocol replay later.
- Ed25519 with the dual backend, seeds stored as raw bytes.
- Event id and `prev` at full SHA-256 width (§2.1).
- Per-writer chain validation; `(lamport, writer)` comparison with a **third
  component on event hash**, so identical `(lamport, writer)` pairs from a forked
  chain still order deterministically (§7.3).

**Values are opaque bytes, and every rule supplies a codec** (§3.2). The
substrate never reads a value and the fold kernel routes bags without inspecting
them; only a rule's codec gives its values meaning. A rule is therefore a codec
*and* a merge, usable independently — which is what lets a log inspector decode
values it cannot fold.

Two consequences for this stage:

- `core` defines no value vocabulary beyond bytes. There is no `Value` union, no
  `Pos`, no `Link` — those were filesystem types, and the rules that want them
  bring their own encodings at stage 2.
- **Body values carry a one-byte rule-version prefix.** Meaningless to the
  substrate, and it is what lets a rule's encoding change later without a flag
  day. Cheap now, impossible to retrofit into logs that already exist.

**Hashing is split by use.** Event ids hash synchronously with a JS SHA-256;
blobs hash asynchronously with WebCrypto where available. The two cases genuinely
differ — an event preimage is a few hundred bytes on a hot path inside a pure
function, while a blob is megabytes at a point that is already asynchronous — and
using one primitive for both would mean either an async fold or slow blob
hashing. An async fold is the worse outcome: §3.6 describes the fold as a pure
function with no I/O, and making it return promises taxes every call site above
it for a computation that never waits on anything.

The cost is two SHA-256 implementations that must agree, which is a test rather
than a risk, and the same shape as the dual-backend signing check.

**Decide here:** the exact preimage byte layout.

**Done when:** two independent encodings of the same event agree byte for byte in
a test, signatures verify across both crypto backends, and a chain with a
fabricated `prev` is rejected.

**Done.** `core` has bytes, hash, domain, sign, event, chain and writer. Three
things worth recording, because each was decided by writing it:

- **A minimal `platform.d.ts`.** `TextEncoder` and WebCrypto are neither DOM nor
  Node — they exist in both runtimes, but ES2022's `lib` declares neither. So
  `core` declares exactly what it needs and nothing more; widening `types` or
  `lib` instead would have brought `localStorage` and `process` with it, and the
  boundary would have been gone.
- **The comparison key is `(lamport, writer, eventId)`.** The third component is
  what makes it a total order: one key on two devices produces two events at the
  same seq and lamport, and without a tiebreak the winner falls back to arrival
  order (§7.3).
- **The dual backends produce byte-identical signatures**, asserted rather than
  assumed, and both paths are genuinely exercised — the test runtime has
  WebCrypto Ed25519.

---

## Stage 2 — `engine/core`: the fold

§3, and `archive/proto/` is the reference — it is where the tiering was
worked out and its tests carry over almost unchanged.

- Slice partitioning; the three phases (§3.1).
- Attribute rules, fixed per name: register, and flag for `:deleted` with the
  one-bag semantics §3.2 pins down.
- Body rules: blob and register.
- Totality (§3.4) — unknown object, unknown rule, pending anchor.
- **Cycle-breaking**, which the prototype does not implement and which is the one
  whole-graph pass in the fold (§3.4).
- The homomorphism `fold(fold(S₁), S₂) = fold(S₁ ∪ S₂)` as a property test over
  generated histories, since it is what stages 8 and 9 depend on.

**Decide here:** the accumulator's shape, remembering §3.7 — it keeps comparison
keys, and the rendered state drops them.

**Done when:** generated multi-writer histories converge under every arrival
order, the homomorphism holds, and a space with an unknown body rule folds its
structure correctly.

**Done.** `core` has rule, rules and fold. Three notes:

- **The accumulator keeps comparison keys and the rendering drops them**, per
  §3.7. `SliceState` carries both, so a snapshot or an incremental fold has what
  a late arrival needs to be resolved against.
- **The vacuity guard earned its place.** A test asserting the generated
  histories actually contain cycles and tombstones caught two generator bugs —
  correlated index periods meant only one object ever received a `:parent`, and
  `i % 2` was always zero where `i % 4 === 2`. Both would have left the
  homomorphism properties passing over histories that exercised nothing.
- **Cycle-breaking is the one whole-graph pass**, and it is tested for stability
  across arrival order separately from everything else, because a different
  order picking a different victim would mean two peers showing different trees.

---

## Stage 3 — `engine/store`: persistence

The first genuinely new work, and the reason the packages split.

- A storage interface: append events, read a slice, read a version vector, put
  and get blobs.
- **Append-only event storage.** The archived implementation re-serialises the
  whole log per write; this must not.
- Browser backend (IndexedDB) and Node backend (files or SQLite).
- **Per-space blob stores** (§2.4), so existence does not leak across spaces.
- Blob addressing shaped for ciphertext from the start (§2.4), even though
  nothing is encrypted yet.

**Decided: a directory of append-only segments** for the Node backend. Simpler
than SQLite, and it is what the headless peer wants for serving — appending is
the hot path, and a segment file is trivially appendable.

A single-file SQLite backend is worth having *later*, for a reason unrelated to
performance: one file per space makes a space something you can send — email it,
put it on a stick, attach it to a ticket. That is additive behind the interface
this stage defines, and it is recorded in OPEN.md rather than scheduled.

**Done when:** the same conformance suite passes against both backends.

**Done.** Three backends pass one 22-test suite: memory, files (Node) and
IndexedDB (browser). Three notes:

- **The backends live with their runtimes, not in `store`.** The first attempt
  put the file backend in `store` and widened that package's `types` to include
  Node's — which the boundary test immediately caught, because it would also
  have let `process` compile in the shared code and in the browser backend.
  `store` holds the interface, the shared chain logic and the memory backend;
  `node` and `web` each hold theirs.
- **Admission is shared, persistence is not.** `ChainSet` decides whether an
  event may be appended — duplicate, gap, fork, unverified — so both backends
  enforce one set of rules and the conformance suite is checking persistence
  rather than re-checking logic.
- **On-disk durability needs its own tests.** The shared suite closes and
  reopens through the same `Store` instance, which an in-memory backend passes
  trivially. `filestore.durability.test.ts` opens a *new* `FileStore` over the
  same directory, and checks that appends really append and that a truncated
  tail ends the log rather than corrupting it.

---

## Stage 4 — `engine`: a space, folded and persisted

The seam where a peer becomes a thing rather than a library.

- Open a space, replay its log, hold folded state, apply new events.
- **Incremental folding**: an event invalidates one slice, except a `:parent`
  write, which invalidates the tree (§3.4).
- Write path: mint an event, sign it, append, update state.
- Single-writer, in-process, no network.

**Done when:** a Node process creates a space, writes a filesystem into it,
reopens it and gets identical state; and the incremental fold agrees with a full
refold on every generated history.

**Done.** `Folder` in `core` does the incremental fold; `Space` in `peer` holds
a store and a folder together. Three notes:

- **Two cases make the incremental fold non-trivial**, and both are tested
  directly. A `:body` written before any `:kind` must be *reinterpreted* when
  the kind arrives, so bodies are refolded from retained entries rather than
  merged in place. And an event from a writer admitted *later* must be
  reconsidered, so events from unadmitted writers are held rather than dropped —
  otherwise state would depend on arrival order.
- **A local write takes the same path as a remote one**, verification included.
  A writer that mints an invalid event finds out immediately rather than when a
  peer rejects it.
- **The fold is still not persisted.** Reopening replays the log, which is what
  makes the end-to-end test meaningful: it compares a full replay against the
  incremental fold that built the original.

---

## Stage 5 — `engine/net`: protocol and sync

Everything below the transport, and none of it platform-specific.

- Framing (borrowed), message types, protocol version.
- Version vectors carrying **frontier and tip hash** (§2.3), so a forked chain is
  detectable in the handshake.
- Reconciliation, gap detection, the hold-aside buffer.
- Blob transfer (borrowed): chunking, backpressure, resume, whole-blob integrity.
- `HAVE` exchange for blob availability (§2.4).
- Verification at the wire boundary — signature, chain, `seq` — before anything
  is stored.
- **The ephemeral channel** (§10): one protocol carrying signalling, resolution,
  blob availability and presence, with expiry on everything and the send-to-one
  and send-to-connected primitives §10.1 names.

**Both decisions are settled, in the architecture rather than here.**

*Ephemeral messages are not signed* (§10.2). The transport already authenticates
the sender, and no ephemeral message is a claim that must be believed — each is
either about its own sender or a hint whose truth is established by acting on
it. Signing would add attribution, not protection. §2.1's domain tag stays
reserved so the separation exists if that ever changes.

*Forks are detected, not repaired* (§2.3). The handshake carries the tip hash, so
a diverged chain is noticed and must be reported loudly. The request that would
fetch a competing branch waits for compaction (§9.2), which wants the same
extension — building either alone means revising the wire format twice.

**Done when:** two in-process peers over a mock channel converge from arbitrary
starting states, a fork is detected and reported, a 4 MB blob transfers
byte-exact with resume, and an ephemeral message expires without ever reaching
storage.

**Done.** Four modules — protocol, sync, blobs, ephemeral — plus a `Session`
that drives one connection. Three notes:

- **Three channels share one connection**, separated by a tag byte: control,
  chunks, ephemeral. The separation is what makes "ephemeral messages are never
  stored" structural rather than a rule something has to remember, and there is
  a test asserting a presence message and a `HAVE` leave the log untouched.
- **A fork is reported once.** Both peers detect the same divergence
  independently *and* tell each other, so the first implementation surfaced one
  fork three times. Keyed by writer and both tips, so a genuinely new divergence
  is still reported.
- **`Session` is the only place that touches a store.** Everything below it —
  reconciliation, chunking, expiry — is pure, so the cases worth testing are
  reachable without a network.

---

## Stage 6 — `node`: a peer outside the browser

Now, not later, because it is what proves `core` and `net` are platform-free.

- WebSocket **server**, so this peer can be dialled, and WebSocket **client**, so
  it can dial outward from behind NAT. Both wrap a connection in the same
  `Channel` and hand it to the same `Session`.
- Serve spaces from disk; join a space by key; stay online.
- A CLI: create, join, list, serve.
- No fold required to serve (§8) — but it folds anyway, because it is the same
  code.

**Two peers that cannot reach each other converge through a third, and there is
no relay code.** A hub is not a TURN-style pipe forwarding bytes between two
connections; it is an ordinary peer that both sides sync with, so convergence
falls out of sync already working (§5.6). It also survives disconnection, which
a pipe cannot: events are *in* the hub, so the other side can collect them next
week rather than needing both parties online at once.

The cost is stated rather than hidden: syncing through a peer means that peer
holds the space. §6's encryption is what makes that unremarkable, since the hub
then holds ciphertext.

**WebRTC is not in scope here** and is not a gap. It solves *neither side can be
dialled*, which a peer at a stable address does not have; a command-line peer
behind NAT dials outward instead. A WebRTC transport for Node would let two
unreachable non-browser peers connect directly, and is a later transport rather
than a missing piece.

**Decide here:** whether a hub accepts any space offered to it, or only spaces
it was told to serve. Accepting anything is how a hub becomes free storage for
strangers; refusing means a space must be introduced before it can be synced.

**Done when:** two `node` peers on one machine sync a space over WebSockets, one
restarts and resumes from disk, two peers that dial only a third converge
through it, and nothing here imports anything browser-specific.

**Done.** A `Peer` over both halves of a WebSocket transport, plus a CLI. Three
notes:

- **Two things were missing that only a real connection reveals.** A session
  built for an outbound connection was never told where to deliver frames, and
  nothing pushed events written *after* the handshake — reconciliation runs once,
  so a live connection went silently stale the moment either side wrote.
- **`Space.absorb` exists because a session appends before folding.** Storage
  verifies and admits (§2.3), so by the time the fold should advance, the events
  are already in the log — and `receive` would refuse them as duplicates and fold
  nothing. Folding is idempotent, so absorbing them directly is safe.
- **The hub case needed no code**, which was the claim. Two peers that dial only
  a third converge because sync already works, and the hub keeps the space, so a
  peer can collect it after the other has gone.

**Also built here: the three naming layers** (§5.4, §5.5), because a CLI that
needs a 64-character paste for every command is one nobody tests with. A space
answers to its petname, its own suggested name, its short code, or its key —
resolved in that order, with an ambiguous name an error rather than a guess.

The short code is in `core` because §5.4 needs it for share links too, so stage
7 inherits a tested implementation. Petnames live in the store's own directory:
a petname belongs to the client, and the directory *is* the client — its spaces,
its keys, its names.

---

## Stage 7 — `web`: the browser client

- WebRTC data channels implementing the same `Channel` the WebSocket transport
  does, so nothing above the transport changes.
- Signalling behind an interface, with one implementation, plus a signalling
  endpoint on the headless peer.
- Browser storage backend from stage 3.
- A view over folded state: tree, preview, drag-in.
- Share links, the derived short code, trust on first use (§5.4).
- An exclusive lock per space (§7.3), so two tabs cannot fork one key.

### What connects to what, and what is deferred

Two browsers cannot dial each other, so they need **introduction** — one round
trip to exchange connection details, after which the signalling server is out of
the path. A browser reaching a headless peer needs none of that: it dials the
address directly, which stage 6 already does.

**Four pieces, and only one of them is ours:**

| | Whose | Why |
|---|---|---|
| **STUN** | third-party, configured | Standard and stateless. It reveals a peer's public address, which any server it contacts already sees, so running one buys nothing. |
| **TURN** | optional, configured | Supported because §5.6 says neither it nor the alternative dominates — two people exchanging something private may prefer a relay that carries ciphertext to a peer that holds their space. Not the default. |
| **Signalling** | ours, behind an interface | The one piece that has to know about *this* system, because a peer is addressed by space rather than by a broker-assigned id. |
| **Relaying** | not built | §5.6: two peers who cannot reach each other sync through a peer that holds the space, which stage 6 already demonstrates with no relay code. It also survives disconnection, which a byte-forwarding relay cannot. |

**Not PeerJS.** It bundles signalling with a messaging layer, so its chunking
ends up underneath ours and any measurement describes the library rather than
the transport. Its ids are also a one-claimant namespace, which made a writer's
second tab unable to claim a slot and produced workarounds nobody would choose.
The archived tree's `Signalling` interface is the right shape — narrow, with the
implementation reaching through to the raw data channel.

**Rendezvous is opaque here.** Two peers agree on a token out of band — a share
link carries it — and the signalling server matches them without learning which
space they are meeting about. A server that could be asked "connect me to anyone
serving space K" would learn which spaces exist and who wants them, which is the
enumeration disclosure the design avoids elsewhere (§5.7). That question belongs
with resolution, in stage 8.

**So a browser learns about a peer from a share link, or not at all.** If A
shares a space with B and a headless peer C also serves it, B reaches C only if
the link names it (`&l=`). Discovering C by asking A is `RESOLVE`, and it is
stage 8 — deliberately, so resolution is designed against a working client
rather than before one exists.

**Done when:** two browsers sync a space; a browser syncs with a stage 6 headless
peer; and the failure modes — no peers, unreachable, key missing — say something
true.

**Built, not yet verified in a browser.** The transport, client layer,
signalling endpoint and UI all compile and the app builds; what has not happened
is two real browsers syncing, because that needs hands on a browser. Three
notes on what was written:

- **`Client` holds everything and the components hold nothing.** The previous
  implementation kept twenty-odd pieces of reactive state in one 1000-line
  component, so nothing about syncing could be reasoned about outside a
  browser. The view subscribes and draws.
- **The design tokens carried over unchanged** — greyscale, TUI-tight, colour
  only where it means something. What was rebuilt is the component structure.
- **`svelte-check` needs its own tsconfig**, pointed at built declarations
  rather than sources. Otherwise it re-checks `core` with DOM types in scope,
  which conflicts with the deliberately minimal declarations that keep it
  platform-free.

---

## Stage 7.5 — One client, two transports

Proposed in `../design/CLIENTS.md`; **partly done** — the shared client exists, the store
lock and the CLI routing do not. Two motivations, and the first is a
correctness bug: `thing put` appends to a served space's log with no lock and
no way to tell the running holder, so a write is invisible until restart and
two processes can fork a chain on one machine.

The second was duplication that already existed. `web/client.ts` and
`node/peer.ts` had converged independently on the same structure — same
`attach`, same `pushNew`, same comments — and the hub-convergence fix had to be
understood twice. Only five of `client.ts`'s then-566 lines touched a browser
global, all of them transport construction. (After the merge: 389 and 151.)

Steps, each useful alone: ~~the store lock~~ (superseded by 7.6 — append points
remove the corruption rather than locking against it); ~~name `Connection` in
web~~; ~~move `Client` into `packages/engine`~~; ~~rebuild `Peer` on it~~; route
the CLI through the holder (superseded in mechanism: with its own append point
the CLI writes and syncs like any peer).

`engine/client/` now holds the one implementation. `Peer` is 151 lines of
directory, address and callback shapes; the web client is IndexedDB, keys,
WebRTC and the view model. `listen` stayed out of the engine: a browser cannot
accept connections, so accepting is not part of being a peer — whoever has an
address feeds what it accepts to `Client.adopt`.

**What remains of this stage has been overtaken by 7.6.** The correctness half
was the store lock and routing writes through the holder; both existed to work
around two processes contending for one chain, and append points remove the
contention. What is left of 7.5 is done.

**How that happened, because the route matters more than the conclusion.** The
lock existed because two processes sharing a writer key produce two validly
signed events at one sequence number; the write API existed because the lock
forbade the second process from writing. Each step was locally reasonable and
the design kept getting more elaborate, which was the signal.

`../design/EQUIVOCATION.md` records what a literature review then found: the hazard is
what Kleppmann calls *equivocation*, dense per-writer sequence numbers are what
make it harmful, and the fold never used them. `../design/APPEND-POINTS.md` traces the
consequence — `writer` is doing two jobs, *who signed this* and *which chain
does this extend*, and the code already separates them cleanly with no file
using it for both.

That trace changes finished stages (1, 3, 4, 5, 7) as well as future ones, which
is why it is stage 7.6 rather than an edit to stage 1.

The shape of that routing is settled (`../design/CLIENTS.md`): **the client's public API is
the only way in**, and every mode — in-process, one-shot CLI, attached TUI, and
eventually a browser pointed at a server — is a transport to it. Writes go to
the holder rather than being signed by the caller, because `seq` and `prev` come
from the chain tip and only the process that owns the chain can allocate a
position in it. The socket is local-only until there is an authentication story,
since any caller on it can write to every space the holder holds.

**Done when:** there is one implementation of `attach`. **Met.**

*(The original criterion also required `thing put` against a running holder to
reach connected peers without a restart, and a second process opening a held
space to fail with a clear error. The first moves to 7.6, where it is met by the
CLI writing its own chain; the second is withdrawn — with append points a second
process opening a held space is ordinary, not an error.)*

## Stage 7.6 — Append points ✅

**Decided, not started.** `../design/APPEND-POINTS.md` has the trace and the two choices;
this is where it lands in the order. It comes *before* the interfaces because
it changes what they have to be.

The event envelope gains `point`: an opaque 16 bytes, minted per process when a
space is opened for writing. `writer` stays the identity; the chain is keyed by
`(writer, point)`.

- `encodeEventBody` gains the field, so **every signature changes and no
  existing log is readable.** Acceptable now, and not later.
- `checkLink`, `ChainSet` and the version vector key by `(writer, point)`.
- `compareKeys` is untouched — still `(lamport, writer, id)` — so the fold, the
  rules and the root check do not change at all.

**Why it is worth doing before more of the design is built on the old shape:**
it is *subtractive*. The store lock stops being a correctness requirement, the
control API stops needing to carry writes, `writelock.ts` stops being needed for
correctness, and the CLI becomes an ordinary peer again. Stage 7.5's remaining
work and stage 7.7's shape both shrink.

**Two things it does not do.** It does not address a *malicious* writer, who can
still equivocate within one append point — §7.3's resolution stays for that
(OPEN.md question 11). And it does not give the system attribution: `writer` is
still a per-space key, and there is still no notion of a person
(`LEARNINGS.md` §1).

**Watch stage 10.** §6 derives the encryption nonce from `(writer, seq)`, unique
only because one identity has one chain. It must become `(writer, point, seq)`
or two of one identity's processes reuse a nonce under one key.

**Done when:** two processes hold one space with one writing key, both write, and
both sets of events fold — with no lock, and no fork reported.

**Done.** Four notes:

- **The version vector is keyed by chain, not writer**, and that rename runs
  through `SeqRange`, `WANT`, `FORKED`, `Divergence`, both real stores and the
  debug UI. `chainOf(e)` in `core` is the single definition of `writer/point`,
  so the pair is never split and rejoined.
- **`resumeFrom` was inverted, deliberately.** It used to continue the last
  chain; it now starts a new one and carries only the Lamport clock forward.
  The test asserting the old behaviour was rewritten to assert the new, because
  continuing a chain is only safe if its previous owner has stopped — and being
  wrong about that is exactly the fork this removes.
- **A fork now has to be staged.** `session.test.ts` built one by having two
  peers share a key, which no longer collides; it passes an explicit shared
  point instead. That the test needed changing *is* the result: honest software
  cannot produce a fork any more, so a fork means equivocation or a rolled-back
  store.
- **Two processes writing one held space is now ordinary**, verified with two
  concurrent `thing put` calls and with a `put` against a running `serve`: both
  files present, zero forks. What that does *not* fix is the running holder
  noticing — it serves what it loaded at startup. That is a notification gap and
  belongs to 7.7, not a correctness one.

## Stage 7.8 — `deps`: permission as of what was seen ✅

**Done.** `docs/design/DEPS.md` has the design and the measurements; this is what it
cost to build.

The envelope gains `deps`: the ids of the events a writer had seen when signing,
sorted and deduplicated so the encoding stays canonical. The fold judges an
event against the writer set **its author had seen** rather than the set as it
finally stands, which is §7.2.3's *valid when written* becoming computable and
§3.6's determinism restored (OPEN.md 8a, closed).

Four notes:

- **`Folder` no longer caches a writer set.** It kept one and admitted against
  it, which is precisely what made it disagree with a replay. It now recomputes
  admission from `deps` on every apply, using the *same function* as the full
  fold — so the two cannot drift. Slower and correct; `deps.test.ts` asserts the
  agreement directly.
- **Seeing no declaration is not the same as no declaration existing.** `deps`
  is self-reported and an empty set is free to claim, so an event whose past
  holds no membership event is judged against the *earliest* declaration rather
  than admitted. Without that, naming an empty past bypasses membership
  entirely. One existing test asserted the opposite and was rewritten.
- **The topological walk had to be made order-independent.** Seeding it from
  input order made the full fold's answer depend on arrival order — the bug it
  exists to fix, one layer down. Ties break on event id.
- **Freeing consumed state needs a reader count.** Several events can name one
  dep, and freeing on the first left a later sibling with an empty past.

**Cost, measured:** 229 bytes per event on disk, up from 206. Sync unchanged
against the pre-`deps` baseline, checked by rebuilding both.

## Stage 7.9 — Rebuild `node` on the main-space model ✅

**Done.** The old server is in `archive/node/`, reference only: the shape
changed enough (`docs/design/MAIN-SPACE.md`) that adapting it would have carried
assumptions that no longer hold — a peer holding many spaces, a petname index,
a CLI resolving names against a local directory listing.

What replaced it:

- **`Server`** — one space, held whether or not this peer can write to it
  (§6.1), listening only if given an address (§5.6). No lock: per-process
  append points mean two processes writing one space extend separate chains
  (§2.1), so locking would prevent something that is no longer a hazard.
- **A CLI whose commands name a space**, since a peer holds one and reaches
  others by following links. `init`, `key`, `serve`, `ls`, `put`, `get`,
  `link`, `unlink`, `links`.
- **`fs/links.ts` in the engine** — `:kind: 'link'` with the target key in the
  body, plus a `link` body rule that is a register over a public key. A client
  that has never heard of links still folds the tree and shows the object
  (§3.1); it just cannot follow it.

**Kept rather than rebuilt**, because they are capability implementations that
the model did not change: `filestore.ts`, `transport.ts`, `local.ts`,
`petnames.ts` — and `boundary.test.ts`, which is not server code at all. It
guards the *engine's* platform split and lives in `node` only because it reads
files, which the package it checks cannot do; archiving it would have silently
dropped that guard.

**Not built here:** resolution (§5.3 and `docs/design/LOCATORS.md`) — a peer serves
and can be dialled, but nothing announces or answers queries yet. That is stage
8, and it needs measurement rather than argument.

## Stage 7.10 — Rebuild `web` on the main-space model ✅

**Done.** The old client and UI are in `archive/web/`, reference only — the UI
especially, since its design tokens and component structure carried real
decisions the rebuild should take rather than reinvent.

- **`Client` holds tabs, not an inventory.** `open` writes nothing; `follow`
  opens a tab carrying the link's name, which is what a petname was without a
  separate store; `create` mints a space for a client that wants one. A client
  that only views other people's spaces holds nothing at all.
- **`writelock.ts` is gone**, not moved aside. It existed to stop two tabs
  sharing a key writing at the same `seq`; per-process append points mean they
  extend separate chains, so the hazard cannot occur. Stage 7.6 predicted this.
- **A minimal UI**, deliberately: tabs, a tree, following a link into a new tab.
  The previous App merged a space list, tree, preview and debug panel into 353
  lines; only the parts the tab model changed were rebuilt, and the rest is
  worth adding back deliberately.

**Kept rather than rebuilt**, as capability implementations the model did not
touch: `idbstore.ts`, `webrtc.ts`, `signalling.ts`, `local.ts`.

Ten tests for the tab model, under `fake-indexeddb` and a `localStorage` shim.
The load-bearing one — *following a link does not add it to your own space* —
was verified to fail when browsing-acquires is reintroduced.

**Since added:** files, folders and a content preview — without them the tree
and the renderer could not be exercised at all. Drop anywhere, or `+ file`;
`+ folder`; selecting a file previews it. The preview carries over two things
the previous version had worked out and that are easy to get wrong: a blob may
not be held yet (§2.4), so it asks connected peers and retries when one
appears; and `:kind` is advisory (§4.2), so bytes that decode as UTF-8 are shown
as text whatever the label claims.

**Not built:** the share panel and the debug view of version vectors; the
ephemeral view of connections; and editing a remote space, which needs the
`:writers` bootstrap (`docs/design/MAIN-SPACE.md`).

## Stage 7.7 — The interfaces: control socket, CLI, TUI

**Shape settled, details open.** `../design/CLIENTS.md` has the reasoning.

The settled part: **the engine's client API is the only way in**, and every
interface is a transport to it.

```
thing              holder + TUI in one process     the default
thing serve        holder, no interface            headless
thing attach       TUI over a holder elsewhere     needs a wire
thing <verb>       one-shot, print and exit        scripts and SSH
browser            the same, over a socket         later (§below)
```

`thing` is one process: the TUI is a renderer over a holder, not a client of
one, so there is no protocol between interface and peer. Only `attach` and the
browser need a wire, and both carry the same API rather than a vocabulary of
their own.

The control socket is a Unix socket in the data directory — **local only**, and
that is a constraint rather than a default. Any caller on it can write to every
space the holder holds, which is fine when the filesystem permissions that guard
the socket also guard the key files, and not fine over TCP. No network transport
until there is an authentication story.

**What is not worked out:** the socket's encoding (it must carry method calls,
async iterables, streamed bytes with backpressure, and a subscription for the
view model — `net/protocol.ts` solves the last three for sync but sync frames
are not method calls); whether the view model pushes or pulls, and how it
coalesces so a busy sync does not spend its time redrawing; and how much the TUI
shares with the web client beyond the view-model types.

**The browser is the real test of the API.** The terminal modes can cheat —
`thing` is in-process and `attach` is a local socket with the process's own
trust. A browser can do neither. If the API survives a caller that is genuinely
remote and cannot read the key files, it is the right API. That also forces one
decision the terminal modes hide: the UI calls `list(space.state, …)` directly,
so a remote browser either ships the fold or turns every navigation into a round
trip. Ship the fold.

**Note what 7.6 removes from this stage.** With append points, writes no longer
have to go through the holder, so the socket carries administration and the view
model because that is what is *left*, not because editing was excluded from it.

**And what that opened — now built.** A writer that no longer goes through the
holder also no longer learns whether the holder got its write. §2.3.1's question
— *is your version vector at least as recent as mine?* — is now `SYNCED?`/
`SYNCED` on the wire, `covers()` in `net/sync.ts`, and `Client.synced()`, with
`thing put|link|unlink --at <url>` as the caller: the write goes to the running
holder and the command exits only once that holder confirms.

Four notes:

- **`--at` belongs to writing, not to `put`.** It is a parameter of `openMain`,
  so `link` and `unlink` got it without code of their own. The alternative — a
  flag per command — would have been the same plumbing three times.
- **Silence counts as behind.** An open connection that never answers is
  indistinguishable from a healthy one, so each question is bounded by the
  caller's deadline. Found by a stalling test; without it the CLI hung forever
  on a wedged peer. See LEARNINGS §13.
- **Every session, not the first.** A client connected to two holders that exits
  when one is caught up has told the other nothing.
- **What is still not built:** the holder noticing a write made *beside* it, with
  no `--at`. That remains a restart, and it is the same notification gap — `--at`
  routes around it rather than closing it. Closing it needs the control socket,
  which is the rest of this stage.
- **`synced` covers events, not content.** A file's bytes travel by §2.4's
  separate path, so a covered vector means the names arrived. §2.3.2 records
  what is missing and why it is a UI problem rather than a protocol one.

## Stage 7.10 — Blobs across a relay ✅

**Done.** Two browsers reaching each other only through a server could see each
other's files and never open them.

Three things were wrong, and only the first was the obvious one:

- **Nothing mirrored.** §2.4 makes blobs pull-only, so the server folded the
  events, listed the file, and had never fetched the bytes. `mirrorBlobs` is
  now a per-space policy — on for `serve`, off for a browser tab, with a
  toggle — because "keep a copy" is a decision about *why a peer exists*, not
  about what kind of program it is.
- **`NO_BLOB` went nowhere.** The message existed, cancelled the transfer, and
  told no one, so a refusal was indistinguishable from slowness and the preview
  said "Fetching…" forever. It now reaches the client and the view.
- **A refusal was permanent.** The event arrives before the bytes, so a client
  asking a relay usually asks *while the relay is still fetching* — it gets a
  truthful "no" and, before this, never asked again. A peer now announces a
  blob it acquires (`HAVE`, which existed and had no production caller) and a
  refused-but-still-wanted blob is re-requested. Reproduced deterministically
  with a 400 KB payload, where the race is wide enough to lose every time.

**A test that could not fail.** The first version of the retry test used three
clients on a fake wire and passed with the retry removed, because the relay's
own in-flight transfer reached the reader regardless. Moved down to `Session`,
where one message is tested against one behaviour; both mutants now fail.
LEARNINGS §14.

## Stage 7.11 — A hub hosts what it links ✅

**Done.** `../design/MAIN-SPACE.md` said adding a link to a server's main space "tells it
to hold another space, and it does". It did not; that sentence described an
intention. Now it is true.

A server holds every space reachable by links from its main space, to
`hostDepth` hops (default 1, `--host-depth` on the CLI), mirrors their blobs,
and accepts connections about them. The workflow: make a space in a browser,
drop a link to it in your synced copy of the hub's space, and it is hosted.

**The link is the authorisation**, which is why this needed no new permission
concept — only a writer of the main space can add one, and unlinking withdraws
it. The blunt alternative, `acceptUnknownSpaces`, makes a peer free storage for
strangers and is still off.

Three things fell out of building it:

- **`hold` was not reentrancy-safe.** It checked a map, then awaited several
  times before recording anything, so two concurrent calls opened one space
  twice — two stores, two folds. Latent until now; a link graph has cycles by
  design, so a walk reaches one space by two paths at once. The promise is the
  guard now, as in the `adopt` fix.
- **Every hosted space is watched, not only the main one.** Past one hop the
  links that matter live in spaces that arrive *after* the walk, so watching
  only the main space would make deeper hosting work on restart and not before.
- **Withdrawing hosting does not delete.** A mis-drag would otherwise destroy
  what may be the only copy of someone's space.

**Not built:** the hub only *accepts* connections about a hosted space; it never
dials one. A space whose owner is offline stays as fetched, which is right, but
a hub cannot go looking. That needs §5.3's resolution — stage 8.

## The web client — **all eight stages built** ✅

Its own build order, because it is an interface rather than a layer of the
engine. Settled decisions are in `../design/WEB-CLIENT.md`; what it still wants is
in `WEB-NEXT.md`.

Each stage should leave a client someone can use.

1. ~~**Layout: sidebar tree, preview pane, mobile breakpoint.**~~ **Done.**
   `minmax(14rem, 22rem) 1fr`, collapsing to one pane at 40rem with selection
   pushing the preview over the tree — the mechanism `../archive/v0/MOBILE.md`
   arrived at by building it. `app.css` went from 615 lines to 70: the rest was
   component CSS for components this rebuild does not have, and a global rule
   for a component that does not exist is a rule nothing checks. It is in
   `archive/ui/app.css` for when a panel comes back.
2. ~~**Download, rename, delete.**~~ **Done**, plus the tree itself: folders
   now expand in place rather than replacing the view, which is what makes it a
   tree rather than a navigator. Recursive by snippet over `FileEntry`, with
   expansion held as interface state — the same shape `archive/ui/Tree.svelte`
   used. Delete is `:deleted`, which hides without unwriting (§7.2.3).
3. ~~**Drag: re-parent within a tree, and desktop-to-tree.**~~ **Done**, plus
   dragging a tab into a space to keep it. Dropping onto a file means *into the
   folder containing it*; a move that would put a folder inside itself is
   refused rather than resolved, since §3.4 would re-parent it to the root
   deterministically and that is a baffling thing to watch happen. Internal
   drags and file drops are distinguished by `dataTransfer.types`, so an
   internal drag does not raise the whole-window "drop files" outline.
4. ~~**The renderer registry**, with text, image and PDF.~~ **Done.** Type
   parsing and the degradation chain went into the engine, since they are
   platform-free and a terminal client wants the same fallbacks; the registry
   and the three renderers are in `web/src/ui/renderers/`.
5. ~~**Links: pasting a key**, for a space nobody has open.~~ **Done.** One
   parser takes a bare key or a whole share link, since both are things people
   copy; **not** a short code, which is derived from a key's hash and cannot be
   reversed (§5.4). Two entry points, matching the drag: *open* puts it in a
   tab, *link here* keeps it in the current space.
6. ~~**Share.**~~ **Done** — the link, the key and the code, each with what it
   guarantees, since they are not interchangeable. Joining by *pasting* landed
   in stage 5; there is no join-by-code, because a code cannot be reversed to a
   key (§5.4) and so cannot open anything on its own.
7. ~~**Debug panel** — vectors, forks, peers, activity, **and storage**.~~
   **Done.** Reached from the tab bar, closed by default: it is for when
   something has gone wrong, and putting storage forward would suggest that
   browsing it is ordinary. It renders outside the "a space is open" branch,
   because the storage view is most useful exactly when nothing will open.

   Six tabbed views — peers, chains, storage, blobs, ephemeral, log — rather
   than one scrolling page, because they answer unrelated questions and only
   one is ever being asked. Everything is a table; the log filters.

   It earned its place immediately. On first run against a real browser it
   showed **seven spaces with no tab** — every link expanded during testing,
   held and unreachable — and the blobs view showed rows marked *referenced but
   missing*, which is the "Fetching…" case made visible. `canEnumerate` on
   `IdbStore` reports whether the listing is complete, so a browser without
   `databases()` says so rather than showing a short list that looks
   authoritative.

   **A status footer sits above it, always visible.** Connectedness is not a
   debugging concern — it decides whether anything you do reaches anyone — so
   the peer count for the current space, its name, any fork and whether it is
   keeping copies are on screen permanently, with the peer list as a popout.
   Revealing that only on demand makes "nothing is syncing" look identical to
   "everything is fine".

   **One trap worth recording.** `refresh` writes `$state` and is driven by
   `client.subscribe`, which fires on every fold. Calling it from inside an
   `$effect` made the effect depend on its own writes and froze the tab hard
   enough to need closing; a sync of a few hundred events also fires the
   subscription a few hundred times, each starting an async read of storage and
   every blob hash. It is now guarded against overlap and coalesces a trailing
   pass, and the effect tracks only the space id.
8. ~~**Settings** — signalling, ICE, keys.~~ **Done.** In the footer beside
   debug, and the two are exclusive — both are panels about the client rather
   than about a space.

   Three things that are not the same kind of thing. **Signalling and ICE** are
   how a peer is reached: addresses, disposable in the way §5.2 says locators
   are, where a wrong value costs a failed connection. **Keys** are the
   opposite — §5.1.1 calls key loss the largest unresolved risk in the design,
   so the section is an export, and it is the reason the panel exists at all.

   Two details worth keeping. Changes apply **on reload**, said plainly rather
   than papered over: a `Client` reads both at construction, and reconnecting
   every peer to apply a preference would drop live transfers to no purpose.
   And an **empty ICE list is a real choice** — no STUN, local network only —
   so it is stored as `[]` and never folded into "unset", which would silently
   restore the default.


## Stage 8 — Resolution and the mesh ✅

**Done**, except the numbers. `design/LOCATORS.md` has the scenarios and
`ARCHITECTURE.md` §5.3 the design; this is what it cost.

The shape landed as specified, with one correction found on the way: **§5.3's
best locator source does not work.** A signed `:serves` list on a space's root
is unwritable by the peer that knows the address — a host is usually a replica
holding no key — and replicates a fact about a *pair* of peers as a fact about
the space. It is dropped, and the cache carries what it was for.

Four notes:

- **A locator is a shape, not a URL.** §5.2 has two, and `{via, peer}` is how a
  browser is reached. The cache is a bounded ranked list per space, learning
  from success and failure, because which locator works is per client.
- **Announcement had to become symmetric.** Whichever side connects first
  announces into a connection whose far end has no session yet, and that
  announcement was lost. A session answers the first one it receives, once —
  the same fix `HELLO` already uses.
- **`reach` dialled without holding the space**, so it failed for every space
  the client did not already have, which is every space worth reaching. Caught
  by a test rather than by reading.
- **A connection is per space, and that constrains who can ask whom.** A peer
  must share *some* space with a hub to have a connection to ask over —
  dialling a hub about a space it does not hold is refused, correctly. Linking
  the hub is how a person follows one. Discovered by writing a probe that got
  it wrong; the integration test now says so.

**Left undone:** the numbers. `KEEP_PER_SPACE`, `DROP_AFTER`,
`MAX_SPACES_PER_PEER`, `MAX_LOCATORS_PER_PEER` and the dial timeout are
starting values, not findings — §5.3 asks for a measurement against a real
network and there is not one yet. And dialling a `{via, peer}` locator: a
browser can *say* where it is, and nothing yet turns that back into a WebRTC
meeting.

## Stage 8.1 — A connection carries many spaces ✅

**Designed, not built.** `../design/CONNECTIONS.md` has the reasoning.

Stage 8 left one thing that does not work, and it is the case the whole hosting
story is for: **a hub cannot fetch a space held only by a browser.** It resolves
it correctly — the browser answers *I have that, reach me here* — and then
cannot open a session for it, because a connection is bound to the first space
it heard about and every control message except `HELLO` is implicitly about that
one space.

There is no way round it. A browser cannot be dialled (§5.6), so a second
connection is unavailable by construction; if one connection cannot carry a
second space, a hub can only host spaces owned by peers that already have
addresses, which excludes every browser.

**The change:** every control frame names its space, and a receiver routes by
it. No version bump — nothing is deployed that must interoperate across one.

**Decide while building:** refusal becomes per space rather than per connection,
so `onRefused` changes shape and a connection survives a refusal unless it has
nothing left.

**Done when:** a space created in a browser, linked into a hub's space, is held
and served by that hub — and a second browser that has never met the first can
read it.

**Done.** Three notes:

- **One router, two ways in.** `join` and `adopt` were separate frame handlers
  and each hardwired one session; they are now the same routing table, and
  `join` differs only in greeting eagerly for the space it dialled about.
- **`reach` was attaching without greeting.** It built a session and said
  nothing, so the far end never learned the space was wanted there — and a
  session nobody greeted for is one the router will not deliver to either. It
  is the mutation that fails the new test.
- **Refusal is per space.** A peer that will not hold one closes the connection
  only if nothing else on it survives.

## Stage 8 — the original plan

§5.3, which the archived tree never had.

- Locators as a list, with expiry.
- Announce on serve; `RESOLVE` as a query.
- One-hop answering with the three caps (§5.3).
- Three-way empty answer, with *last seen*.
- Readers serve by default while open.

**Decide here:** the numbers — dial timeout, per-space cap, per-announcer cap,
default expiry. §5.3 says deliberately that these are measured, not chosen, so
this stage produces a measurement rather than a guess.

**Done when:** a peer finds a space through a third peer that only heard about
it, and a space stays reachable after its writer disconnects.

---

## Stage 9 — Multi-writer ✅

Additive, because §7.2 settled the shape.

- Writer set on the root; phase 1 admits root events on the space key alone.
- Phase 2 filters by the set.
- Moderators as ordinary writers with an attribute (§7.2.2).
- Fork resolution: deterministic, with detection surfaced rather than silent.

**Scope decision: defensive design is out of scope for this pass.** With append
points, a fork is no longer what two of your own devices do by accident — it
takes deliberate effort, so it means equivocation or a corrupted store. That
whole area (backdating, the nuclear revoke, a compromised space key — see
`LEARNINGS.md` and OPEN.md 5a, 10, 11) is a target for a later rewrite rather
than something to half-build now.

What this stage owes is therefore **convergence, not defence**: every peer must
reach the same answer, by whatever rule is simplest.

**That changes which rule to use.** §7.3.1 specifies *longest branch, ties on
lowest event hash*, and is explicit that length "is not a security property —
whoever writes more wins". Its justification is a heuristic for the honest case:
*"one device carrying on while another sat stale"* — which is exactly the case
append points removed. What length costs is that a peer must retain both
branches to know which is longer, and keep re-deciding as more of the loser
arrives.

Since the case it was tuned for no longer exists, **the tiebreak alone is the
rule**: at the first divergent sequence number, the lower event id wins. Total,
computable from the event set alone, needs no branch retained, and cannot change
its mind as more events arrive. §7.3.1's own standard — *"a rule that picks
arbitrarily satisfies that"* — is met.

**Decide here:** membership as whole-list register or add/remove operations
(§7.4), and whether a peer keeps replicating a losing branch.

**Done when:** three writers converge on one space; a non-writer's events
replicate but do not fold; a deliberately forked key resolves identically on
every peer.

**Done.** Three notes:

- **Resolution lives in the fold, not the store.** The log is append-only
  (§2.1), so a store cannot un-store a loser — it refuses the second branch and
  keeps whichever arrived first. The fold is the only layer that can decide, and
  §7.3.1 already said so: *"the losing branch's events are not folded. They
  remain in the log."* Two peers holding different branches converge when they
  exchange them.
- **The incremental fold runs the same two functions in the same order** —
  `resolveForks` then `admitsWith`. The first version did not, and disagreed
  with a replay; the test caught it. This is the second time that exact shape
  has appeared, so both are now shared functions rather than parallel logic.
- **The order-independence tests pass against a wrong rule**, verified by
  breaking it. They check convergence, not the choice, which is the right split
  — but it means the "lowest id wins" tests are the only thing pinning the rule.

**Left undone deliberately:** OPEN.md 8, whether a peer keeps replicating a
losing branch. It is a bandwidth question with no correctness content now that
resolution is deterministic, and it belongs with the defensive work.

---

## Stage 9.5 — Capabilities: three keys, and what a link carries ✅

**Designed, not built.** `../design/CAPABILITIES.md` has the reasoning.

Two things block putting this on a public server, and only one of them was
obvious.

**Every space is world-writable.** `mayWrite` admits everyone when no writer set
is declared, and nothing writes `:writers` — so a space is writable by anyone
holding its public key, which is what a share link is made of. Sharing a space
to be *read* currently hands over the ability to change it. `Space.addWriter`
and `Space.admitted` both exist with no callers.

**A link carries one key and there are three.** Replicate, read and administer
are different acts (§6.2 says so); the format has one field.

- `create` declares a writer set naming its creator.
- Three link shapes, by what they contain rather than a mode flag.
- `writable` in a UI must distinguish *I hold a key* from *my key is admitted*.
- An absent writer set still admits everyone, so existing spaces are unaffected.

**Done when:** a space made in one browser is read-only in another until
admitted, and a share link can be made that grants reading without writing.

**Done.** Four notes:

- **`writable` now means admitted**, not "holds a key". A key outside the
  writer set signs events every peer stores and no peer folds, so a UI offering
  editing on the first would be lying. `Space.admitted` existed for exactly
  this and had no callers.
- **`importFor` is the other half of `exportKey`**, which §5.1.1 wanted and
  `WEB-NEXT.md` had noted as the substantive gap: an export nobody can restore
  is half a mechanism. Validated against the space id in one shared place, so
  three backends cannot disagree about what they accept.
- **Existing spaces are untouched.** An absent writer set still admits everyone
  (§7.2.1), so only newly created spaces declare one.
- **The hand-over link is deliberately blunt.** It hands over the space, not
  write access, and the panel says so in those words.

**Left for stage 10:** the `r=` field. A reading key has nothing to carry until
there is encryption.

## Stage 10 — Encryption ✅ *(one defect open: `design/BLOB-REFS.md`)*

§6, self-contained if stage 3 left addressing ciphertext-shaped.
**`ENCRYPTION-PLAN.md` has the decisions, the seams, and what the build found
that they missed** — read that first; the bullets below are the original
sketch.

- **Root events are not encrypted** (`../design/ROOT-IN-CLEAR.md`). `:writers`
  lives there, so encrypting it means a peer without the reading key cannot
  evaluate membership — and an encrypted space could then only be hosted by
  someone able to read it, which is what §6.2 exists to avoid. It is also the
  bound OPEN.md 8a wanted: a keyless peer can tell whether an event will ever
  fold. Costs `:name` in clear, deliberately.
- Reading key in the link fragment — the `r=` field `CAPABILITIES.md` left for
  this stage.
- Authenticated cipher over event values and blobs, **nonce derived from
  `(writer, point, seq)`**. §6 specified `(writer, seq)` and flagged that the
  pair is unique *only because one identity has one chain*; append points broke
  that, and `../design/CAPABILITIES.md` settles the replacement — the same
  triple that already keys a chain.
- Derived subkeys for values and blobs.
- A peer without the key: stores, serves, verifies, folds structure, folds no
  bodies (§6.1).

**Decide here:** the cipher, and whether blob encryption is deterministic —
which trades a confirm-a-known-file attack for deduplication (§6).

**Done when:** a headless peer serves an encrypted space it cannot read, and a
browser with the key reads it through that peer.

**Done, with one qualification worth reading.** XChaCha20-Poly1305 over event
values and blobs, HKDF-SHA256 subkeys, nonce `(writer, point, seq)`, root in
clear, `r=` in links, reading keys in all three keyrings and in the local
conformance suite. `hosting.test.ts` runs the "done when" end to end.

**The qualification: a keyless peer cannot mirror blobs, and this is a bug.**
A blob's address lives in `:body` and this stage encrypted `:body`, so the
headless peer in that test relays the whole log and the *content* moves only
between the two peers holding the key. §6.1 and §6.2 both promise otherwise, and
§2.4 addressed blobs by ciphertext hash specifically to make keyless mirroring
possible. **Open, with five candidates in `../design/BLOB-REFS.md`** — the root
cause is §3.9's deferred question, now forced. Stage 10 is otherwise complete;
this is the piece to settle before it can be called done.

Three other notes:

- **The three decode sites the plan named were the wrong seam** — two of them
  have no access to the nonce triple. Decryption happens once at the entry to
  each fold instead, and nothing below it knows encryption exists.
- **It found a latent bug in the incremental fold.** `applyOther` minted a
  phantom object from any `:parent` value that was not a uuid; `resolveParents`
  had the width check and the two disagreed. Reachable before encryption by a
  malformed write, never hit.
- **A new browser space is encrypted by default**; a CLI space is not
  (`thing init --encrypted`). Nothing in the design decided this, so it was
  decided in `ENCRYPTION-PLAN.md` and is flagged here as a choice rather than a
  consequence.

---

## Stage 11 — The sequence rule ✅

The bet (§3.8), and deliberately late: everything above it works without it, and
by now there is a real system to try it in rather than a harness.

- Sequence as a body rule, elements identified by `(writer, seq)`.
- Tombstones in the fold output; pending inserts on missing anchors.
- **Canonical form specified before the rule is coded** (§3.6) — observable state
  hashed, representation not.
- A collaborative text object in the browser client.

**Done when:** two browsers edit one document concurrently and converge, and the
canonical form is stable across a deliberately different internal representation.

**Done in the engine; the browser half waits for 7.7.** What is answered is the
bet itself — §3.8 asks whether "merge rule" stays a small vocabulary or becomes
"arbitrary code with private state", and **the sequence rule fits the ordinary
`Rule` contract with no escape hatch**: no log access, no clock, no state
outside the accumulator, and no special case anywhere in the kernel. The fold
dispatches it by `:kind` exactly like `blob` or `register`.

What is *not* answered is whether the merge results are acceptable to a person.
Two writers converge; whether they converge to something someone would accept is
a judgement made by looking. Tests are written as transcripts so the expected
values are legible enough to disagree with, and the concurrent-typing case shows
each writer's run staying contiguous rather than interleaving character by
character — which is the property that makes it readable. But legible is not
tried.

Three notes:

- **The prototype's element id was broken by append points.** It derived from
  `(writer, seq)`, which stopped being unique when one writer gained several
  chains — two of your own processes would mint the same id for different
  elements, and every anchor would be ambiguous. Silent, too: the result is a
  plausible list in the wrong order. Ids now name the creating event by hash.
- **Canonical form was specified before the rule was coded**, per §3.6, and the
  specification survived the implementation unchanged except for that id.
- **Two existing tests used `sequence` as their example of an unknown body
  rule.** They now use `canvas`. That they broke is the point.

**Left for the interface:** whether the merge *reads* well, and what `body`
should be — a character, a run, a block reference. It stays opaque bytes here,
because deciding it in the rule would make the rule less general, and that
choice is itself part of the bet.

---

## Stage 12 — Make the incremental fold incremental

**Found by chasing OPEN.md 10a, which turned out to be this wearing a
misleading name.** The fold does not disagree with itself; it is slow enough
that two property tests crossed a 5s timeout under load.

Measured, on a 24-event history:

| | |
| --- | --- |
| one full fold | 2.5 ms |
| 50 incremental folds | 56.2 ms |
| 24 events one at a time | 44.7 ms |
| the same 24 in one batch | 7.4 ms |

**The incremental fold is 22× slower than replaying from scratch**, which
inverts the reason it exists. `apply()` calls `refold()` unconditionally
(`incremental.ts`), clearing all state and re-folding everything held, so N
events applied one at a time is O(N²) with every event re-hashed each pass.

**That choice was deliberate and its reasoning still holds.** The comment says
it: an earlier version refolded only when membership changed, which left events
arriving *after* a change judged against the current writer set rather than
against what their author had seen — §7.2.3's disagreement, reintroduced one
layer down. Correctness was right; the cost was never measured.

**The question this stage answers:** can admission be recomputed only when it
could have changed, without reintroducing that drift? An event's admission
depends on the writer set as of its `deps` (§7.2.3), so the candidate is that
adding an event only invalidates events whose `deps` reach it — a much smaller
set than "everything". Whether that is cheap to determine is the thing to find
out, and `design/DEPS.md` measured `deps` width for exactly this kind of
question.

**Decide here:** whether the answer is invalidation (recompute a subset) or
memoisation (cache admission per event and drop what a new root touches), and
whether `Space.receive` should batch harder — a peer syncing thousands of
events currently pays this per batch.

**Done when:** applying N events one at a time is not asymptotically worse than
one full fold of the same events, the two folds still agree over the generated
histories, and the tests that carry a raised timeout no longer need one.

---

## Stage 13 — A shared document ✅

**The bet, used.** §3.8 calls the universal fold the central claim of the
design; the sequence rule was built for it, pinned before it was coded, and
nothing had ever put weight on it. A text document is the smallest thing that
does — and it needed no engine change beyond exporting one traversal.

A document is an object whose `:kind` is `sequence`, so any client holding that
rule can edit it without knowing what wrote it. `fs/text.ts` turns a wanted
string into operations; `TextEdit.svelte` binds a textarea to it, with cursors
on the ephemeral channel.

Three things worth keeping:

- **Runs, not characters.** An element's id is its event's, so one event is one
  element and a character per keystroke would be an event per keystroke. Typing
  is debounced into runs. The price: concurrent edits *inside one run* resolve
  at run granularity, because splitting a run needs an id the creating event
  cannot supply.
- **Local text leads while you type.** Rebuilding the textarea from the fold on
  every keystroke fights the caret — the fold is a beat behind, so the value
  snaps back and the cursor jumps. The fold only overwrites when someone *else*
  changed it.
- **`:kind` names the rule** (§4.2), which caught an error: an invented `text`
  kind resolved to nothing and the object folded as *unreadable* rather than
  being guessed at. §3.1's tiering working as designed.

**Verified with two people editing at once**, through a hub, converging with
both edits intact.

**Open:** cursors are reported as an offset and shown as text. Rendering them in
the textarea needs coordinate mapping, which is a UI problem rather than a
protocol one.

## Beyond

Not planned in detail, because each depends on what the stages above teach.

- **Fast-start snapshots** (§9.1) when folding is slow enough to notice.
- **Views as code** (§8), whose remaining piece is the write-proposal channel.
- **Compaction** (§9.2–9.3), which needs the wire concepts stage 5 may defer.

---

## What each stage buys

| Stage | Answers |
|---|---|
| 1–2 | Does the fold hold up outside a prototype? |
| 3–4 | Does a space work as a persistent local thing? |
| 5–6 | Is the protocol genuinely platform-free? |
| 7 | Is it usable? |
| 7.5 | Is there one implementation of being a peer, or two? |
| 7.6 | Can one identity write from two processes at once? |
| 7.7 | Is the engine's API good enough to be the only way in? |
| 7.8 | Can the fold say what was allowed *when it was written*? |
| 8 | Can a space be found and stay alive? |
| 9 | Does multi-writer stay as cheap as §7.2 claims? |
| 10 | Can infrastructure exist without custody? |
| 11 | Does the vocabulary hold, or does §3.8 bite? |

Stages 1–7 produce a working single-writer synced filesystem with a headless
peer — a real thing, and the point at which the design has been tested by use
rather than by argument.
