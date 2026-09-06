# Implementation plan

The route from [ARCHITECTURE.md](ARCHITECTURE.md) to a running system, in stages
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

Proposed in `CLIENTS.md`; **partly done** — the shared client exists, the store
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

`EQUIVOCATION.md` records what a literature review then found: the hazard is
what Kleppmann calls *equivocation*, dense per-writer sequence numbers are what
make it harmful, and the fold never used them. `APPEND-POINTS.md` traces the
consequence — `writer` is doing two jobs, *who signed this* and *which chain
does this extend*, and the code already separates them cleanly with no file
using it for both.

That trace changes finished stages (1, 3, 4, 5, 7) as well as future ones, which
is why it is stage 7.6 rather than an edit to stage 1.

The shape of that routing is settled (`CLIENTS.md`): **the client's public API is
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

**Decided, not started.** `APPEND-POINTS.md` has the trace and the two choices;
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

**Done.** `docs/DEPS.md` has the design and the measurements; this is what it
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

## Stage 7.7 — The interfaces: control socket, CLI, TUI

**Shape settled, details open.** `CLIENTS.md` has the reasoning.

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

## Stage 8 — Resolution and the mesh

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

## Stage 9 — Multi-writer

Additive, because §7.2 settled the shape.

- Writer set on the root; phase 1 admits root events on the space key alone.
- Phase 2 filters by the set.
- Moderators as ordinary writers with an attribute (§7.2.2).
- Fork resolution: longest branch, ties on event hash (§7.3.1), with detection
  surfaced rather than silent. If append points land first, this stops being the
  *expected* path for two devices and becomes the malicious-writer case only.

**Decide here:** membership as whole-list register or add/remove operations
(§7.4), and whether a peer keeps replicating a losing branch.

**Done when:** three writers converge on one space; a non-writer's events
replicate but do not fold; a deliberately forked key resolves identically on
every peer.

---

## Stage 10 — Encryption

§6, self-contained if stage 3 left addressing ciphertext-shaped.

- Reading key in the link fragment.
- Authenticated cipher over event values and blobs, **nonce derived from
  `(writer, seq)`** (§6). **That pair is unique only because one identity has
  one chain.** If per-process append points land first (`APPEND-POINTS.md`), the
  nonce input must gain the point or two of one identity's processes reuse a
  nonce under one key — which an authenticated cipher does not survive. Check
  this before building, whichever way the core question goes.
- Derived subkeys for values and blobs.
- A peer without the key: stores, serves, verifies, folds structure, folds no
  bodies (§6.1).

**Decide here:** the cipher, and whether blob encryption is deterministic —
which trades a confirm-a-known-file attack for deduplication (§6).

**Done when:** a headless peer serves an encrypted space it cannot read, and a
browser with the key reads it through that peer.

---

## Stage 11 — The sequence rule

The bet (§3.8), and deliberately late: everything above it works without it, and
by now there is a real system to try it in rather than a harness.

- Sequence as a body rule, elements identified by `(writer, seq)`.
- Tombstones in the fold output; pending inserts on missing anchors.
- **Canonical form specified before the rule is coded** (§3.6) — observable state
  hashed, representation not.
- A collaborative text object in the browser client.

**Done when:** two browsers edit one document concurrently and converge, and the
canonical form is stable across a deliberately different internal representation.

---

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
