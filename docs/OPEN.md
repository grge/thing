# Open questions and build order

Companion to [ARCHITECTURE.md](ARCHITECTURE.md), which describes the design and
changes rarely, and to [PLAN.md](PLAN.md), which sets out the implementation
stages. This one tracks what is still undecided, and changes as questions close.

Most of these are answered *by* a stage rather than before it; PLAN.md names
which stage decides what.

Section references (§) point into ARCHITECTURE.md.

---

## What is unresolved

Roughly in order of how much would change if the answer went the other way.

| | Question | Where |
|---|---|---|
| 1 | Does the vocabulary of body rules stay small, or does "merge rule" become "arbitrary code with private state"? | §3.8 |
| 2 | What request-and-repair vocabulary extends the version vector — fork repair, held-but-not-applicable, and compacted ranges all need it? | §2.3 |
| 3 | What cipher, nonce derivation and key derivation does encryption use? | §6 |
| 4 | What exactly does the write-proposal channel between a view and its host look like? | §8.2 |
| 5 | What happens when a private key is lost, which decides whether this is usable by non-technical people? | §5.1.1 |
| 6 | Are ephemeral messages signed per message, or is the session authenticated once? | §10.2 |
| 7 | How does the connection lifecycle behave — concurrent syncs, mid-transfer drops, duplicate connections? | §5.6 |
| 8 | Is membership a whole-list register or a set of add/remove operations? | §7.4 |
| 9 | Does a peer keep replicating the losing branch of a resolved chain fork? | §7.3 |
| 10 | How is a blob reference expressed, and is `:kind` doing two jobs? | §3.9, §4.2 |

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

**Questions 5 to 10 are implementation-shaped.** They will be answered better
with code in front of you than in advance, and nothing depends on settling them
first. Question 10 has one known constraint worth carrying: a snapshot of a
log-backed body is itself a blob belonging to an object whose body is not one, so
"is this body a blob" and "is this value stored out of line" are separate
questions and probably want separate answers.

---

## What has closed

Kept because a closed question is worth being able to recognise as closed, and
because two of these were once the most expensive things on the list.

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

**Chain forks under a shared key — closed by §7.3.** Previously stated as
unrecoverable, which was wrong. Two branches with identical provenance cannot be
adjudicated on authority, but they can be resolved deterministically: longest
branch, ties on lowest event hash. The failure drops from *the space breaks* to
*one branch's writes are dropped*, which is survivable and worth preferring even
when the winner is not the party you would have chosen.

---

## A build order this suggests

Not a plan, but the ordering the dependencies imply. The principle is to build
the certain parts first and buy information about the uncertain ones as cheaply
as possible.

1. **The substrate** (§2), single-writer, unencrypted. It is Proven, everything
   sits on it, and it is the part least likely to be rebuilt. Single-writer is
   the simplest case of §7 rather than an evasion of it: the writer set has one
   member and the root rule (§7.2.1) is already satisfied, so multi-writer is
   later additive work rather than a change of shape. Two things must be right
   from the first line, because both are expensive to retrofit: the space key
   belongs in the signed preimage (§2.1), and blob addressing should be shaped
   for ciphertext even before a cipher exists (§2.4).
2. **The canonical-form specification** (§3.6) *before* any merge rule is coded,
   including per-rule serialisation. It is much harder to retrofit than to write.
3. **The fold with the register and flag rules only**, plus a filesystem end to
   end. This proves the tiering without betting on the hard rules.
4. **A chat**, which needs no new rule at all — a folder whose children are
   messages. The cheapest test of whether the shape holds for something that is
   not a filesystem, and it should happen early while abandoning the universal
   fold would still be affordable.
5. **Resolution and the mesh** (§5.3), once there is something worth reaching.
6. **Encryption** (§6), which unlocks always-on peers. Self-contained only if
   step 1 left blob addressing ciphertext-shaped.
7. **Fast-start snapshots** (§9.1) when folding a log becomes slow enough to
   notice — not before, and without discarding events.

**Deferred until forced:** compaction and views-as-code, each either unresolved
above or much cheaper once the questions ahead of it have answers.

**Multi-writer is not in that category.** With §7.2 settled it is ordinary
additive work — a membership list on the root, a permission check in phase 2 of
the fold, and no envelope change — so it can be built whenever it is wanted
rather than waiting on a resolution. What it does still require is §7.3's
constraint being enforced where it can be (an exclusive lock per space on one
device) and stated plainly where it cannot.

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

---

## Next

In order, and the first two are the ones that get more expensive with delay:

1. **The version-vector extension** (§2.3). The last outstanding substrate
   change, and three separate problems want it: detecting and repairing forked
   chains, expressing "held but not applicable", and marking compacted ranges.
   Designing it once now is much cheaper than three times later, and the tip
   hash — enough to make divergence *detectable* — is settled enough to build
   today.
2. **Canonical serialisation per rule** (§3.6). Cheap now, brutal later. The
   prototype has real representation freedom in the sequence rule — run
   splitting, tombstone encoding — and nothing pins it, so two correct
   implementations of that rule would not agree byte for byte.
3. **Incremental folding.** `proto/` re-folds everything on every call. Slicing
   makes the incremental version mostly straightforward, with one exception worth
   knowing in advance: cycle-breaking reads the whole parent graph, so the tree
   is one unit even though every other slice is independent.
4. **The substrate**, per the build order above.

**The bet is not fully settled.** One sequence rule fits the contract. Whether a
block-structured document needs a rule large enough that "merge rule" means
"arbitrary code with private state" is untested, and §3.8 names it as the way the
vocabulary fails. The evidence so far is encouraging rather than conclusive: the
rule that was most likely to break the contract did not.

**And the bet fails soft.** If the vocabulary does grow without bound, what
remains is a competent local-first sync engine — of which several exist — without
the argument that makes shipping foreign views safe. That is a worse outcome than
the design intends and a survivable one.
