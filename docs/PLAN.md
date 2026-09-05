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
  core/             fold, rules, canonical encoding, signing        no I/O
  net/              protocol, sync, blob transfer, resolution       no platform
  store/            storage interfaces + browser and node backends
  peer/             a peer: core + net + store, wired together
  web/              the browser client — UI, WebRTC transport
  node/             the headless peer — WebSocket transport, CLI
```

The split is not ceremony. `core` and `net` must be platform-free or the headless
peer cannot exist, and making that a package boundary is what stops a
`localStorage` call drifting in.

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

## Stage 0 — Scaffold and archive

Move `src/` and `proto/` to `archive/`. Set up the workspace, TypeScript project
references, one test runner across packages, and CI. Write the property-test
helpers, because every later stage leans on them.

**Done when:** `npm test` runs green over an empty-but-wired workspace, the
archived tree is untouched and unbuilt, and **the platform boundary is enforced
by the compiler** — `core`, `net`, `store` and `peer` build with `"types": []`
and an ES2022-only `lib`, so a `localStorage` reference in any of them is a
compile error.

**Done.** The boundary is asserted by a test over the tsconfigs as well, since
widening `types` to fix one import would otherwise silently lose the property.

---

## Stage 1 — `core`: events, encoding, signing

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

## Stage 2 — `core`: the fold

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

## Stage 3 — `store`: persistence

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

## Stage 4 — `peer`: a space, folded and persisted

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

## Stage 5 — `net`: protocol and sync

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

---

## Stage 6 — `node`: the headless peer

Now, not later, because it is what proves `core` and `net` are platform-free.

- WebSocket server speaking the stage 5 protocol.
- Serve spaces from disk; join a space by key; stay online.
- A CLI: create, join, list, serve.
- No fold required to serve (§8) — but it folds anyway, because it is the same
  code.

**Done when:** two `node` peers on one machine sync a space over WebSockets, one
restarts and resumes from disk, and neither imports anything browser-specific.

---

## Stage 7 — `web`: the browser client

- WebRTC data channels; signalling behind the stage 5 interface.
- Browser storage backend from stage 3.
- A view over folded state: tree, preview, drag-in.
- Share links, the derived short code, trust on first use (§5.4).
- An exclusive lock per space (§7.3), so two tabs cannot fork one key.

**Done when:** two browsers sync a space; a browser syncs with a stage 6 headless
peer; and the failure modes — no peers, unreachable, key missing — say something
true.

---

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
  surfaced rather than silent.

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
  `(writer, seq)`** (§6).
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
| 8 | Can a space be found and stay alive? |
| 9 | Does multi-writer stay as cheap as §7.2 claims? |
| 10 | Can infrastructure exist without custody? |
| 11 | Does the vocabulary hold, or does §3.8 bite? |

Stages 1–7 produce a working single-writer synced filesystem with a headless
peer — a real thing, and the point at which the design has been tested by use
rather than by argument.
