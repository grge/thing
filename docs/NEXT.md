# Notes toward the next experiment

**Status: notes, not a spec.** Captured from a scoping conversation, 2026-08-31,
after v0 reached the point where mode 2 works between two desktop browsers and
fails between a desktop and a phone. Nothing here is settled enough to build
from; it exists so the reasoning survives to whenever the next SPEC gets
written. Like v0, the next iteration is a **throwaway experiment**.

The question driving it is not a protocol question. It is: **what is a space —
what does it feel like, how is it shared, how is it found, what can be done to
it, and how does it live out on the internet once it has been handed over?**

## What the product is

**The floor**, which must always work, and against which any horizon idea that
would compromise it loses:

> **A website you go to, where you create a space, share it with peers via a
> link, and drag files into it.**

That is a minimum requirement rather than the end goal. The fuller ambition is
**a very fast, in-browser, Napster-shaped peer-to-peer network** — with network
discovery, and eventually collaborative document editing spaces (mode 3, which
[the CRDT section below](#where-this-is-going-crdts-and-compaction) says is
deferred, not denied).

Worth recording the tension in that comparison, because it points straight at
the hardest unsolved piece: **Napster's defining feature was a central index.**
The peer-to-peer part was the transfer; the *finding* was a server. The systems
that replaced that index with flooding or a DHT were markedly worse at search,
and a browser cannot practically run a DHT at all. So "Napster-shaped, in the
browser" names precisely the problem this project has least answer for — see
*Discovery may stay thin* under Risks. It is the right ambition to hold, and it
should be held with that difficulty in view rather than assumed away.

The ordering that follows: the website floor is what each throwaway iteration
must leave working; discovery is the thing that decides whether the ambition is
reachable; other clients, folder backing and a Python API are directions this
*opens* rather than parts of it.

---

## Settled

**Mode 3 is out.** Concurrent writers and Yjs objects stay deferred. This is the
decision that keeps the round small: [F12](FINDINGS.md#f12-61-argues-from-size-and-the-size-argument-expires)
and [F13](FINDINGS.md#f13-selective-sync-breaks-what-identifies-a-snapshot) only
become mandatory work if mode 3 is in — mode 3 breaks §6.1's size argument,
forces a second selective-fetch mechanism, and requires compaction, which in
turn needs snapshots whose identity F13 shows is not well-defined under
selective sync. Out means the log/blob dichotomy, snapshots, and the wire-format
question all drop back to optional.

**TURN is in.** v0 deliberately configured STUN and no TURN so question 1 could
measure how often peers fail without a relay (`peerjs-signalling.ts`). That
measurement has been taken informally and the answer looks like "phones mostly
fail", which is consistent with carrier-grade NAT. The next round assumes a
relay rather than measuring its absence.

**There is no persistence server.** Persistence is not a capability to build; it
is an emergent role of any peer that stays online. This is a stronger form of
§9's "a pinning peer should be just another peer — same protocol, no privileged
role": rather than build the privileged path and then discipline it, never build
it. The short-term implementation is *keep a browser tab open somewhere*.

**A shared space is out of its creator's control, permanently.** Once shared,
the creator cannot kill it, cannot enumerate where it has gone, and cannot
prevent it being copied and re-shared under a new identity. This is a design
property, not a defect. It is already true in v0 — a reader can copy the
contents into a new writer space and share that.

> This consciously overrides [F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one),
> which treated durable peer lists as making [I7](ISSUES.md#i7-share-codes-cannot-be-revoked-or-rotated)
> worse — "a roster nobody can leave is a worse version of a share code nobody
> can revoke" — and concluded they belonged with signing rather than ahead of
> it. The stance here is that uncontrollability is the intended character, so
> the cost is accepted rather than avoided. Recorded explicitly so it is not
> re-litigated by the next reader of F14.

**Peer list sharing is part of the product**, not an optimisation. The opt-in
and opt-out mechanics are open (see below).

**Ending: no remote detonator.** You can delete your own copy. That is all. A
copy elsewhere is dead data that cannot erase itself. Read-only is enforced by
signing rather than by convention (§7.2's "enforcement is by convention" stops
being true). The only honest form of "this is over" is a **final signed
statement** the creator publishes, which honest clients render and dishonest
ones ignore — a statement, never enforcement. It pairs naturally with
supersession ("moved to X").

**Reciprocity leans toward interlinked spaces, not shared writing.** Undecided,
but the attractive shape is: your reply lives in *your* space, signed by *your*
key, linking to mine. Neither can edit the other. This is the webmention shape
rather than the Google Docs shape, and it buys a social model with no CRDTs, no
compaction, and no reopening of the F12/F13 knot. Single-writer-per-space stops
being a limitation and becomes the unit of authorship.

---

## Open

**Addressing — the hardest unsolved piece.** v0 fuses three things into one
8-character string: the space's *identity*, its local *storage keyspace*, and
its *network location* (`peerIdForCode()` is literally `` `thing-${code}` ``).
That fusion is fine for a star topology with one writer and breaks under
everything above — a mesh makes location many-valued and changing, forks make
identity something that must survive content copying, and links make identity
something that must outlive any particular location.

The three layers want to separate:

| Layer | Wants to be | Changes |
|---|---|---|
| Identity | self-certifying — a public key, or a hash of one | never |
| Location | "who claims to serve this right now" | constantly |
| Human handle | short, typeable, memorable | per-person |

If signing arrives, **space id = public key** does a lot of work at once: forks
become honestly distinct, links become verifiable, identity decouples from
location so a mesh is expressible, and "mode 2 is read-only" becomes arithmetic
rather than convention.

The cost is real: a public key is ~43 characters, and v0's typeable 8-character
code was a deliberate good decision for cross-device sharing. This is Zooko's
triangle — human-meaningful, decentralised, securely unique, pick two. The
standard escape is a **petname system**: self-certifying id underneath, a name
the space suggests, a local nickname each reader can override, and the short
code demoted from identity to bootstrap hint. Note that shortening by truncating
a hash of the key is grindable — 8 characters is ~40 bits.

**Access / authorisation.** Wanted in the long run: publishing a mode 2 space
should not imply it is public to all. But in a system where readers can copy and
re-share, access control governs **admission, never retention** — who gets it
first, never who keeps or passes it on. The mesh sharpens this: once any peer
can serve, any peer is also the enforcement point, and a naive or hostile one
serves anyone. So authorisation here cannot be policy; it has to be
cryptographic, which lands back on §9's per-subtree encryption. Worth stating
plainly so it is not promised as more than it is: **encryption gates who can
read; nothing gates who can retain.**

**Link shape.** The obvious model is a link as an ordinary file with a
particular `:type` (§4.7), which fits the existing renderer registry. The
argument against: that puts the target inside blob content, and blobs are
fetched lazily (§6.1), so the link graph would be invisible until clicked — no
map of what a space points at, no prefetch, no traversal without fetching
candidate blobs. F13's rule applies directly ("whatever determines scope must
itself always be replicated in full"): a link determines what you might want
next, so it is scope-determining and belongs in metadata as a **`:link`
attribute** rather than in a blob.

**Where a link lives — recommendation: an attribute any object may carry, not a
special kind of object, and not a sidecar.**

Three candidates were considered.

*A sidecar list of links outside the filesystem* is the one to reject, on two
grounds. It has nowhere to live: the model has no space-level state, so it would
mean inventing a second kind of state beside the object tree. And it cannot be
laid out — a sidecar entry has no `:pos`, which kills the index-as-map idea
below, where curating an index means both selecting *and positioning* what it
points at. Everything else a sidecar would need — naming, organising, deleting,
moving — already exists for objects and would have to be rebuilt in parallel.

*A dedicated link object type* — an object with a reserved `:type` and no
`:content` — works, and inherits naming, parenting, `:pos`, tombstones and
cross-space moves for free. But it is unnecessarily narrow.

*`:link` as an attribute any object may carry* is better for the same cost. An
object with `:link` and no `:content` is what the UI presents as a portal; an
object with **both** is a card that shows a thumbnail and goes somewhere, which
is exactly what a good index entry looks like. It also fits the existing model,
where objects are bags of attributes and `:kind` is explicitly advisory (§4.6),
and it degrades gracefully in a client that does not implement links — which
matters once a second implementation exists.

Proposed value: `:link = { space: <pubkey>, object?: <uuid> }`. Identity only —
**no locator hints**, since locators are ephemeral and resolving them is the
resolver's job ([ADDRESSING.md](ADDRESSING.md) §5.2). The link object's `:name`
is then the *linker's* petname for the target, which is the right person to be
labelling it.

**Space-level metadata has a home already, and it dissolves the sidecar's one
real advantage.** [F6](FINDINGS.md#f6-root-is-materialised-as-an-object-by-a-total-fold)
established that `ROOT` is materialised as an object by a total fold. So
**attributes on `ROOT` are space-level attributes** — no new concept required.
That is where a space's suggested name ([ADDRESSING.md](ADDRESSING.md) §5.6)
belongs, and where a fork could record `:link` back to what it forked from.

Two sub-decisions remain: whether links target a space or an object within one
(deep links are natural given stable UUIDs, but break across cross-space moves,
which mint fresh UUIDs — [I12](ISSUES.md#i12-cross-space-move-is-a-copy-and-delete-not-a-move)),
and the fact that **backlinks are impossible** — nobody can know who links to
them without being told, exactly as on the pre-webmention web. That constrains
how networked the thing can feel.

**Peer list opt-in / opt-out mechanics.** F14's objection was partly that PeerJS
ids are ephemeral, so a stored roster is stale immediately. But v0 already
claims a deterministic id for writers, which suggests a cheap pattern with no
roster and no identity: a peer willing to serve claims `thing-<code>-2`, `-3`,
…; a joiner probes the pattern until someone answers. Opting in *is* claiming a
slot. It degrades honestly and makes squatting possible, which at POC scale is
itself worth observing.

---

## What becomes load-bearing

[F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one)
separated meshing into three things and recommended doing the first two. All
three are now in scope, and the second changes status:

1. **Metadata relay** — required, or a reader cannot get events from any peer
   that is not the writer.
2. **Blob availability (`HAVE`)** — no longer an optimisation. A version vector
   describes *events*, never *blobs*, so in a mesh where the writer may be gone
   forever, "who holds this file" is otherwise unanswerable.
3. **Peer list sharing** — now product, per the stance above.

A consequence worth designing for: **"is this space alive?" stops being
binary.** Metadata can be complete while specific blobs are permanently gone
because the only peer holding them left for good. v0's `stale` and `unavailable`
states (§8.2, §7.2) assume one writer whose absence explains everything. "This
space is mostly here, and these three files are probably gone" is a new state,
and it is the honest face of a properly distributed system.

---

## Why signing came back

v0 deferred signing (§9) and [I5](ISSUES.md#i5-lamport-clocks-are-unenforceable-so-a-malicious-peer-wins-every-conflict)/[I6](ISSUES.md#i6-hello-is-unauthenticated-any-peer-can-claim-any-writer-id)
recorded the consequences. The uncontrollability stance appears to remove
signing's motivation — if revocation is not a goal, authorisation does not need
enforcing. The opposite is true:

**Giving up control makes signing more valuable, not less.** Anyone can copy a
space's contents and re-share them. Forks are legitimate. But without signing,
nobody can tell a fork from the original, and anyone who copies content can
claim the address and propagate it while the creator has no way to correct the
record. In a system where anyone can copy and anyone can re-share, the scarce
thing worth protecting is not access to a space but the **identity** of one.

Signing's job therefore shrinks and sharpens: **provenance, not permissions**.
No membership, no revocation, no key-management UX for access control. Just:
this space is who it says it is, this fork is honestly a different thing, and
this link points somewhere verifiable.

---

## Prior art

Where this sits relative to systems solving overlapping problems. Useful mostly
for what each got wrong.

| System | Overlap | Lesson |
|---|---|---|
| **Hypercore / Dat** | Closest analogue: append-only signed log addressed by a public key, filesystem view on top, single-writer by design, sparse replication | Multi-writer was genuinely hard (autobase came much later); discovery and NAT were the recurring pain, same as here |
| **Secure Scuttlebutt** | Closest in philosophy: signed append-only feeds, keypair identity, no deletion, "pubs" as always-on peers — precisely the emergent-persistence model above | Immortality is livable but socially uncomfortable; sync cost and mobile were where it hurt; losing a key means losing the identity, permanently |
| **IPFS / IPNS** | Content-addressed immutable blobs; IPNS is the mutable "pubkey names current state" pointer | Content addressing is not persistence — the entire pinning-service industry exists because of that gap. IPNS resolution proved slow and unreliable |
| **Nostr** | Signed events, pubkey identity, dumb replaceable relays, deletion is an advisory request relays may ignore | Dumb-relay + client-side verification is robust and simple. Key loss is the dominant UX wound. NIP-05 solves human-readable naming by leaning on DNS |
| **BitTorrent** | Swarm of peers with `HAVE` bitfields, infohash as content id, seeders as persistence-by-someone-caring | Direct prior art for the blob-availability exchange F14 asks for |
| **Git** | Content-addressed objects, clone-is-fork, deletion impossible once cloned, provenance via signed commits | The social layer (GitHub) centralised precisely because identity and discovery were not in the protocol |
| **Tahoe-LAFS** | Read-caps and write-caps: the capability string *is* both address and decryption key | A clean answer to the access axis that composes with no-revocation: access control is who you hand the cap to |
| **IndieWeb / webmention** | Reply lives in your own space and links back | The reciprocity model above, already tried at web scale |

**The distinctive bet:** every close analogue either runs a persistent local
daemon (SSB, hypercore, IPFS) or gives up peer-to-peer for relays (Nostr). This
project is attempting browser-only *and* peer-to-peer, which is the quadrant
nobody has convincingly occupied. That is either the interesting part or the
reason it will stay hard — worth being conscious of which.

What is genuinely under-explored: the prior art is infrastructure (IPFS,
hypercore), social feeds (SSB, Nostr), or code (git). **A folder you can hand to
someone, with links between folders**, aimed at casual sharing rather than
developer infrastructure, is not well covered by any of them.

---

## Risks worth naming now

**Key loss is catastrophic and browser storage is fragile.** If space identity is
a keypair in browser storage, clearing site data permanently destroys the ability
to write to your own space — no recovery, no recourse, and no way to tell
readers. Safari evicts localStorage and IndexedDB for sites without recent user
interaction (roughly a week), which makes this a routine event rather than an
edge case. SSB and Nostr both show key loss is where ordinary users fall off.
Any design that makes identity a key needs an answer here — export, escrow,
multi-device, or an explicit "identities are cheap and disposable" stance.

**Discovery may stay thin.** Without a DHT — impractical in a browser — discovery
rides on the signalling server or on links handed over out of band. The "network"
feeling depends almost entirely on links doing that work, which raises the stakes
on getting the link model right.

**Availability is what it will be judged on.** "Keep a tab open" is fine for an
experiment, but the felt experience of a space going dark is "my stuff
disappeared", and that is the usual reason peer-to-peer systems lose to hosted
ones.

---

# Where this is going: CRDTs and compaction

**Not v1 scope.** Both are deliberately out of the next iteration. This section
exists because the *destination* constrains what v1 should avoid foreclosing,
and because the reasoning is expensive to reconstruct. The short version is at
the bottom, as five things worth preserving.

They break different layers, and the damage is asymmetric.

## CRDTs (mode 3)

**What survives — more than §7.3 implies.** The envelope claim is true:
`{target, attr: ":yjs", value: <bytes>}` needs no change to §2. Per-writer hash
chains do not care what events contain. Version vectors do not care. And §1.3
survives: Yjs updates are commutative, associative and idempotent among
themselves, so a fold that accumulates them stays order-independent, and
`fold.test.ts`'s shuffle extends to cover them.

**What breaks:**

1. **The fold's resolution rule.** `Acc` in `fold.ts` is `(value, winningKey)`
   per attribute — *"every field is a max over a set, hence commutative"*. LWW is
   baked in as *the* operator. A `:yjs` attribute is the inverse: retain and
   merge every update, never discard the loser. The fold goes from one operator
   to **one operator per attribute**. Real, but additive, and both operators are
   commutative so the correctness argument composes.

2. **Volume, which breaks first and least elegantly.** §4.5 requires the deleted
   predicate be computed over the whole set, never incrementally, and the fold
   honours that by recomputing everything. [I2](ISSUES.md#i2-every-write-re-serialises-and-re-folds-the-entire-log)
   already records `JSON.stringify(all events)` *and* `fold(all events)` per
   write, with the localStorage quota around 28k events. Keystroke-granularity
   updates hit that in one editing session. The practical wall arrives long
   before any question of elegance.

3. **Network and trust, which §7.3 does not mention.** Many writers means the
   star topology (§3.4) has no centre, the reader/writer tab split (§8.6) stops
   being binary, and [I5](ISSUES.md#i5-lamport-clocks-are-unenforceable-so-a-malicious-peer-wins-every-conflict)/[I6](ISSUES.md#i6-hello-is-unauthenticated-any-peer-can-claim-any-writer-id)
   go from bounded to unbounded — I5 says so itself. **Signing becomes
   mandatory**, which the direction above already assumes.

## Compaction

**What survives.** Commutativity is what *makes* snapshots work (§5 says so).
Blobs are unaffected — immutable, no history. The fold's purity is unaffected;
it is seeded with a state rather than an empty one.

**What breaks:**

1. **The hash chain and gap-fill — the sharpest break.** §3.2 chains by `prev`;
   §3.3 holds unmatched events aside and re-issues `GAP` forever with no timeout,
   deliberately ([I10](ISSUES.md#i10-a-permanently-missing-event-stalls-a-writers-chain-forever)).
   Compaction deliberately deletes events. The protocol **cannot distinguish
   "missing, in flight" from "gone, compacted"**, so a peer asking for a
   truncated range stalls permanently, loudly. Needs a new wire concept —
   `TRUNCATED { writer, upto, snapshot }` or similar — plus a fold that can start
   from a snapshot rather than genesis.

2. **The VV stops answering one question.** §3.1 is "highest contiguous seq
   held". After truncation a peer *knows* the effect of A@0–20 but cannot *serve*
   them. That needs two quantities: a **knowledge frontier** and a **retention
   floor**. This is [I11](ISSUES.md#i11-version-vectors-cannot-express-i-hold-this-event-but-not-its-predecessor)'s
   expressiveness gap from the other side.

3. **§5's safety rule becomes unimplementable under the stance above.** §5 says
   truncation must never drop below the minimum VV of any peer still being
   served, with a pinning peer tracking known-peer VVs and holding a floor. But
   a shared space is now uncontrollable and its peers unenumerable — **you
   cannot hold a floor for peers you cannot see**. So compaction here is
   necessarily unsafe-by-default, and snapshots stop being an optimisation and
   become the *only* recovery path for a peer that fell behind. §5 needs
   rewriting, not just implementing.

4. **Compaction pulls against signing.** If identity is verified through the
   signed chain, a compacting peer asserting "this is the fold of A@0–20" is not
   A, and a reader trusting only A's key cannot verify it. Resolution: **only the
   writer may compact its own chain**, and a snapshot is a writer-signed
   checkpoint referencing the last event's hash, becoming a new genesis.
   Single-writer-per-space makes that invariant free.

## The circularity

Mode 3 **requires** compaction (§5 and §7.3 both concede Yjs accumulation is
unbounded), and compaction gets **harder** under mode 3, because a shared space
spans many chains each needing its own author's attestation, so "only the writer
compacts" stops being simple.

Therefore: **compaction is cheap now and expensive after mode 3.** If both are
wanted eventually, snapshots are substantially easier while spaces are still
single-writer — even though CRDTs are the more interesting feature. Worth
resisting the instinct to sequence by excitement.

## What Yjs already does, and why it does not rescue the outer log

Yjs does a lot of this internally, and knowing which parts matters.

**It does compact.** Garbage collection is on by default: deleted content is
dropped and replaced by a struct retaining only the id range. Deletions live in
a range-encoded *delete set*, so tombstones compress to intervals rather than
one per character. `Y.mergeUpdates()` collapses a set of updates into one
equivalent update. `Y.encodeStateAsUpdate(doc)` produces a single update that
reconstructs the whole document — effectively a snapshot. It even has the same
shape of machinery as §3.1: item ids are `(client, clock)`, and
`Y.encodeStateVector()` plus a diffing `encodeStateAsUpdate(doc, sv)` is exactly
"send me what I lack".

**What it does not compact away:** the identity skeleton. Even under GC the id
ranges of deleted items survive, because a concurrent update referring to a
deleted position must still resolve. Documents grow monotonically with edit
history — far slower than a naive op log, but they do not shrink to the size of
their content.

**The part that matters here:** there are two logs, and Yjs only compacts one.
If each update is wrapped as an outer event in a per-writer hash chain, **the
outer log accumulates one event per update forever and Yjs's GC cannot touch
it** — the outer log sees opaque bytes chained by hash, and compacting it means
deleting from a hash chain, which is breakage (1) above. Yjs's compaction
operates on precisely the structure the outer log refuses to let it have: the
append-only, hash-chained, gap-detectable properties are what forbid merging the
updates in place.

**So the natural architecture is to stop wrapping every update as an event.**
Let Yjs be the log for `:yjs` attributes: live collaboration rides the data
channel directly (Yjs update exchange, state-vector diffed), and the outer log
carries only **occasional checkpoint events** holding
`Y.encodeStateAsUpdate(doc)` — merged and GC'd. The outer log's job becomes
durability, handoff and replay rather than real-time transport. This is roughly
what `y-webrtc` plus `y-indexeddb` do together, and it dodges most of the
breakage above by never putting keystroke-granularity events in the chain.

Two honest costs of that shape:

- **Checkpoints are merges, so authorship blurs.** A checkpoint of concurrently
  edited state is a function of several writers' contributions; whoever signs it
  attests "I observed this state", not "I authored this". For a trust model whose
  point is provenance, that is a real semantic downgrade, and it is the place
  where multi-writer and signing genuinely conflict.
- **Intermediate history is not recoverable.** A peer that was offline receives
  the checkpoint, not the keystrokes. Normal for collaborative editors, but it
  means the event log stops being a complete history for `:yjs` objects, which
  contradicts the append-only-log-is-the-truth framing elsewhere.

Resolution rule for such an attribute is not LWW but "merge every checkpoint
held" — commutative and idempotent, so §1.3 still holds.

*(Yjs specifics above are from general knowledge and worth re-verifying against
the current library before anything is designed on top of them.)*

## Five cheap things to preserve

None cost much now; each is expensive to retrofit.

1. **Make the per-attribute resolution rule dispatchable**, not hardcoded LWW —
   even while every attribute is LWW.
2. **Let the wire express "gone" as distinct from "missing"**, even if nothing
   sends it yet.
3. **Split the VV's two meanings in the type** — knowledge frontier, retention
   floor — even while they are always equal.
4. **Hold "only the writer compacts its own chain" as an invariant.** Free under
   single-writer, and it is what keeps snapshots verifiable once signing lands.
5. **Snapshot the accumulator, not the rendered state.** `Acc` carries
   `(value, winningKey)` per attribute plus `kill`/`live`; `ObjectState` — what
   `fold()` returns — **drops every key**. A snapshot of `State` is therefore
   lossy: a straggler with an earlier lamport cannot be resolved against it. A
   snapshot of the `Acc` map merges late arrivals by the same max rules with no
   special-casing, and keeps §4.5's predicate intact across the truncation
   boundary. v0 already has the right shape one layer below its public API — do
   not let `Acc` become unreachable from outside `fold()`.

---

# Horizon: other clients, and storage as a seam

**Not v1 scope, and not a change of direction.** The product is the website (see
above). This section records what a second client implementation would buy and
cost, because two of its constraints — the canonical encoding, and the
folder-mapping question — are things v1 could foreclose by accident.

The starting observation is that **localStorage is not a design property**. It
is the most convenient backing for a browser, nothing more. Once storage is a
seam rather than an assumption, several things follow: a CLI or TUI client, a
Python API, and spaces backed by an ordinary directory — which is also how a
pinning peer would work, without ever becoming a privileged role.

## The real payoff is that a second implementation tests the spec

There is currently exactly one implementation, so every ambiguity in SPEC.md is
silently resolved by whatever the TypeScript happens to do. A second one
surfaces them immediately, and the important ones are unforgiving:

- **§2.1's canonical encoding must match byte for byte.** A difference in field
  order, length prefixing or integer encoding means every `EventId` and every
  `prev` disagrees, and nothing syncs at all. This is the highest-risk interop
  surface and it bears directly on the protobuf question: fine as a wire format,
  dangerous as the *hashed* one, because protobuf is not deterministic by spec.
- **JS numbers are float64; Python integers are arbitrary precision.** `lamport`
  and `seq` are exact only to 2^53 in a browser. §2.1's "no floats in hashed
  positions" is currently aspirational; a second implementation is what makes it
  enforced.
- Then the subtler ones: the §3.1 contiguity rule, §4.5's `kill`/`live`
  predicate, and cycle-breaking's tie-break.

This is **mechanically checkable**, in the spirit of §1.3's shuffle test: a
shared corpus of fixture vectors — event sets in, canonical bytes and folded
state out — that every implementation must reproduce.

**But a second implementation is a commitment device.** It is enormously
valuable for spec quality and enormously expensive for spec churn: nobody
casually rewrites a protocol with three clients. So it belongs *after* the
throwaway experiments, not during them. Build it when the goal is to stop
changing things.

## Folder-as-repository and folder-as-working-tree are different features

Git separates these for exactly the reasons that would bite here.

**Folder as repository** — a `.thing/` directory holding the log and
content-addressed blobs, opaque to the user. Lossless, no mapping problems, and
it is all a pinning peer actually needs. It also dissolves
[I2](ISSUES.md#i2-every-write-re-serialises-and-re-folds-the-entire-log): the
quota was never a design property.

**Folder as working tree** — materialised files edited with ordinary tools. Much
harder, because the model deliberately permits what no filesystem can represent:
sibling name collisions (§4.2), a `dir` with content and a `file` with children
(§4.6), cycle-broken markers (§4.1), tombstoned objects that still exist (§4.5),
and names that are empty, contain `/`, or collide case-insensitively on macOS
and Windows. Every one is a case v0 renders deliberately rather than rejecting,
so materialising means choosing a lossy resolution for each.

**The write direction is worse.** A rename in Finder is indistinguishable from a
delete-plus-create in a filesystem diff, but the two produce very different
events: a rename preserves the UUID, its history, and any inbound links pointing
at it. Git can infer renames heuristically because commits are explicit; here
events *are* the truth, so a naive watcher generates semantically wrong history.
First pass should be **explicit CLI verbs** (`thing mv`, `thing rm`), not
filesystem watching — magic sync needs a sidecar path→UUID index and inode
tracking, and is a much later problem.

## Transport is already a seam, and that has a payoff

Python speaking WebRTC is awkward — `aiortc`, plus PeerJS's own signalling
protocol layered on websockets. But it probably is not needed: `peer.ts` is
written against a `Channel`/`PeerLink` interface with PeerJS behind it, and
FINDINGS' method notes already credit that indirection for localising a failure
in one step. HELLO/EVENTS/GAP/WANT/BLOB can travel over a plain websocket.

Which yields something worth noticing: **an always-on peer with a public address
needs no NAT traversal at all.** Browsers open a websocket to it directly. A
space with one public peer in it is reachable by everyone, with no hole-punching,
no ICE, no TURN. That does not remove the need for TURN — two phones talking
directly still need it — but the "keep something online" problem and the
connectivity problem partly solve each other.

Such a peer is privileged in **reachability** but not in **protocol** — same
messages, same role, no special path — which keeps it inside §9's constraint.
Worth stating that way explicitly so the distinction survives contact.

## Where the seams are today

- `peer.ts` already defines `BlobStore` and `EventLog` **interfaces**, so the
  transport half is abstracted from storage.
- `storage.ts` is flat free functions calling `localStorage` and `indexedDB`
  directly, and `Space` imports them straight in — so **no storage seam exists at
  the `Space` layer**. That is the concrete refactor this direction implies, and
  it is modest: an interface with a localStorage implementation behind it.

## The direction it opens

A Python API makes spaces a substrate for automation and data interchange — a
script publishing results into a space, a dataset shared without a bucket —
which is a different thing from human file-sharing. Worth being conscious of as
a possibility without letting it displace the website.

---

# Discovery, indexes, and what wandering should feel like

## The tension

Two things already settled pull against each other:

- **Uncontrollability**: once shared, a space's creator cannot see where it went,
  cannot enumerate who holds it, and cannot recall it.
- **The Napster-shaped ambition**: people should be able to *find* things they
  were never handed a link to.

Findable-by-strangers and invisible-to-its-author are not obviously compatible.
A global index would resolve it by contradicting the first, and a central
registry is against the project's grain regardless.

## The resolution: an index is just a space someone publishes

A signalling server — or anyone at all — may choose to publish an index, and
**the index is itself an ordinary space**. Same protocol, same fold, same
replication, no privileged mechanism.

This works because it needs *nothing new*. Given links as `:link` attributes and
spaces that anyone can publish, **an index is an emergent artifact rather than a
feature**: a space whose contents are links to other spaces.

It resolves the tension by making listing a **curatorial act by a third party**,
not a global property of a space:

- A creator does not control whether they are listed — consistent with
  uncontrollability.
- Being listed requires *someone else* to have chosen to list you — so discovery
  is opt-in on the curator's side, and plural.
- Many indexes can coexist, overlap and disagree. An index can be forked,
  linked, and curated differently, like anything else.

The precedent is the pre-search-engine web: curated directories, webrings,
del.icio.us. Napster's index was one server; this is many, and none of them is
load-bearing.

**Wrinkles worth knowing:**

- **Link rot is the whole operational cost.** An index lists spaces; spaces go
  dark when nobody serves them. Without pruning, an index decays into a
  graveyard, and pruning means the curator actively probing. An index is only
  as good as its curator's diligence.
- **A signalling server is unusually well placed to build one automatically**,
  because it already sees which rendezvous slots are claimed and joined. "Spaces
  I have seen peers for recently" is nearly free for it to produce.
- **Which makes "unlisted" a concept that has to exist.** That capability is not
  new leakage — the signalling layer already sees rendezvous traffic — but
  publishing it turns incidental knowledge into deliberate exposure. It bears
  directly on [ADDRESSING.md](ADDRESSING.md) §5.3's open sub-decision: a
  rendezvous code *derived* from the key means anyone holding the key can find
  you and the signalling server can enumerate activity, whereas an *independent*
  code can be kept out of band. Wanting unlisted spaces argues for keeping the
  independent option alive.

## The feel: Your World of Text

The reference for how discovery plus mode 3 should feel is **yourworldoftext** —
wandering, and serendipitously finding interesting things other people are
working on in real time. Worth decomposing, because its feel is made of four
separable things:

1. **Spatial continuity** — one continuous coordinate space, so wandering is
   movement rather than search. Discovery is a side effect of travelling.
2. **Ambient presence** — other people visibly there, live. The place feels
   inhabited.
3. **Persistent traces** — what people made stays, so wandering finds
   accumulated history, not only current activity.
4. **No friction** — arrive and type; no account, no setup.

**But YWOT is a hybrid, not purely spatial.** It also has *named* worlds that
link to each other, so wandering there is already a mix of roaming a continuous
surface and jumping between named places. That matters, because the named-jump
half is the part this project can do natively — the achievable version is closer
to the reference than a purely spatial reading would suggest.

**The spatial half is still where the models genuinely differ.** YWOT's
continuity comes from a *single shared coordinate space*, which is exactly what
its server provides. This project is many independent spaces with no shared
coordinate system and therefore no adjacency — and without adjacency you cannot
roam, you can only jump.

Two ways to get there, and they are not the same thing:

- **Links as adjacency.** Wandering means traversing `:link`s. Web-shaped or
  webring-shaped: real serendipity, no continuity. You hop rather than roam.
  Cheap, and already in scope.
- **A shared coordinate space.** Requires a coordinate system spanning spaces,
  which sounds like it needs a global namespace — against the grain.

**Except it does not, and the pieces are already lying around.** `:pos` already
exists (§4.4) and the fold already resolves it; the canvas was v0's stage 6 and
was never built. An **index space whose entries carry `:pos` is a map**: a
curator both selects *and lays out* a set of spaces, and you pan around their
world and enter what you find. Many maps can exist, each a different curated
world, with no global namespace and no authority.

That gives a much stronger reason to build the canvas than it previously had.
Stage 6 was "a different view of a file tree"; this makes it **the way you wander
the network**.

## Presence is not mode 3, and presence is cheap

Item (2) above is worth separating out, because it is easy to assume it needs
collaborative editing and it does not. **Presence is ephemeral**: who is here,
where they are looking, maybe a cursor. It never needs to enter the log, never
needs compaction, never needs a CRDT — it is transient state exchanged over the
data channel and discarded.

So a large fraction of the YWOT feel — the sense that a place is *inhabited* —
is available long before mode 3, at a fraction of the cost. Worth knowing when
sequencing: if the goal is the feel, presence buys more of it per unit of work
than collaborative editing does.

## The honest difference

YWOT is server-based and that is not incidental: one server is what makes one
coordinate space, one presence fan-out, and one persistent world possible.
Getting the feel without it means accepting that a "world" is a **curated,
partial, forkable view** rather than the canonical one.

That may be better — many worlds, no owner, anyone can make one — or worse: no
shared reference point, everyone wandering separately in different rooms, and
the population of any one map too thin to ever bump into anyone. **Which of
those it turns out to be is a real question, and probably only answerable by
building one and seeing whether it feels populated.**

## IRC, and the limit of the social model

The other precedent worth holding is **IRC**: within a channel you hear about
other channels, they have different permission models, and access is negotiated
socially — you ask someone you already know.

What transfers, and cheaply:

- **Discovery by mention, not by directory.** Hearing about a place *inside*
  another place is word of mouth rather than a registry, and it is exactly the
  index-as-a-space shape above, informally. IRC has `/list`, and on most networks
  it is discouraged and unusable — the informal path is the one that works.
- **Two of IRC's channel modes already exist here for free.** `+k` (keyed) is the
  share code; `+i` (invite-only) is simply not publishing the link. Admission by
  handing someone a capability is the model this project already has.

**What does not transfer is the op.** IRC's social texture depends on someone
being able to kick and ban — to say no *after* the fact and have it stick. That
requires a chokepoint and an authority, which is exactly what uncontrollability
gives up. So the IRC feel is available for **admission** and not for
**exclusion**: "invite-only" here degrades to "I chose who to hand it to, and
after that it is out of my hands."

The eventual shape for exclusion, if it is ever wanted, is not moderation but
**key rotation**: re-key the content going forward, so a removed reader keeps
everything they already had and receives nothing new. That is how secure group
messaging handles the same problem, and it is honest about what it can and
cannot undo — which suits the rest of this design better than a moderator role
would.
