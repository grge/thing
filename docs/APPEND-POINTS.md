# Per-process append points: what would change

**Status: a trace, not a proposal.** It answers one question — if `writer` stays
the *identity* and the chain is keyed by something else, what breaks? — by
reading the code rather than reasoning about it.

Prompted by the observation that the right design has `thing` and `thing attach`
**assuming the same identity despite being separate processes**, which the
current model cannot express. See `EQUIVOCATION.md` for the literature.

---

## 1. The finding

`writer` is doing two jobs, and the code already separates them cleanly. Every
use falls into one of two groups, with **no file using it for both**:

| | uses `writer` as | files |
| --- | --- | --- |
| **identity** | who signed this; may they write | `core/event.ts` (preimage), `core/incremental.ts` (root check, writer set), `core/rules.ts` (register tiebreak), `core/chain.ts` (`compareKeys`) |
| **append point** | which chain does this extend | `core/writer.ts`, `core/chain.ts` (`checkLink`), `store/chainstate.ts`, `net/sync.ts`, `net/wire.ts`, `net/protocol.ts` |

The one file appearing twice is `chain.ts`, and it is two separate functions:
`compareKeys` (identity, for ordering) and `checkLink` (append point, for chain
integrity). They do not interact.

**This is a much cleaner split than expected.** The change is not "unpick a
concept smeared across the codebase". It is "add a field, and change which of
two fields eleven call sites read".

## 2. The change

Add `point` to the event body: an opaque per-process identifier, minted fresh
when a process opens a space for writing.

```
writer   who signed this           — identity, stays exactly as it is
point    which chain this extends  — new, per process
seq      position within *point*'s chain
prev     hash of point's previous event
```

Then:

- `checkLink` chains by `(writer, point)` instead of `writer`.
- `ChainSet` keys by `(writer, point)`.
- Version vectors key by `(writer, point)`.
- `compareKeys` is **unchanged** — still `(lamport, writer, id)`, so two
  processes of one identity order by their event hashes, exactly as two devices
  of one key do today under §7.3.
- The writer set, the root check and the register tiebreak are **unchanged**,
  because they ask about identity and identity is untouched.

**Equivocation stops being expressible.** Two processes of one identity write to
different chains, so there is no shared position to contend for. No lock, no
control API for writes, no §7.3 fork resolution for the honest case.

Note this is *not* Kleppmann's construction. It keeps dense sequence numbers and
therefore keeps cheap gap detection; it fixes the honest-concurrency case
without addressing a *malicious* writer, who can still equivocate within one
`point`. That remains open, and §7.3's resolution remains the answer for it.
The trade is deliberate: this is the small change that unblocks the design,
not the complete Byzantine story.

## 2a. One consequence the first pass missed

`checkLink` enforces more than chain linkage. Its comment:

> **Lamport is checked here too.** §2.2's comparison key is a total order only
> because a writer's own lamports strictly increase, and nothing else enforces
> that. A writer that reused a stamp would degrade every resolution to the
> event-id tiebreak while still appearing to work.

Chaining by `(writer, point)` means this check becomes per *point*, so one
identity's two chains can each issue the same lamport. Two events, same
identity, same lamport, different ids.

**The order stays total** — `compareKeys` falls through to the event id, which is
exactly the third component stage 1 added for this reason. So nothing breaks.
But the *quality* of the order degrades in the way the comment warns about:
concurrent writes from one person's two processes resolve by hash rather than by
anything meaningful, which is arbitrary-but-deterministic.

That is the same guarantee two devices get today under §7.3, so it is not a
regression — it is the existing behaviour, becoming ordinary rather than
exceptional. Worth stating plainly because it is the one place where "same
identity, two processes" is genuinely weaker than "one process": **the system
cannot tell which of your own two windows wrote last.** Wall clocks are not
trustworthy enough to fix it and §2.2 deliberately does not try.

`Writer.observe` already raises the clock past anything seen, so two processes
that sync converge their clocks and the overlap is confined to genuinely
concurrent writes.

## 3. What it costs

**The event format changes.** `encodeEventBody` gains a field, so every
signature changes and no existing log is readable. Acceptable now — nothing is
deployed and no space exists that anyone would miss — and *not* acceptable
later, which is an argument for deciding soon rather than carefully.

**Version vectors grow.** From one entry per writer to one per `(writer, point)`.
This is the real cost and the literature is blunt about it: Weidner notes the
replica count "tends to grow without bound: each browser tab creates a new
replica, including refreshes."

So the open question is not whether to add `point` but **what mints one**:

| granularity | vv size | two tabs | notes |
| --- | --- | --- | --- |
| per process | unbounded | fine | correct, needs GC |
| per device | bounded | **forks** | reintroduces §7.3 for tabs |
| per process, GC'd | bounded in practice | fine | what real systems do |

Per-device is tempting and wrong for exactly the reason `writelock.ts` exists.
Per-process needs a compaction story for retired points — which §9.2's
compaction wants anyway, so it is one mechanism rather than a new one.

**A retired point is not deletable**, only compactable: its events are real
history. "Retired" means "will never be extended", which is a claim only the
minting process can make and which nothing currently records.

## 4. What it does not cost

- **The fold.** Zero references to `seq` in `fold.ts` or `incremental.ts`.
  Convergence is `(lamport, writer, id)` and does not learn about `point`.
- **Rules.** Registers break ties on `(lamport, writer)`; unchanged.
- **The root authority model.** `hex(e.writer) !== spaceHex` still works — one
  identity, many points, all of them the space key's.
- **Storage layout.** `ChainSet` keys by a string today; it becomes a compound
  string.
- **`Space.absorb`, the client, the transports.** None of them read `seq`.

## 5. Which stages this rewrites

Half-implemented, so this touches finished stages as well as future ones.

| stage | status | what changes |
| --- | --- | --- |
| **1** core: events, encoding, signing | done | the preimage gains `point`; `checkLink` chains by `(writer, point)`. **Stage 1's "decide here: the exact preimage byte layout" reopens.** |
| **2** core: the fold | done | nothing |
| **3** store | done | `ChainSet` and version vectors key by `(writer, point)`; the conformance suite gains cases for one identity on two points |
| **4** space | done | `Writer` state is per point; opening for writing mints one |
| **5** net | done | `WireVersionVector` keys change; `SeqRange` carries a point |
| **6** node | done | nothing directly |
| **7** web | done | `writelock.ts` **is no longer needed for correctness** — two tabs get two points. It may survive as a UX choice (one editing tab), but §7.3's hazard is gone. |
| **7.5** one client | in progress | **the store lock is no longer a correctness requirement**, and writes stop needing to go through the holder — the CLI becomes an ordinary peer again |
| **7.6** control socket | not started | shrinks to admin + view model; editing returns to the sync protocol |
| **9** multi-writer | not started | mostly unaffected — the writer set is identities. §7.3's fork resolution stays for the malicious case but stops being the *expected* case |
| **10** encryption | not started | **`nonce` is derived from `(writer, seq)` and must become `(writer, point, seq)`** — otherwise two points of one identity reuse nonces, which for an authenticated cipher is catastrophic |

**Stage 10 is the one that would have bitten**, and the spec already says so
without noticing. §6 proposes `(writer, seq)` as the nonce input because it is

> unique by construction **under §7.3's constraint**

— which is precisely the constraint under discussion. Remove it and the nonce
input silently stops being unique: two processes of one identity produce
identical nonces for different plaintexts under the same key, which for an
authenticated cipher is catastrophic rather than merely wrong.

Worth recording in ARCHITECTURE.md now even if `point` is never built. The
dependency is currently stated as a parenthetical in one bullet, and anyone
relaxing §7.3 for any reason would have to notice it there.

## 6. Documents that change

- **ARCHITECTURE.md** §2.1 (envelope), §2.2 (ordering — mostly a clarification
  that identity and chain differ), §2.3 (version vectors), §6 (nonce), §7.3
  (rewritten: forks become the malicious case, not the two-devices case).
- **PLAN.md** stages 1, 3, 4, 5, 7, 7.5, 7.6, 10 as above.
- **CLIENTS.md** — the write-goes-to-the-holder argument is void.
- **OPEN.md** question 10 splits: honest concurrency (this) and Byzantine
  equivocation (still open).

## 7. Recommendation

Small enough to be worth doing, and the reason is that it is **subtractive**:
the lock, the write API, the two-tabs lock and one whole protocol all stop being
necessary. Compare that to the design in `CLIENTS.md`, which was elaborate
precisely because it was routing around this.

Two things to settle before writing code:

1. **What mints a point, and what retires it.** The vv-growth question above.
   Per-process with compaction is the honest answer and needs §9.2.
2. **Is `point` a fresh keypair or an opaque id?** A keypair would let a point
   sign for itself (SSB's subfeed shape, and a route to delegation without
   sharing the identity key). An opaque id is far simpler. This trace assumes
   opaque, but the choice affects the preimage and should not be made twice.

And one thing to do first regardless: **stage 10's nonce derivation is unsafe
under any scheme that lets one identity have two chains.** That is worth
recording in ARCHITECTURE.md now, whichever way this goes.
