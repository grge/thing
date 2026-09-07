# Open questions

Companion to [ARCHITECTURE.md](../ARCHITECTURE.md), which describes the design and
changes rarely, and to [PLAN.md](PLAN.md), which sets out the implementation
stages. This one tracks what is still undecided, and changes as questions close.

**PLAN.md owns the build order.** This file used to carry one too, and they
drifted; what is left here is the *dependency reasoning* behind the order, which
is the part that does not belong in a stage list.

Most of these are answered *by* a stage rather than before it; PLAN.md names
which stage decides what.

Section references (§) point into ARCHITECTURE.md.

---

## What is unresolved

Roughly in order of how much would change if the answer went the other way.

| | Question | Where |
|---|---|---|
| 1 | ~~Does the vocabulary of body rules stay small?~~ **The rule fits the contract** — see stage 11. What remains of this question is whether a *block-structured document* needs more than a sequence does, which is untested. | §3.8 |
| 2 | What request-and-repair vocabulary extends the version vector — fork repair, held-but-not-applicable, and compacted ranges all need it? Deliberately deferred until compaction wants the same extension. | §2.3, §9.2 |
| 3 | What cipher, nonce derivation and key derivation does encryption use? | §6 |
| 4 | What exactly does the write-proposal channel between a view and its host look like? | §8.2 |
| 5 | What happens when a private key is lost, which decides whether this is usable by non-technical people? | §5.1.1 |
| 5a | What happens when a *space* key leaks? There is no in-band response: it cannot be purged (a purge is a root event, and only that key writes the root), removed from `:writers`, or rotated (the key *is* the space id). Same risk as 5 with the opposite sign, and only 5 is written down. See [LEARNINGS.md](LEARNINGS.md), "the nuclear revoke". | §5.1.1, §7.2.1 |
| 6 | How does the connection lifecycle behave — concurrent syncs, mid-transfer drops, duplicate connections? | §5.6 |
| 7 | Is membership a whole-list register or a set of add/remove operations? | §7.4 |
| 8 | Does a peer keep replicating the losing branch of a resolved chain fork? Now a bandwidth question rather than a correctness one — resolution is deterministic, so a peer that drops the loser and one that keeps it fold the same state. | §7.3 |
| 9 | How is a blob reference expressed, and is `:kind` doing two jobs? *(A space link looked like a third case of this and is not: it is a semantic question, not a storage one, and is settled in [MAIN-SPACE.md](../design/MAIN-SPACE.md).)* | §3.9, §4.2 |
| 10 | Do dense per-writer sequence numbers stay at all, given that the literature calls them unsafe against a *malicious* writer? See [EQUIVOCATION.md](../design/EQUIVOCATION.md). Append points do not answer this. | §2.1, §2.3, §7.3 |
| 10a | ~~The incremental fold intermittently disagrees with a replay.~~ **Closed: it never disagreed.** The failure was `Test timed out in 5000ms` — no counterexample, no assertion — and the entry described a symptom nobody had read the text of. The two slow tests take ~2.7s in isolation against a 5s limit, so full-suite CPU contention crossed it; four busy cores make them fail every time. What it *did* surface is real and is now stage 12: the incremental fold is **22× slower than replaying the same events**, because `apply()` refolds everything held on every call. | §3.6 |
| 11 | Does signing ever have to carry *attribution* rather than only authority — and does this system want a notion of a person at all? See [LEARNINGS.md](LEARNINGS.md) §1. | §5.1, §7.2.1 |
| 12 | **Is answering a resolution query obligatory, and is that per space?** §5.3 leaves it open that a peer which answers reveals which spaces it knows of — a weak disclosure of what it holds. A mesh where most peers decline does not resolve, so the default has to be *answer*; but a space someone holds privately is exactly the one they may not want to admit to. Per-space is the natural granularity, since it is where "keep a copy" already lives (`mirrorBlobs`) — which makes it a third per-space policy and an argument that those want one home rather than three. Note the asymmetry: declining to answer does not hide the space from anyone already connected about it, because `ANNOUNCE` and the sync handshake both name it. | §5.3, §10 |

**An OR-set is still unimplemented, and still not needed.** The set that does
want a rule is `:serves` — where a space's writers say it is served
([LOCATORS.md](../design/LOCATORS.md)) — and a grow-only set with read-time expiry covers
it: removal is rare and imprecise, and §5.3's model is TTL-shaped already. An
OR-set's causal tags and canonical form (§3.2, §3.6) are not worth buying for
that. The rule table still names one and nothing implements it; wanting it for
the vocabulary and needing it here are different.

**Question 10 is what append points leave behind.** Stage 7.6 fixes the *honest*
case — your own two processes — by giving each its own chain. A malicious writer
can still equivocate within one append point, and §7.3's resolution is still the
answer for that. It would be easy to build append points, feel the relief of the
lock going away, and forget that half the problem is untouched.

**Question 11 is the one a rewrite would start from.** It arrived from the
opposite direction to the rest: not from asking what the design should be, but
from two sessions of admin tooling growing more elaborate around a constraint
nobody had questioned. Signing currently proves that *a key was entitled* to
write, and nothing anywhere proves *who wrote*. §7.2.1 makes that worse than a
gap — co-administering a space means sharing the space key, so the log cannot
record which holder acted.

**Question 1 is the bet.** It is the only one whose answer would change what the
system *is* rather than how it is built. It also fails soft: if the vocabulary
grows without bound, what remains is a competent local-first sync engine without
the argument that makes shipping foreign views safe.

**Question 2 is the prerequisite.** It is the last outstanding substrate change,
three separate problems need it, and it is much cheaper to design once now than
three times later.

**Question 3 blocks less than it looks** — everything §6 says about who can do
what holds under any competent authenticated cipher — but it must be settled
before encryption ships, and the nonce-uniqueness problem is the kind that loses
everything at once when it is got wrong.

**Questions 5 to 9 are implementation-shaped.** They will be answered better
with code in front of you than in advance, and nothing depends on settling them
first. Question 9 has one known constraint worth carrying: a snapshot of a
log-backed body is itself a blob belonging to an object whose body is not one, so
"is this body a blob" and "is this value stored out of line" are separate
questions and probably want separate answers.

**Questions 10 and 11 are different in kind.** Both would change the substrate,
both came from building rather than from designing, and neither is scheduled.
`LEARNINGS.md` collects what they and their neighbours suggest for whenever this
design is rewritten.

---

## What has closed

Kept because a closed question is worth being able to recognise as closed, and
because two of these were once the most expensive things on the list.

**Can one identity write from two processes? — decided, not yet built.** Split
`writer` into an identity and a per-process *append point*, so two processes of
one identity extend different chains and never contend for a position.
`../design/APPEND-POINTS.md` has the trace and the two choices settled (per process;
opaque 16 bytes, not a keypair); PLAN.md stage 7.6 has the work. It is
subtractive — the store lock, the write-through-the-holder API and
`writelock.ts` all stop being necessary.

**Judging permission over a changing writer set — closed by `deps`.** The full
fold filtered by the *final* writer set, so removing a writer unwrote everything
they had written; the incremental fold kept whatever it had applied, so the
answer depended on arrival order. Both were wrong and they disagreed with each
other. `../design/DEPS.md` and PLAN.md stage 7.8: an event now names what its author had
seen, and both folds judge against that using one shared function. It does not
close *backdating* — an event naming only pre-removal heads still folds, and is
indistinguishable from an honest offline one.

**The permission circularity — closed by §7.2.** The rule that says which events
count was itself written by events. This was the question threatening to add a
causal dependency to the event envelope, which is the most expensive kind of
change once logs exist. Restricting root writes to the space key closes it with
no envelope change, and removes the one open question that had the substrate
hostage.

**Space types — removed, not answered.** Earlier drafts had a space declare a
type, and a type declare how its attributes merged. The prototype showed that
unnecessary: every attribute merges by a fixed rule every client knows, so every
space has the same structural model and only an object's *body* varies. That deleted the schema
format, the question of what happens when a type changes, and one of the two
instances of the permission circularity. See §4.1.

**Whether a sequence CRDT can be a merge rule — closed by building it.**
`proto/` implements the tiered fold and runs a filesystem, a chat and a
co-edited document in one space with no type-specific code in the kernel. The
sequence rule has the same signature as the register rule; element ids derive
from `(writer, seq)`; tombstones live in the fold output; a missing anchor is
pending rather than fatal. Generated multi-writer histories converge under every
arrival order. This was the prerequisite, and it held.

**Trusting a departed writer's snapshot — closed by §9.3.** The space key is
already the sole authority over who may write (§7.2.1), so any peer that accepts
a space has accepted that key's word on what counts. Letting it countersign a
checkpoint over a departed writer's chain adds no trust relationship that was not
already there, and it closes the one case writer-signed compaction could not
reach.

**The rendering boundary — closed in shape by §8.2.** A sandboxed cross-origin
frame under a strict content policy gives origin isolation, a complete interface
language and platform-handled input without any of it being designed. What
remains is one message channel for write proposals, which is question 4 rather
than a wall.

**Whether ephemeral messages need signing — closed by §10.2: they do not.** The
transport already authenticates the sender, and no ephemeral message is a claim
that has to be believed: each is either about its own sender, or a hint whose
truth is established by acting on it. Signing would add attribution, not
protection. The domain tag stays reserved so the separation exists if that ever
changes.

**Chain forks under a shared key — closed by §7.3.** Previously stated as
unrecoverable, which was wrong. Two branches with identical provenance cannot be
adjudicated on authority, but they can be resolved deterministically: longest
branch, ties on lowest event hash. The failure drops from *the space breaks* to
*one branch's writes are dropped*, which is survivable and worth preferring even
when the winner is not the party you would have chosen.

---

## What the dependencies imply

Not an order — PLAN.md has that — but the reasoning it came from, kept because
the *why* outlives any particular sequence.

**Build the certain parts first and buy information about the uncertain ones as
cheaply as possible.** The substrate (§2) is Proven, everything sits on it, and
it is the part least likely to be rebuilt. Two things had to be right from the
first line because both are expensive to retrofit: the space key in the signed
preimage (§2.1), and blob addressing shaped for ciphertext before any cipher
exists (§2.4).

**Canonical form before any merge rule is coded** (§3.6), per-rule serialisation
included. Much harder to retrofit than to write.

**A chat before anything hard**, because it needs no new rule — a folder whose
children are messages — and is the cheapest test of whether the shape holds for
something that is not a filesystem. Worth doing while abandoning the universal
fold would still be affordable.

**Multi-writer is ordinary additive work.** §7.2 settled the shape: a membership
list on the root, a permission check in phase 2, no envelope change. It can be
built whenever it is wanted. What it requires is §7.3's constraint being
enforced where it can be and stated plainly where it cannot — and
`../design/APPEND-POINTS.md` changes what "where it can be" means.

**Deferred until forced:** compaction and views-as-code, each either unresolved
above or much cheaper once the questions ahead of it have answers.

---

## Ideas worth not forgetting

Not open questions — nothing depends on these and none is scheduled. Recorded
because each is cheap to note and annoying to re-derive.

**A SQLite backend for a space.** A directory of append-only segments is the right first backend — simpler, and
what the headless peer wants for serving. But *one file per space* has a
property a directory does not: **a space becomes a thing you can send.** Email
it, drop it on a USB stick, attach it to a ticket. Given that a space is already
a self-contained log with its own identity (§5.1), a single-file representation
makes that portability real rather than theoretical. SQLite also gives range
queries over events, which an incremental fold would use.

It fits behind the storage interface stage 3 defines, so it is additive whenever
it is wanted.

**A filesystem-backed space.** A FUSE-style mount where writing a file emits log
events and the fold materialises a directory tree. The filesystem is already the
structural model (§4.1), so the mapping is close to the identity function —
which is what makes this look tractable rather than fanciful. It would make a
space something ordinary tools can read and write, with no client at all.

Well beyond current scope, and it raises real questions — what a partial fold
looks like as a directory, how a body rule other than blob is presented, what
happens to attributes with no filesystem analogue. Noted because the design
happens to be shaped for it.

*(Two entries that were here — "one client, two transports" and "three ways to
run a peer" — have moved into PLAN.md as stages 7.5 and 7.7. The first is
built.)*

---

## Next

PLAN.md's stage order is the answer; what follows is what is most expensive to
delay, which is not always the same thing.

1. **Append points** (`../design/APPEND-POINTS.md`, stage 7.6). Changes the event
   envelope, so it gets more expensive with every log that exists and every
   design decision taken on the old shape. Nothing is deployed today. That
   window closes.
2. **The version-vector extension** (§2.3) — question 2 above. Still the last
   outstanding *substrate* change, and three problems want it. Append points
   touch the same structure, so the two should at least be designed with each
   other in view.
3. **Canonical serialisation per rule** (§3.6). Cheap now, brutal later. The
   sequence rule has real representation freedom — run splitting, tombstone
   encoding — and nothing pins it, so two correct implementations would not
   agree byte for byte.

**Since the last revision of this list:** incremental folding is built
(`core/incremental.ts`), the tip hash is in the handshake, and the substrate,
fold, store, net, node and web stages are all done. The list above is what
remains of it.

**The bet is not fully settled.** One sequence rule fits the contract. Whether a
block-structured document needs a rule large enough that "merge rule" means
"arbitrary code with private state" is untested, and §3.8 names it as the way the
vocabulary fails. The evidence so far is encouraging rather than conclusive: the
rule that was most likely to break the contract did not.

**And the bet fails soft.** If the vocabulary does grow without bound, what
remains is a competent local-first sync engine — of which several exist — without
the argument that makes shipping foreign views safe. That is a worse outcome than
the design intends and a survivable one.
