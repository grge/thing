# Notes toward the next experiment

**Status: notes, not a spec.** Captured from a scoping conversation, 2026-08-31,
after v0 reached the point where mode 2 works between two desktop browsers and
fails between a desktop and a phone. Nothing here is settled enough to build
from; it exists so the reasoning survives to whenever the next SPEC gets
written. Like v0, the next iteration is a **throwaway experiment**.

The question driving it is not a protocol question. It is: **what is a space —
what does it feel like, how is it shared, how is it found, what can be done to
it, and how does it live out on the internet once it has been handed over?**

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

Two sub-decisions attached: whether links target a space or an object within one
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
