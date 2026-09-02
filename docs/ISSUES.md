# Known issues — v0 POC

What is currently wrong, how much it matters, and whether v0 should care. The
design these are measured against is [DESIGN.md](DESIGN.md).

**Relationship to [FINDINGS.md](FINDINGS.md).** Findings record *evidence* — what
happened, when, with what data — and are append-only: a finding is never edited
when the issue it describes is fixed, because the reasoning is the point. This
file records *state*, is mutable, and links to the finding that established each
issue rather than restating it.

Severity is about v0, the throwaway POC — not about a product.

| | Meaning |
|---|---|
| **Bug** | Wrong behaviour reachable today. Fix or record why not. |
| **Limit** | Works as designed; the design runs out. Bounded by POC scale. |
| **Rewrite** | v0's design is insufficient for where this is going. Not a v0 obligation. |
| **Fixed in v1** | Was a Rewrite; the v1 work that resolves it has landed. Kept for the reasoning. |

**"Rewrite" is a scheduling label, not a verdict on the codebase.** It means the
issue is deferred past v0, not that v1 starts from an empty directory — see
[V1.md](V1.md), which settles that v1 is reachable by incremental edits to v0's
source, with no migration owed to anything v0 wrote.

---

## Open — worth fixing in v0

### I1. A space occasionally refuses writes until reload — **Bug**
*[FINDINGS F9](FINDINGS.md#f9-open-a-space-occasionally-refuses-new-files-or-folders-until-reload). Not reproduced.*

Creating a file or directory silently does nothing; a refresh always clears it.
Refresh fixing it points at in-memory state rather than the log.

The only issue here that is an outright defect with no design excuse.

### I2. Every write re-serialises and re-folds the entire log — **Limit**

`Space.commit()` does `JSON.stringify(all events)` into localStorage *and*
`fold(all events)` on every mutation. Both are O(n) per write.

At ~185 bytes/event serialised: 5k events ≈ 0.9 MB, 20k ≈ 3.5 MB, and
localStorage's quota is typically 5–10 MB **per origin, across all spaces**. So
roughly 28k events fills it, with no warning and no recovery path — `setItem`
throws and the write is lost.

Re-folding is deliberate (§5 says mode 2 spaces replay from event zero, and an
incremental fold is exactly what would quietly break §1.3). Re-serialising is
not deliberate; it is just the simplest thing that worked.

Cheap partial fixes: append-only storage rather than rewrite, and catching the
quota error so a full space says so instead of silently dropping writes.

### I3. Losing side of an LWW conflict is invisible — **Bug**

§4.3 says a losing blob "is *not* lost — it is content-addressed and still
referenced by its event. Recovering it is a UI feature."

That UI does not exist. Concurrent `:content` writes silently discard one, with
no indication it happened. The data is genuinely recoverable from the log, which
makes this a presentation gap rather than data loss — but the user cannot tell
the difference, and §4.5's own argument is that *apparent* data loss erodes
trust as badly as the real thing.

### I4. A reader cannot stop syncing without deleting the space — **Limit**

A joined space replicates for as long as it is open. There is no pause, no
disconnect, no "keep what I have". The only exit is deletion, which discards the
local log.

---

## Open — accepted for v0, input to the rewrite

### I5. Lamport clocks are unenforceable, so a malicious peer wins every conflict — **Fixed in v1**

*[FINDINGS F5](FINDINGS.md#f5-lamport-writer-is-only-a-total-order-because-a-writers-own-lamports-strictly-increase), SPEC §2.2*

**Fixed by signing (v1 step 1).** An inflated Lamport stamp changes the signed preimage, so the event no longer verifies and is dropped at the wire boundary. See [DESIGN.md](DESIGN.md) §5.

LWW resolves on `(lamport, writer)`. Nothing on the wire constrains `lamport`, so
a peer that stamps `MAX_INT` wins every conflict on every attribute, forever.
`checkWriterLamports()` catches *accidental* violations; a malicious creator
ignores it.

This is not fixable by validation — it needs either signing plus a trust model,
or a clock a peer cannot unilaterally advance. SPEC §9 defers signing; this is
the concrete reason it eventually cannot be deferred.

Note the blast radius is bounded by who can write: in mode 2 the writer is the
only legitimate writer, so this matters when readers can forge (I6), and in mode
3 where everyone writes.

### I6. `HELLO` is unauthenticated; any peer can claim any writer id — **Fixed in v1**

*SPEC §7.2, §9, §10.1*

**Fixed by signing (v1 step 1).** Every event is verified against the key in its own `writer` field, so claiming another writer's id fails on its own terms. `HELLO` itself is still unauthenticated, but it no longer grants anything — a peer that lies in the handshake still cannot produce events that verify. See [DESIGN.md](DESIGN.md) §5.

Mode 2's "readers do not write" is convention. A modified client can forge events
under the writer's id and the space accepts them; the hash chain does not help,
because a forger controls the whole chain it fabricates.

Acceptable among peers invited by URL, which is what §7.2 assumes. Not acceptable
once a share code circulates (I7) or a hosted peer exists.

### I7. Share codes cannot be revoked or rotated — **Rewrite**

A code grants permanent read access to anyone who ever sees it. There is no
rotation, no eviction, and no way to see who has joined beyond who is currently
connected. Deleting and recreating the space is the only revocation, and it
changes the space id.

Nothing to revoke *with* until there is identity (I6).

### I8. No compaction, so logs grow without bound — **Rewrite**
*SPEC §5, deferred*

Every rename, move and delete is retained forever. §5 sketches snapshots but v0
implements none, and I2 gives the practical ceiling. A long-lived space
eventually stops working.

Sharpened by [FINDINGS F13](FINDINGS.md#f13-selective-sync-breaks-what-identifies-a-snapshot): once sync becomes selective, a snapshot's
*identity* stops being well-defined, so compaction gets harder rather than
easier as the design grows.

### I9. Star topology makes the writer a single point of failure — **Rewrite**
*SPEC §3.4, §7.2*

Readers connect only to the writer. Writer closes the tab and no reader can fetch
any blob it does not already hold — even one another reader has. §7.2 names this
as the gap a pinning peer fills.

A mesh needs a blob-availability exchange, since a version vector describes
*events* and never *blobs*. [FINDINGS F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one)
separates the three changes meshing would involve — metadata relay, blob
availability, and peer-list sharing — which have very different costs.

### I10. A permanently missing event stalls a writer's chain forever — **Rewrite**
*SPEC §3.3, §10.2*

Events after a hole are held aside and never applied. Gap-fill retries on a
backoff and logs loudly, but there is no resolution and no timeout. In mode 2
this stops the entire space.

Loud-and-stuck is a deliberate v0 choice — the alternative is applying a chain
with holes, which breaks the guarantee §3.3 exists to provide.

### I11. Version vectors cannot express "I hold this event but not its predecessor" — **Rewrite**
*SPEC §3.1*

A peer holding 0,1,2,4 reports 2, correctly: reporting 4 would suppress the send
of 3. But it can then never tell the sender it already has 4.

The wasted bandwidth is the small half. The real cost is that under repeated
gaps, the same events are re-sent every round with no mechanism for the receiver
to say "stop sending 4" — a liveness smell rather than an efficiency one.

### I12. Cross-space move is a copy-and-delete, not a move — **Limit**
*SPEC §8.5*

New UUID, fresh events in the destination, tombstone in the source. No history
follows. The spec is explicit about this and the UI reflects it, but the gesture
looks like a move and is not one.

Inherent to spaces having independent UUID spaces and writer identities; fixing
it means a cross-space identity relation, which v0 does not have.

### I13. One blob store shared across spaces leaks existence between them — **Rewrite**
*SPEC §8.5, §9; [FINDINGS F12](FINDINGS.md#f12-61-argues-from-size-and-the-size-argument-expires)*

Blobs are content-addressed and shared, so a `WANT` is answered from one store
regardless of which space the requester belongs to. A peer therefore learns
whether this device holds given bytes, independent of whether it can see the
space that references them.

Harmless among trusted peers; incompatible with §9's per-subtree encryption,
where the whole point is that a peer holding ciphertext cannot be trusted.

### I14. Truncated 16-byte hashes are not adversary-resistant — **Rewrite**
*SPEC §2.1, §10.6*

`prev` and `EventId` are SHA-256 truncated to 16 bytes: a ~2^64 birthday bound,
far beyond POC scale for *accidental* collisions. A motivated adversary is a
different calculation, and dedup is by `EventId`, so a collision silently drops
an event.

### I15. Whole-blob integrity only, so one bad chunk costs the whole transfer — **Limit**
*SPEC §6, §10.4; [FINDINGS F3](FINDINGS.md#f3-first-successful-transfer-4-mb-hash-verified-16-mbs-on-loopback)*

No per-chunk hashes. A 50 MB blob failing on its last chunk re-fetches 50 MB.
Chunk size and retry granularity are both untuned — F3 measured a clean transfer,
so retry frequency under loss is unmeasured.

### I16. Cycle breaking picks a deterministic but arbitrary victim — **Limit**
*SPEC §4.1*

Within a cycle the lexicographically smallest UUID is re-parented to ROOT.
Peer-identical and cheap, but unrelated to what the user intended, and the
`cycle-broken` marker is the only signal.

Any better rule needs information the fold does not have.

### I17. Renderer selection has no story for active objects — **Rewrite**
*[FINDINGS F11](FINDINGS.md#f11-renderer-selection-bytes-are-not-enough-once-objects-are-apps)*

`:type` (§4.7) fixed format replication for passive content. Objects whose state
lives in the log rather than a blob — Yjs documents, boards — need a renderer
contract shaped around *"here is your object's event stream"*, which does not
exist.

### I18. Two selective-fetch mechanisms with incompatible completeness models — **Rewrite**
*[FINDINGS F12](FINDINGS.md#f12-61-argues-from-size-and-the-size-argument-expires), [F13](FINDINGS.md#f13-selective-sync-breaks-what-identifies-a-snapshot)*

Blobs fetch on demand with no completeness tracking; log events replicate wholly
with completeness tracking. Mode 3 needs on-demand log payload, which is a second
parallel mechanism for the same problem — and selective sync then breaks what
identifies a snapshot.

The useful constraint out of F13: **whatever determines scope must itself always
be replicated in full.**

### I21. No touch path for re-parent or cross-space move — **Limit**
*[MOBILE.md](v0/MOBILE.md)*

Re-parenting a tree entry and moving a file across space tabs (§8.5) are both
native HTML5 drag-and-drop, which mobile browsers don't make touch-operable.
The rest of the app — joining, browsing, previewing, and (once built)
non-drag content-in — is planned to work on a phone; these two gestures are
deliberately left desktop-only for v0 rather than attempting a touch
drag-and-drop implementation, which is a separate UI problem on its own.

### I22. One writer, two tabs: the second cannot claim the rendezvous slot — **Limit**
*Observed 2026-09-02 while testing v1 step 2. Pre-existing since v0.*

A writer registers with signalling under the peer id its code names, so a second
tab holding the same space finds the slot taken and PeerJS aborts
(`Error: ID "thing-…" is taken`). The tab still works locally — the log, the
fold and all write gestures are unaffected — but it does not replicate.

**Not introduced by derived codes.** v0 had the same single-claimant slot, keyed
off a random code rather than the key; deriving the code from the key
(DESIGN.md §4.3) changed what the string is, not how many peers may claim it.
It surfaces more readily now only because the same key on two devices derives
the same slot deterministically, where v0's random code differed per space.

**The slot has been accidentally preventing something worse — see
[I23](#i23-two-tabs-holding-one-space-key-fork-the-writers-hash-chain--bug).**
Making "the slot is taken" survivable, as this issue asks, would let a second
tab replicate — and two tabs holding the same key fork the per-writer chain.
Fix I23 first; this issue is only about reachability once that is safe.

After that, the slot pattern [NEXT.md](NEXT.md#open) sketches is the wrong fix
anyway. [RESOLUTION.md](RESOLUTION.md#103-whether-and-how-peer-lists-are-shared--resolved-they-are-not-a-separate-thing)
settles that reachability comes from announcing rather than from claiming a
slot, which makes a taken slot a non-event rather than a case to handle.

### I23. Two tabs holding one space key fork the writer's hash chain — **Bug**
*Found 2026-09-02, reasoning from [I22](#i22-one-writer-two-tabs-the-second-cannot-claim-the-rendezvous-slot--limit). Reproduced.*

A space key lives in localStorage, which every same-origin tab shares. Two tabs
open on one writer space each `Writer.resume` from the same log, so both hold
the same `seq` and the same `prev` in memory. Both then write, and produce **two
different events at the same seq with the same prev, both validly signed**.

Reproduced directly: two `Writer`s resumed from one log both emitted seq 1 with
identical `prev`, different content, and both passed `verifyEvent`.

**Signing does not catch this**, and cannot: the writer really did sign both.
[I5](#i5-lamport-clocks-are-unenforceable-so-a-malicious-peer-wins-every-conflict--fixed-in-v1)
and [I6](#i6-hello-is-unauthenticated-any-peer-can-claim-any-writer-id--fixed-in-v1)
were about a *hostile* peer; this is the honest writer contradicting itself.

`checkWriterLamports` does not catch it either. It looks for one lamport reused
across *different* seqs; a fork is the same lamport at the same seq, which slips
through. Both events survive into the fold.

The consequence is that §3.2's per-writer hash chain stops being a chain, so
"this writer's history" is no longer well defined — and every peer that
replicates both events inherits the ambiguity permanently.

**Not currently reachable in the app**, because the rendezvous slot means a
second tab fails to replicate (I22) and its events stay local. That is luck
rather than design, and it stops being true the moment I22 is addressed.

**Fix: the Web Locks API.** Same-origin tabs contend for one write lock per
space; the holder is the writer and the others open read-only. That is local
coordination for a local problem, needs no protocol, and is unrelated to
rendezvous — which is the argument for fixing it here rather than folding it
into the mesh work.

Two devices with the same exported key remain a genuine fork that no lock can
prevent; that is the key-loss/key-export territory of
[DESIGN.md](DESIGN.md) §5.4 and wants a different answer.

---

## Closed

### I19. MIME stored per-blob and never replicated — *fixed 2026-08-29*
*[FINDINGS F10](FINDINGS.md#f10-mime-is-stored-per-blob-and-not-replicated--already-wrong)*

Format is now a `:type` attribute on the object (SPEC §4.7), replicated with the
metadata. The blob store holds bytes and nothing else.

### I20. Cross-space moves did not reach peers — *fixed 2026-08-29*
*[FINDINGS F8](FINDINGS.md#f8-sync-works-between-two-browsers-one-bug-class-was-transmission-not-model)*

A move writes to two logs; the UI flushed only the visible one.

---

## What would actually bite first

Ordered by how soon a real user hits it, not by severity:

| | Issue | Why first |
|---|---|---|
| 1 | **I2** log growth | Deterministic. Every space heads for the quota with no warning. |
| 2 | **I1** write lockout | Already observed, cause unknown. |
| 3 | **I9** writer SPOF | The moment two readers want a blob and the writer is closed. |
| 4 | **I3** invisible conflict loss | Needs two writers editing one file — rare in mode 2, certain in mode 3. |
| 5 | **I5**/**I6** forgery | Needs someone hostile. Not a POC risk; a product blocker. |

---

## For v1

The envelope (§2), the handshake (§3.4), and the blob/log boundary (§6) should be
reconsidered **together**. They are the expensive things to change later, and
I5, I6, I11, I13, I17 and I18 all land on one of the three. Fixing them
piecemeal means paying the migration cost repeatedly.

**Since updated by [V1.md](V1.md), on two points.** First, the blob/log boundary
no longer has to move: [NEXT.md](NEXT.md#settled) settles that mode 3 is out,
which drops the log/blob dichotomy, snapshots and compaction back to optional.
What remains is the envelope and the handshake, changing together in one step.
Second, "paying the migration cost repeatedly" overstates the cost to zero:
there is **no migration obligation at all**, because nothing in v1 has to read,
convert or interoperate with anything v0 wrote.

None of this makes the issues above less real. It changes only the remedy: they
are resolved by editing v0 in place, in the sequence [V1.md](V1.md) sets out.
