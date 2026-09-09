# What this design got wrong, and what a rewrite should carry

**Status: accumulating.** Not a plan, and not a criticism of the current
architecture — most of it works. This is the list of things that were only
learnable by building, and that a next version should start from rather than
rediscover.

The current design is being finished as it stands. These are noted as they are
found, so that when a rewrite happens there is something better than memory.

---

## 1. Signing proves authority, not attribution — and nothing else does either

**The deepest of these**, and the one several others are symptoms of.

A signature currently answers **"was a key entitled to make this write?"** It
does not answer **"who made this change?"**, and no other part of the system does
either. Those look like the same question and are not: the first is about
permission, the second is about a person, and this design only ever built the
first.

Three places where the gap shows, in increasing severity:

**A user is a different key in every space.** `mint()` produces a keypair per
space, so there is nothing that says two writers in two spaces are one person.
Nobody can be followed, and "what has Alice been doing" is not expressible.

**The space key is one key with several holders.** §7.2.1 admits root events on
a signature from the space key alone. So two people co-administering a space —
adding a writer, renaming — must *share that key*. At that point the log records
that the space key granted access and **cannot record which of them did it**.
This is not a missing feature; attribution is actively destroyed by the
mechanism that provides authority. Sharing a key is how the design intends
shared administration to work.

**A key does not name a person even in principle.** Keys are stored as raw seeds
(§5.1) and are meant to be movable between devices. A key proves possession of a
secret; it never proved a person, and nothing above it makes that leap.

**What follows.** If this system is ever meant to have a social dimension —
people with a presence, changes attributable to them, someone to follow — that is
not a feature to add later on top of what exists. It needs identity to be a
first-class thing that is *distinct from* both the space key and the writer key,
with signing carrying attribution alongside authority. That is roughly what
Keyhive separates (capabilities delegated to keys, identity deliberately left to
a layer above) and what SSB's fusion identity gropes toward.

It also reframes the two decisions taken in `../design/APPEND-POINTS.md`. Opaque points
were chosen partly because "there is no Alice for a certificate to bind to" —
which is correct today and is exactly the thing a social system would have to
change first.

**Carry forward:** decide early whether signatures attribute or merely authorise.
They are separable, most of the cost is in choosing late, and the current answer
— authority only — was never explicitly chosen. It fell out of using one key for
identity, authority and chain position at once.

## 2. `writer` is three concepts wearing one name

Today one field answers three different questions:

| question | who asks | changes how often |
| --- | --- | --- |
| who is accountable for this event? | the fold, `:writers`, the root check | never |
| which chain does this extend? | `checkLink`, `ChainSet`, sync | per process |
| which key signed it? | `verifyEvent` | per key rotation |

`../design/APPEND-POINTS.md` splits the second off. The first and third are still fused,
and the level above all of them — **a person, stable across spaces** — does not
exist at all: a writer key is minted per space, and is the space key for the
space's creator. That missing level is §1 above; this entry is the mechanical
half of the same problem.

**Carry forward:** decide the identity model *before* the event envelope.
Everything downstream inherits its shape, and the envelope is the hardest thing
to change once logs exist.

## 3. `Keystore` is four things, and only one of them has a contract

Found while asking what the engine's tests supply for capabilities. It is the
same shape as §2 above — several concepts under one name — and it is the piece
`web/` and `node/` will collide with first when they are rebuilt.

`web/src/keystore.ts` bundles everything a client knows about a space that is
*not* in the space:

| job | methods | nature |
| --- | --- | --- |
| secrets | `mint`, `keyFor` | the writing key; raw extractable seeds (§5.1) |
| inventory | `spaces`, `remember`, `forget` | which spaces this client holds |
| naming | `petname`, `setPetname` | §5.5, local, never replicated |
| addresses | `locator`, `rememberLocator` | §5.3, **stale by default** |

The unifying idea is sound — a log is replicated and identical everywhere, these
four are per-client and lost with the client's storage — but the pieces want
different treatment. **A secret and a disposable cache are sharing one
interface**, so they get the same storage, the same lifetime and the same backup
story, when they should share none of those. §5.1.1 calls losing the key the
largest unresolved risk in the design; `locator` losing its contents is a minor
inconvenience.

**And `node/` does not implement it.** The same four jobs are solved four
different ways there:

- secrets → `keyPath`/`loadKey`/`saveKey`, three loose functions in `cli.ts`
- inventory → absent; `Store.list()` serves, because a directory *is* the
  inventory
- naming → `FilePetnames`, its own class, against `PetnameStore` — the one
  quarter that *does* have a shared contract, and it lives in the engine
- addresses → **not implemented at all**; `thing join` takes a URL every time

So this is not one interface with two backends. It is an interface in `web/`,
four ad-hoc solutions in `node/`, and one of them missing.

**Carry forward:** decide what the pieces are before writing a contract for
them. The obvious move is a `MemoryKeystore` plus a conformance suite, matching
what `MemoryStore` does for storage — and that would be premature here, because
a conformance suite for the wrong shape makes the wrong shape harder to change.
Split first: the key wants backup and recovery, the inventory is derivable from
storage, the petname store already has its contract, and the locator cache wants
to be forgettable.

**Done** — `engine/local.ts` names the four, both backends implement them, and
one conformance suite checks both. The split turned out to be load-bearing for a
reason that had nothing to do with tidiness: an interface mirroring a peer's
state needs to replicate three of the four and **must never replicate the
fourth**. That column cannot be expressed while a secret and a cache share an
interface. Two of the predictions above held exactly — the inventory *is*
derivable from storage on the filesystem, and the petname store already had its
contract — and the third was worse than described: `node` had no locator cache
at all, which is why `thing join` had always needed the address typed again.

## 3a. The wire format costs 2.1x what it needs to

Measured while sizing something else. A real event is **206 bytes on disk** and
**435 on the wire**, because `wire.ts` encodes every binary field as hex inside
JSON — a 32-byte hash becomes 64 characters, and there are three of them per
event plus a 64-byte signature.

Base64 would bring it to roughly 1.4x; a binary framing to about 1.05x. That is
a larger saving than most things being weighed against it, with no design risk:
`wire.ts` is explicitly the one of the three encodings that is *free to change*,
since it is neither signed nor stored.

Not done now — it is a rewrite-shaped change and nothing is deployed that needs
it — but recorded so that "is X too many bytes per write" has a reference point.
The answer for most X is: smaller than what the encoding is already wasting.

## 4. Dense sequence numbers were chosen for sync and paid for everywhere else

`seq` exists so a version vector can say "I hold 0–47 contiguous". That is a
genuinely good property: cheap to compute, cheap to compare, cheap on the wire.

The cost was not visible at the point of choosing. Dense per-writer positions
mean **one append point per writer**, which means a lock, which means a second
process cannot write, which means a control API, which means a second protocol.
Two sessions of admin-tooling design were spent routing around a constraint
introduced by a sync optimisation.

The literature (`../design/EQUIVOCATION.md`) is blunter still: version vectors are unsafe
against a Byzantine writer for the same reason.

**Carry forward:** the causal-structure decision (dense sequences vs. hash DAG)
is *the* architectural fork. It determines what identity can mean, whether a
lock is needed, whether the CLI is a peer, and what sync costs. Make it
explicitly and early, with the downstream consequences written down, rather than
as an implementation detail of "how do we detect gaps".

## 5. Design pressure is a signal, and it was ignored twice

The admin-tooling design got steadily more elaborate — a control API, then a
write verb, then a split between reads and writes, then a fifth transport — and
each step was locally reasonable. The elaboration was the system saying a
constraint was in the wrong place.

Two earlier encounters with the same constraint were noted and passed over.
`writelock.ts` documents the hazard for tabs and says plainly that "across
devices nothing can prevent it, which is why the resolution exists" — the
generalisation was written down and not followed. §5's fork-repair note says a
fork "means the one-key-one-device constraint was already violated", treating it
as exceptional rather than as something two of your own processes do routinely.

**Carry forward:** when a design keeps needing another layer to work around one
sentence in the spec, suspect the sentence.

## 6. A constraint stated as a premise stops being questioned

§7.3 opens with *"a private key is meant to be held by one device at a time"*
and then spends a section on surviving the violation. Stated that way it reads
as a fact about keys rather than as a consequence of a choice made in §2.1.

**Carry forward:** where the spec states a constraint, say which decision
produces it. "One device at a time, *because* `seq` is dense" invites the
question that "one device at a time" closes.

## 7. Invariants leak into distant sections without saying so

§6 proposes deriving the encryption nonce from `(writer, seq)`, unique "by
construction under §7.3's constraint". That is a load-bearing dependency between
the crypto section and the chain-format section, recorded as a subordinate
clause in one bullet. Anyone relaxing §7.3 for any reason — and we nearly did —
would silently produce nonce reuse under one key.

**Carry forward:** a dependency on another section's invariant should be
declared where the invariant is *defined*, not only where it is used. §2.1 should
say what depends on chain uniqueness.

## 8. Package boundaries hid a missing layer

Four packages (`core`, `store`, `net`, `peer`) with nothing importing a subset
of them. The split bought nothing measurable and cost something real: `peer`
looked like a real boundary, so nobody noticed it had stopped one level short of
its own doc comment. The multi-space client it described lived nowhere, and
`node/peer.ts` and `web/client.ts` grew into the gap independently until they
were the same 300 lines twice.

**Carry forward:** split packages when something needs to import one without the
others, not to express layering. Layering is a reading order; a directory
expresses it fine.

## 9. Some bugs are only reachable from two processes

The duplicate-frame-handler bug passed 324 unit tests and was found by running
two real peers and noticing a delivery count double against a baseline. The
`adopt` race was carried verbatim from code that had shipped. Neither is
reachable from a single-process test.

**Carry forward:** keep a two-process end-to-end check in the loop from the
start, and record baseline counters (events delivered, sessions opened) so a
doubling is visible rather than merely plausible.

## 10. The spec's reasoning is usually better than a first read of it

Twice now a section looked like an arbitrary restriction and turned out to be
load-bearing once the *why* was read. §7.2.1 ("only the space key writes the
root") reads as a limitation; it exists to remove a genuine circularity — the
writer set lives on the root, the root is materialised by the fold, the fold
excludes non-writers — and §7.2 records that the obvious fix of folding twice
lets a stranger write "I am a writer" and be believed. §6's nonce clause is the
same pattern: a rule whose dependency is stated once, in passing.

**Carry forward:** where a section states a rule, state what breaks without it
in the same breath. Both of these did explain themselves, but far enough from
the rule that the rule could be read alone and misjudged.

## 11. A grep that truncates is a grep that lies

While fixing a Svelte reactivity bug I checked whether `void epoch` inside a
closure compiled to a real reactive read, using `grep -o 'epoch[^;]*'`. That
pattern stops at the first `;` — so the line `void $.get(epoch);` printed as the
bare word `epoch`, and I concluded the read had been optimised away.

It had not. The fix I already had was correct; I replaced it with a more
elaborate one on the strength of a measurement that had cut off the evidence.
Both work, and the user found the first one working while I was explaining why
it could not.

**Carry forward:** when a check contradicts something that ought to work, suspect
the check. This is the same family as §12 below — the difference between "found
nothing" and "could not have found it" is invisible in the output, and both cost
real time here.

## 12. Small verification failures are silent

`grep` reports nothing on `fold.ts` because it contains an intentional `\0` as a
map-key separator, which makes grep treat it as binary. A claim central to
`../design/EQUIVOCATION.md` — that the fold never reads `seq` — was first "verified" by a
command that could not have found anything. It happened to be true.

**Carry forward:** when a check underpins a design decision, make it fail
loudly. `grep -c` returning 0 and grep declining to read the file look identical.

---

# Ideas worth not losing

Not lessons from what went wrong — things worth building that came up while
doing something else. Recorded at the level of the idea; none is designed.

## 13. A test that passes without the code is not a test

The `--at` work added a wait: the CLI must not exit until the holder confirms it
has the write. The obvious test wrote a file through a running server and
asserted the file was there when the command returned. It passed.

It also passed with the wait **deleted**. On loopback the events arrive before
any assertion can run, so the race is won either way, and the test was measuring
delivery — which already worked — rather than confirmation, which was the new
thing. Six integration tests, one of them asserting the central claim, and that
one was worth nothing.

What made it checkable was removing the timing question entirely: a fake
connection that **stalls** — holds frames until released. While stalled the peer
*provably* does not have the events, so `covered` would be a lie rather than a
race won, and no wall-clock assumption is involved.

Two things fell out of it immediately:

- **A real bug.** With frames stalled, `askSynced` never resolved, and the wait
  loop only checked its deadline *between* rounds — so an open-but-silent peer
  hung the CLI forever. Every fast-wire test had missed it because no peer was
  ever slow. Silence needed to count as "behind", which is now what it does.
- **A false premise in another test.** The multi-peer test claimed the unstalled
  peer was caught up, so an implementation satisfied by *any* peer would wrongly
  pass. It was not caught up — the assertion ran too early — so both peers were
  behind and the test proved nothing. Mutating the code to `answers.some(covered)`
  showed it surviving; adding a wait for the first peer made it fail properly.

**The habit worth keeping: break the code and check the test notices.** It costs
one `git stash`-shaped edit and it is the only thing that distinguishes a test
from a comment that runs. Both problems here were invisible while everything was
green.

A corollary about what a level of testing can honestly claim. The CLI test now
says so out loud: the positive claim — a zero exit *means* the peer has it — is
untestable over a real socket, and lives in `client.test.ts` where the wire can
be stalled. What the CLI test proves is the other half, that an absent holder
yields a non-zero exit. Better a narrow true claim than a broad one that passes
for the wrong reason.

## 14. A reproduction that differs from the real setup proves nothing

Investigating why a browser could not fetch a blob, I built a probe with the
writer and the holder in separate temporary directories, watched `thing put
--at` exit 0 while the holder had no bytes, and reported that the CLI lies about
uploads.

The user pointed out that the files were readable in practice. The reason: their
CLI and their server share `$THING_DIR`, so `putBlob` writes into the directory
the server serves from. **The bytes arrived through the filesystem and the blob
protocol was never involved.** My probe had removed the one property that made
the real setup work, and I presented the result as a finding about the real
setup.

The claim was not false — a genuinely remote `--at` does exit 0 without shipping
bytes, and that is worth fixing. But it was *evidence about a different system*,
and I did not say so. It cost a round trip and would have cost more if it had
been believed.

**Before trusting a reproduction, name what differs between it and the reported
case.** Here the difference was one shared directory, which is exactly the kind
of thing a temp-dir harness erases by construction.

A second instance in the same session: the three-peer test for the blob retry
passed with the retry mutated out, because on a fake wire the relay's own
in-flight transfer reached the reader anyway. The test was measuring the
harness. Moving the assertion down to `Session`, where one message could be
tested against one behaviour, made both mutants fail as they should. Same
lesson as §13 from the other direction — a test whose subject can be reached by
a path you did not intend is not testing what its name says.

## 15. Read the failure text before writing down what failed

OPEN.md carried this for weeks:

> **The incremental fold intermittently disagrees with a replay.** Fails on
> roughly one full-suite run in five, passes every time in isolation — so it is
> order- or state-dependent rather than a bad generated case. This is the third
> appearance of "the two folds disagree".

The actual failure was `Error: Test timed out in 5000ms`. No counterexample, no
assertion, no disagreement — the two folds have never disagreed. Every clause
after the first sentence was reasoning built on a misread, and the "third
appearance of a known pattern" framing made it *more* plausible rather than
less: it fitted a story we already had.

The tell was in the numbers all along. The two failing tests take ~2.7s in
isolation against a 5s default; every other test in those files is under 500ms
and never failed. A 1.8× margin plus a full suite on four cores is a flake, and
`nproc` busy processes reproduce it deterministically — which took one command
once the question was "why is it slow" instead of "why do they disagree".

**Cost of the misread.** It survived long enough to be cited three times, and it
was reached for twice in one session as the explanation for unrelated failures —
once by me, mid-task, as "a regression I caused". A wrong entry in a known-issues
list is worse than no entry: it is a ready-made answer that stops the next person
looking.

**What was underneath was worth finding.** The tests are slow because
`Folder.apply` refolds everything it holds on every call, making the incremental
fold 22× slower than a full replay of the same events — the opposite of its
purpose. That is now stage 12. The bug was real; the description was fiction.

## 16. A name is not an identifier, however convenient it is

`follow(space, linkName)` looked up a link by its name. Two links called
`untitled` — the *default* name, so this is the common case rather than a
contrived one — and clicking either opened whichever `links()` sorted first.

**What it looked like from outside was much worse than what it was.** The user
reported "expanding a link shows the content of a totally different space",
which is content attributed to the wrong space: a correctness bug in the fold,
or a link whose target had been corrupted. I spent several rounds checking
`makeLink`, `targetOf`, the fold, and the tree's keying, and reproduced the
scenario end to end in Node — where it worked, because the *engine* was never
wrong. Only when they narrowed it to *"clicking either of two links switches to
the same tab"* was the shape obvious.

The lesson is not "use ids", which everyone already knows. It is that **the
identifier was right there and the name was easier to pass**. `FileEntry` has
`id`; the button had `chosen` in scope; `follow` took a string because a string
was what the caller happened to have. Nothing forced the mistake and nothing
caught it, because with one link per name it is indistinguishable from correct.

**Two more of the same shape were in the CLI**, found by grepping for the
pattern rather than by thinking. `thing unlink <name>` removed an arbitrary one
of several — silently, and the wrong one as likely as the right one. It now
refuses and lists the candidates, with `--key` to disambiguate. That one is a
*deletion*, so the same bug there was worse and had been sitting unremarked.

**Worth grepping for after any bug of this kind.** `\.name === ` found all
three in one command.

## 17. The same walk, written twice, broke twice

A log held every event three times. Two separate walks stepped through a
chain's events by `expect + 1`, and sorting by seq puts duplicates adjacent —
`0, 0, 0, 1, ...` — so both stopped at the second copy of seq 0.

- `ChainSet.load` pinned the frontier at 0, so every later event was refused as
  a permanent gap.
- `readRange` yielded one event and returned, so a peer asking for the range
  got seq 0 and nothing else, however many times it asked.

**The second one was invisible until the first was fixed.** Repairing `load`
made the server's own copy healthy, and the space still would not replicate —
which is what sent me looking again rather than declaring it done. Two bugs with
one symptom look like one bug that was not properly fixed.

**Neither function had a test.** `ChainSet` had none at all; `readRange` had
none either, in a file with twenty-three other tests. Both are on paths that
only run when something else has already gone slightly wrong — reopening a log,
serving a range to a peer that is behind — which is exactly the code that gets
exercised least and matters most.

The shape worth remembering: **a walk that assumes strict succession over data
it did not itself deduplicate.** `append` deduplicates, so within one process a
log holds each event once, and both walks were written against that assumption.
A log is a file, and a file outlives the process that guaranteed its shape.

## 18. An invariant that holds by accident is not held

`SpaceStore.append` decided an event was new, awaited a signature verification,
and only then recorded that it had been taken. Two overlapping appends both
passed the check and both stored the event.

**Three stores, written at different times, all had it.** That is the signature
of a missing contract rather than three slips: `ChainSet` offered `admit` and
`advance` as separate calls and said nothing about holding them together, so
every implementation independently did the reasonable-looking thing.

**It was satisfied by accident until something unrelated changed.** One
connection carried one space, so appends arrived one batch at a time and the
race had no way to fire. Making a connection carry several spaces
(`design/CONNECTIONS.md`) made overlapping appends ordinary — and the failure
appeared three layers away, as a file with a name and no content.

**The damage outlived the cause, which is what made it hard to see.** Duplicate
events broke two *other* walks that assumed a chain reads as a sequence —
rebuilding chain state on open, and serving a range to a peer. I fixed both as
bugs, and they were; but fixing them made the symptom recede without the cause
going anywhere, and the second one was invisible until the first was fixed. Two
bugs with one symptom look like one bug that was not properly fixed.

**The user called it before I did.** I was four layers deep and still treating
each layer as its own defect. Their read — *"this feels like a design issue we
overlooked rather than a bug"* — was right, and the tell was that I had fixed
"the" bug twice already and it was still there.

Now stated in §2.3, where the three verification checks are: deciding a sequence
number follows is a decision about a *chain*, so deciding it and recording it
must be one step. The conformance suite has it, so a fourth store cannot get it
wrong quietly.

## 19. The permission model is too simple, and it is starting to show

**The model is one sentence:** whoever holds the space key decides who may
write. That is its great virtue — §7.2.1 says so, and it is why the fold has no
fixed point to find and why membership needs no merge semantics. It should not
be given up lightly.

But four separate difficulties this month turned out to be the same difficulty,
and it is worth recording that they are related rather than each being fixed
where it surfaced.

**Encryption and authority collided.** `:writers` is a root value, so encrypting
it means a peer without the reading key cannot evaluate membership — and an
encrypted space could then only be hosted by someone able to read it, which is
what §6.2 exists to avoid. `ROOT-IN-CLEAR.md` resolves it by exempting the root,
which works, but notice what the fix is: **the authority model had to be moved
outside the privacy model** because they could not be layered. Two mechanisms
that should be independent were not.

**Unadmitted writes cost storage nobody bounds** (OPEN.md 8a). Because a store
cannot check permission — for the reason above, and because §7.2.3 makes
membership time-dependent — anyone who can reach a space can make it grow. The
events fold into nothing, so this is not a correctness failure; it is authority
that stops at the fold and does not reach the transport.

**Sharing a space means write access to a hub's main space.** Hosting is a link
(`MAIN-SPACE.md`), a link is an ordinary write, so *"please host my space"* and
*"let me edit your space"* are the same request. A public hub either admits
strangers as writers of its own main space or hosts nothing they ask for. The
authorisation the design wanted — *this person may add a link* — cannot be
expressed, because the vocabulary has one verb.

**Moderators are a label the engine does not enforce.** §7.2.2 defines them,
`isModerator` exists, nothing calls it, and nothing can: a moderator action is
an ordinary write and the fold has no way to treat it differently. The concept
was added because "several administrators" needed an answer that was not
sharing the space key — and what it produced was a note on the root that any
application may consult or ignore.

**What connects them.** The model has exactly two levels — *may write
everything*, or *may write nothing* — and every one of these is a request for a
third: may write here but not there, may add links but not files, may act as
this role. Each has been worked around locally, and the workarounds are
reasonable in isolation. The pattern is only visible when they are listed
together.

**This is not a call to build capability-based ACLs.** The simplicity is
load-bearing and most of what it buys is real. It is a note that the next
authority question should be answered by *revisiting the model* rather than by
adding a fifth workaround — and that a rewrite of `ARCHITECTURE.md` should
treat §6 and §7 as one problem rather than two chapters.

## 20. Encryption hides values; the design reveals the rest

§6.3 concedes that encryption *"does not hide structure"* in one line and moves
on. Working through what a keyless peer actually holds — while correcting §6.1,
which claimed more than it should have — makes the size of that concession
clearer, and it is worth writing down before anyone deploys against it.

**What a host of an encrypted space learns without the reading key:**

- **How many objects there are**, and therefore roughly how many files.
- **How many times each one changed**, since every write is an event on that
  object's slice, and the slices are enumerable by attribute name.
- **Which attributes each object carries** — so *this object has a `:body`* and
  *this one does not* separates files from folders without reading either.
- **When everything happened**, from `wall`, and in what order, from `lamport`.
- **Who wrote what**, since `writer` is in the clear on every event.
- **How large every blob is**, and when it arrived.
- **The whole membership list**, once `ROOT-IN-CLEAR.md` lands, plus the space's
  `:name`.

An edit-per-keystroke document is distinguishable from a file uploaded once. A
space with three objects is distinguishable from one with three hundred. A burst
of activity at 2am is visible. None of that needs a single value decrypted.

**Why it comes out this way.** Nothing here is a mistake in the encryption; it
falls out of choices made for good reasons elsewhere. Events are the unit of
replication, so they cannot be opaque blobs — a peer must read `target`, `attr`,
`writer`, `seq` and `prev` to reconcile at all (§2.3). The fold is universal, so
attribute *names* must be legible for the rule vocabulary to be fixed (§3.2).
Signatures are per event, so events cannot be batched into indistinguishable
chunks. **Metadata is the substrate.** Encrypting it would mean a different
substrate, not a different cipher.

**What that means in practice.** "A peer can host a space it cannot read" is
true and much weaker than it sounds. The host cannot read your documents; it can
describe your working habits. For a personal file-sync space on a VPS you
control that is fine. For anything where *activity itself* is sensitive — who is
talking to whom, when a group formed, whether a file exists at all — this design
does not provide it, and no amount of care with the cipher will.

**Carry forward:** §6.3's one line should be a section, and a rewrite should
state the disclosure positively — *here is what a host learns* — rather than as
a list of things encryption does not do. A reader deciding whether to trust a
host needs the first form.

## The nuclear revoke

**The problem it answers.** `deps` (see `../design/DEPS.md`) narrows backdating without
closing it: a writer about to be revoked can sign events naming only
pre-revocation heads, release them later, and they fold. That is
indistinguishable from an honest peer that was offline, and the literature is
clear that causality alone cannot separate the two.

**The idea.** A second, deliberate act: not *this writer may no longer write*
but **nothing this key ever signed counts**. A root attribute — `:purged`,
say — listing keys whose events never fold, at any position in history.

**Why it works where "valid now" does not.** §7.2.3 rejects making ordinary
removal mean *valid now*, and both its reasons fail to apply here:

- *"A revocation retroactively unwrites history"* — which is the intent, once,
  deliberately, rather than the silent default of every removal.
- *"When a peer learns of the revocation determines what it computes"* — it does
  not, because a purge is **an event in the log**, signed by the space key. A
  peer that has not received it has not received it, and converges when it does.
  Ordinary eventual consistency, not the manufactured fork §7.2.3 fears.

It is also **monotonic**, which the formally-verified alternative (expanding a
revocation's scope to concurrent events) is not — that one has peers
temporarily disagree and converge later, which sits badly with §3.6.

And it closes backdating *completely* rather than narrowing it, because it makes
no claim about time. Backdating works by claiming a past; a purge does not care
what past is claimed.

**What it does not do, and the docs should say so.** It does not make a space
safe from a bad actor. They can still write, their events still replicate, peers
still store them, and anyone who synced before the purge has already seen the
content. What changes is that the space converges on excluding them. **It is a
moderation tool, not a security boundary** — "nuclear option" promises more than
it delivers.

What it does change is the asymmetry: an attacker reduced to backdating faces an
administrator who can invalidate their entire history in one event.

**It operates on keys, and a key is not a person.** A purge names a `writer`,
so it removes everything that key ever signed, across every chain. Three cases,
and they do not come out the same:

| case | outcome |
| --- | --- |
| a member misbehaves and is purged | clean — they lose their writes, nobody else does |
| an attacker forks *someone else's* chain by reusing their public `point` | clean — the branches have different `writer`s, so purging the attacker leaves the victim's chain intact |
| **a key is stolen and used to fork its owner's chain** | **the owner's entire history goes with the attacker's** |

The third has no finer-grained answer available. Both branches carry the same
`writer` and the same valid signature, and `point` is self-chosen and unverified
— so there is nothing in an event that distinguishes *Alice on her laptop* from
*whoever took Alice's key*. Purging by `point` would mean trusting the one field
the attacker picked freely.

So a purge conflates two situations that want opposite treatment: **this person
should be removed** and **this key has been compromised**. The first should drop
their writes; the second should keep them. Distinguishing them needs a stable
identity above keys, with rotation — which is §1 above, and does not exist.

**And it cannot touch the space key at all** — not by policy, but structurally.

A purge list lives on the root, and root events are admitted on a signature from
the space key alone (§7.2.1). So purging the space key means an event saying
*do not fold what this key signed*, signed by that key, on the one object only
that key can write. Honour it and it invalidates itself and the writer set with
it, leaving a space with no membership; ignore it and it does nothing. There is
no third reading.

That is §7.2's circularity arriving from the other side. §7.2.1 broke the loop by
making root events self-authorising — *"admitting one is a signature check, never
a lookup"* — and a purge is precisely the lookup that puts it back.

**So a compromised space key has no in-band response whatsoever.** It cannot be
purged (above), cannot be removed from `:writers` (it is the authority the set
derives from, and `removeWriter` already refuses), and cannot be rotated (the key
*is* the space id — `mint()` returns one keypair whose public key names the
space, so a new key is a new space). Whoever holds it can rewrite membership,
purge every other writer, and be answered only out of band: everyone agrees to
abandon the space and start another.

§5.1.1 names key *loss* as the largest unresolved risk in the design. This is the
same risk with the opposite sign — losing the key means nobody can administer,
leaking it means anyone can — and only the first is written down.

None of this is a flaw in the purge. It is the price of §7.2.1's bootstrap, which
is load-bearing; the alternative was causal dependencies in the envelope, and
§7.2 records why that was avoided. But it gives the feature a shape worth stating
plainly: **a purge protects a space from its writers, and cannot protect it from
its owner.**

**Open before it could be built.**

- **What happens to events that causally depend on purged ones?** Alice makes a
  folder, Bob fills it, Alice is purged. The fold is total (§3.4) so Bob's files
  probably survive and reparent — but *probably* is not good enough, and this is
  the cascading-invalidation problem the Byzantine-CRDT literature warns about.
  Worth prototyping before designing.
- **It must be visibly exceptional.** A separate verb, never a flag on
  `removeWriter`. §7.2.3's chat example is exactly why this is not the default.
- **Only the space key can do it**, which is automatic for a root attribute and
  inherits §1's problem: co-administrators share that key, so the log cannot
  record which of them purged someone.

Most of the machinery exists — `admitsWith` already computes admission per
event, and a purge is one more predicate on the same pass.

