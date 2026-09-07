# The main space

**Status: a proposal.** Nothing here is built. It replaces four separate
mechanisms — the inventory, petnames, locators, and an invented peer-state sync
— with one: **a peer holds exactly one space, and everything else it knows about
is a link inside it.**

---

## The model

A space contains ordinary objects — files, folders — and among them **links** to
other spaces. A link's `:name` is what the holder calls that space; a link's
attributes carry where it was last reached.

That one idea replaces three: there is no inventory, no petname store, no
locator cache. Those were three ways of saying *this peer knows about that
space, calls it X, and last found it at Y*, which is one object with three
attributes.

A **main space** is the space a peer *holds and serves* — its own. A **hub** is
the same thing with different contents: a curated main space whose links point
at spaces other people want. Not a class of peer (§5.6 stays intact), just a
peer whose space happens to be interesting.

### Holding a space is not the same as looking at one

**A server holds exactly one main space, because it has no interface to hold
anything else.** It is a store, a set of connections, and nothing to render
into. One space is what it can offer, so one is what it has.

**A client with an interface has tabs.** Several spaces open at once,
independent, each rendering its own tree. Following a link **opens a tab**; it
does not write anything. Acquiring a space — deciding you want to keep it —
writes a link into a space of your own, and that is a separate, deliberate act.

Those two actions were conflated in an earlier draft, and separating them
removes a real problem. If browsing wrote links, a main space's log would
accumulate a permanent record of everything ever opened: appends are forever
(§2.1), `:deleted` hides a link without removing the event, and the growth would
be unlike anything else in the design — a file you make is content, a link you
opened once is not. It was also a privacy shape nobody chose, since that history
would sync anywhere the space syncs. With tabs the problem does not arise; the
open set is interface state and touches no log.

**So a client may have no main space at all.** A browser that only views other
people's spaces needs a keyring and a tab list. One that keeps its own files
needs somewhere to keep them, and that is a main space. *Every peer that holds
content has one; a pure viewer does not.*

## What a link is

**An object whose `:kind` is `link` and whose body is the target's public key.**

```
:kind    'link'        this object is a reference to a space
:body    <32 bytes>    the target's public key — a register
:name    'notes'       what this peer calls it: the old petname
:parent  <uuid>        which folder it sits in, like any object
```

Nothing else. **No address**: a link names a space and says nothing about where
it is ([LOCATORS.md](LOCATORS.md)).

### Why `:kind`, and why the body

§3.9 is open about how a *blob* reference is expressed, and asks whether it
should be a `:kind` or a value encoding. A link looks like a third case of the
same question and is not, which is worth stating because an earlier draft here
assumed the three had to be settled together.

§3.9's deciding case is a snapshot: *"a snapshot of a log-backed body is itself
a content-addressed blob, belonging to an object whose body is emphatically not
a blob"* — so *is this a blob* and *is this stored out of line* are different
questions. That is a **storage** concern cutting across a **semantic** one.

A link is not that. It does not say *this value lives elsewhere*; it says *this
object is a reference to a space*. What the thing **is** — which is what §4.2
says `:kind` is for. So the two questions are separable and this one can be
settled now.

Three checks against §4.2, all of which pass:

- **`:kind` is set once and never changed.** A link is a link forever; making it
  something else means making a new object. That is §4.2's rule exactly, and it
  is what rules *out* a value encoding: a value can change, a kind cannot.
- **The body is a register over 32 bytes** — structurally identical to the blob
  rule, which is a register over a hash. One new body rule, and it is
  `bytesRegister` with a length check.
- **No overloading.** §4.2's complaint about media types is that they name the
  rule *and* describe the bytes. `link` names only the rule, so §3.9's
  outstanding question does not arrive here.

**The key belongs in the body, not an attribute.** An earlier draft put it in a
`:space` attribute. A link *is* its target, the way a file *is* its bytes; an
attribute would make the key a property of some other thing and leave the object
with no body, which §4.2 reserves for folders. It also makes links and files the
same shape — a kind and a body — which is the uniformity that suggests it is
right.

**The key is an identity, not a locator.** Verification is against it and it
never changes; addresses are hints that go stale (§5.1, §5.3). Worth restating
because a link is exactly where the temptation to conflate them lives.

### What an unfamiliar client does with one

`:name` and `:parent` are already the fixed vocabulary (§3.2), so a link folds
in phase 2 with no declaration. A client that has never heard of `link` folds
the tree correctly, sees an object named `notes` whose kind it does not
recognise, and shows it — §3.1's tiering, unchanged. It simply cannot follow
it.

### Addresses are not on the link — see LOCATORS.md

An earlier draft of this document put the locator cache on the link, as an `:at`
attribute, and worked out which merge rule it wanted. **That was wrong**, and
[LOCATORS.md](LOCATORS.md) has the correction and the scenario analysis behind
it.

The short version: §5.3 had already rejected a locator on a stored link, for a
reason the design conversation had not reached — *a rotted address embedded in
replicated data is worse than no address at all*, because it looks
authoritative, gets tried, and propagates to everyone holding your space. A
stale entry in a client-side cache costs one dial and dies with the client.

So **a link carries a name, a target key in its body, and no address.** Where a
space is served is said by peers on the ephemeral channel, and by a client-side
cache that is in no space at all.

The rule question that draft answered — grow-only set with read-time expiry
rather than an OR-set — was the right answer to the wrong attribute. It was then
carried over to `:serves`, a locator list on the target's own root, and
`LOCATORS.md` has since dropped that too: **no locator is stored in any space.**
The peer that knows a serving address usually cannot write the root, and
reachability is a property of a pair of peers rather than of a space.

## Resolution falls out

§5.3 asks for one thing: **given a public key, produce candidate locators.**

Under this model a peer answers from what it already knows for other reasons:
the spaces it serves, and what its **current connections** have announced. Not
from addresses stored in its links — those carry none (above), and a cached
address that rotted is worse than no answer.

What links *do* contribute is the shape of the graph. A hub holding a link to K
is a peer likely to be connected to something serving K, which is why
*"reaching a space that contains a link generally means reaching what it points
at"* (§5.3). The curation carries the knowledge without the addresses being
written down.

This explains why hubs are useful without granting them authority. A hub answers
more queries because it is connected to more peers — not because it is trusted.
§5.3's safety argument carries over untouched:

> Because verification is against the key, a resolver cannot lie in any way that
> matters. A wrong or hostile answer makes you *dial* something; it cannot make
> you *believe* something.

The caps §5.3 wants — per-space, per-answerer, dial timeout — apply unchanged,
and are still numbers to measure rather than choose.

**One consequence worth stating: answering reveals what you hold.** A peer that
answers "yes, I know where K is" has disclosed that it holds a link to K. §5.7
avoids exactly this shape for rendezvous, where the signalling server is
deliberately never told which space two peers are meeting about. Here it is
inherent — resolution *is* disclosure — so it must be a choice: a peer decides
whether to answer at all, and for which links.

## What is *not* in the space

**Connections.** Who is connected, since when, in what state. Derived from live
sockets, changing constantly, and **not meaningful to replicate** — "this peer
has three connections" is true of that peer and false of a browser looking at
it. Replicating it would converge two peers on a fact only one can have.

**Activity.** The last N events, for an operator. Bounded, ephemeral by design,
and §10's channel exists for exactly this.

**Per-space status.** `writable`, `openElsewhere`, `forks` — computed from the
keyring, the lock and the fold. Derived, never stored.

The line: **a space holds what you decided; the ephemeral channel carries what
is true right now.** A log is a bad place for facts that change per second and
are false elsewhere.

## What local state remains

Not zero, and the residue is the interesting part:

- **The keyring.** Secrets, never replicated, §5.1.1's unresolved risk.
- **Which space to hold**, for a peer that holds one. A single id, and it cannot
  live in a space — that would be circular — so it is configuration: a flag, an
  env var, a line in a file.
- **Which spaces are open**, for a client with an interface. A list of keys,
  and interface state rather than anything the engine knows about.

Four interfaces become one interface and two lists of keys, one of which is
secret. That is the shape the Keystore split was reaching for, arrived at from
the other direction.

**The open-tab list has to be persisted**, and this document first said the
opposite — that it was "a UI question, deliberately not a design one", since
losing it costs reopening a tab. That was wrong, and the model is why: with no
inventory, nothing else records that a space exists. A client that forgets its
tabs has no route back to a space it made itself, so the cost is the space
rather than a tab.

**Closing a tab deletes the space** (`WEB-CLIENT.md`). Not forced by the model —
which says only that a client may hold spaces — but it follows from there being
no inventory: with nothing recording that a space exists, a client that keeps
closed spaces accumulates them invisibly and offers no way to remove one.

It is still not an inventory in this document's sense — it is per-client, never
replicated, and holds only what someone had open. But it is durable, which
makes it the third thing in the local-state list rather than a detail below it.

## What each program is

All four are the same three parts — a keyring, an engine `Client`, and a
renderer. What differs is where the store lives, how many spaces are open, and
how the renderer draws. If a scenario needs a *fourth* part, that is a signal
the model is short.

| | store | spaces open | renderer |
| --- | --- | --- | --- |
| **CLI** | files | one, named per command | prints and exits |
| **TUI** | files | several, as tabs | a screen |
| **web** | IndexedDB | several, as tabs | a browser |
| **server** | files | **one, plus what it links to** | none |

**The server is the odd one, and the reason is that it has no interface.** It is
a store, a set of connections, and nothing to render into — so one space is what
it *chooses*, and everything else it holds follows from that one. Everything
else opens as many as its interface can show. That asymmetry is not a special
case bolted on; it falls out of what a renderer is for.

**A server holds what its main space links to**, to a configurable depth (one
hop by default). This is what makes hosting a drag: make a space in a browser,
drop a link to it in your synced copy of the server's space, and the server
holds it, serves it, and mirrors its blobs — because the link is already in the
space it was serving anyway.

The link is also the *authorisation*, which is why this needs no new permission
concept. Only someone who may write the main space can add one, so what a hub
hosts is exactly what its curators chose; unlinking withdraws it, since §7.2.3's
tombstone already means "no longer". Compare `acceptUnknownSpaces`, the blunt
alternative, which the engine describes as making a peer free storage for
strangers.

**Withdrawing hosting does not delete.** A mis-drag would otherwise destroy what
may be the only copy of someone's space, so unlinking stops the hosting from
being renewed and leaves the data; discarding it is a separate, deliberate act.

There is no *hub* program. A hub is a server whose one space someone curated.

Two consequences worth stating, because `CLIENTS.md` spent most of its length on
them:

**`thing` and `thing attach` stop being modes.** One program; a tab's space is
local or remote, and a client can hold both kinds at once. That was three modes
and a control protocol; it is now where a tab's events come from.

**"Configure the server" and "edit a space" are the same act** for the common
case. Adding a link to a server's main space tells it to hold another space, and
it does — because that link is in the space it is already serving. No admin
verb, no new protocol, and it works from any client that can write there. This
is built: `hostDepth` on the server, `--host-depth` on `thing serve`.

One detail that only shows up past one hop: **every hosted space is watched, not
only the main one.** A hub holds a linked space before it has any of that
space's events, so the links *inside* it are not visible until they replicate —
watching only the main space would make deeper hosting work after a restart and
not before.

## The cases, in more detail

**A terminal client** names a space per command, holds it on disk, and edits it
directly. Today's CLI with links added: `thing ls notes` finds the link named
`notes` and follows it, which is what a petname lookup used to be.

**A client keeping its own files** holds a space of its own — in IndexedDB for a
browser, on disk for a TUI — and that space syncs with its owner's other devices
if they hold the same key. That is how a person's own collection follows them.

**A client that only views** holds no space of its own at all. A keyring and a
list of open tabs is the whole of it. Nothing about this is degraded; §6.1
already says storing and serving without a writing key is an ordinary way to
participate, and this is a step further — participating without holding
anything.

**A client viewing a server** opens the server's space in a tab and replicates
it *by ordinary peer replication* — it is a space, so this needs nothing new.
Fold it, render the tree, follow its links into further tabs. With a writing key
for that space it can edit, which is how a hub gets curated; without one it
reads.

That last case is the one the whole design is for, and it works because the
thing a UI needs most — what spaces there are and what they are called — is
exactly what a space replicates well.

## Administration: the CLI only

**The web client and the TUI are space editors, not admin consoles.** Neither
can restart a peer, read its disk usage, or list its open connections. Server
administration happens through the CLI, or other tools on the same machine.

That reads like a gap and is a decision, for a reason worth writing down.

**Space authority cannot answer operator questions.** Every authority in this
design is per-space — the space key, `:writers`, moderators (§7.2) — and each
answers *may this key write to this space*, verified by signature and computed
by the fold. *May you shut down this process* is not that question. It is about
a **machine**, not a space, and the two do not coincide in either direction: a
hub might have twenty curators, none of whom should be able to restart it; and
its operator might hold no writing key at all, being a host rather than a
curator, while being exactly who should.

So there is no derivation available. Remote administration would need an
operator identity, credentials, and a way to grant and revoke them — a whole
subsystem, reusing nothing, invented for a restart button.

**The local socket's auth model is the filesystem, and that is an answer rather
than a placeholder.** `CLIENTS.md` noted the socket must be local because any
caller on it can control the peer, which is fine when the permissions guarding
the socket also guard the key files. Read as convenience, that is a limitation;
read properly, it is *the* authorisation model — "can you open this socket" is
decidable, already enforced, and needs nothing built. The moment a control verb
crosses a network that gate is gone and something must replace it.

**What this costs, stated plainly.** A web client showing a server's tree cannot
say whether that server is healthy — no disk usage, no connection count, no
replication lag. Someone will want those, and the answer for now is a terminal.
Paying an auth subsystem to avoid an `ssh` is the wrong trade at this stage.

It also means the TUI is not quite one program: attached over a socket it is a
space renderer, and on the machine it can additionally be a control surface.
That asymmetry is real and is the cost of not inventing the auth model.

### Deferred: durable operator history

An earlier draft asked what *a day of connection history* would look like. It
does not fit anywhere: not the main space (per-peer, false elsewhere, and
appends are forever), not the ephemeral channel (which survives nothing). It is
a fourth kind of state — **durable, local, unreplicated** — that the design has
no place for.

Rather than invent one, the activity buffer stays what it is: the last N events,
in memory, gone on restart. If durable history is ever wanted it is a log file
and a query over it, and the fourth category can be designed then.

## The server's API

What is left is what no space can hold and no remote client may do:

```
which main space am I pointing at, and point me at another
what connections do I have open
connect to / disconnect from an address
shut down, restart
```

Local socket, and per the section above that is the authorisation model rather
than a temporary constraint.

## Cycles, and why neither case needs a bound

Two hubs linking each other, or a link back to a space you already hold, are
certain rather than hypothetical. §3.4's cycle-breaking works on `:parent`
within one fold and does not reach across a link, so this needs its own answer —
and it turns out to need two, because fetching and drawing are different
problems.

**Fetching a link's space: a visited set.** Spaces are held by key, so *do I
have this one* is a lookup. Arriving at a space already held is not an error to
recover from; there is simply nothing to do. Idempotence does the work, which is
the same argument §5.6 makes for hub convergence — *"two peers that cannot reach
each other converge through this one, and there is no relay code"*. A cycle
costs one lookup.

**Drawing the tree: expansion is manual.** A renderer draws one level and stops.
Expanding a link is something a person clicks, so nothing recurses and **there
is no loop to bound** — no depth limit to choose, and no truncation someone hits
legitimately. Infinite depth is fine in the way infinite scroll is fine: you can
always go further, and nothing is computed until you ask.

That is the same principle as tabs, one level down. Tabs make *opening*
deliberate; manual expansion makes *descending* deliberate. Both replace an
automatic traversal with a user action, which makes the unbounded case
unreachable rather than merely survivable.

It also answers a laziness question the model had left open: a hub with a
hundred links does not make a client fetch a hundred spaces. It draws a hundred
rows and fetches what is expanded.

**One consequence for whoever designs the interface:** a collapsed link cannot
show what is inside it. No child count, no preview, no "3 files" — knowing that
means fetching the space. That is arguably the right affordance, since a link to
someone else's space should not look like a folder in your own, but it is a real
difference from a filesystem tree where expanding is free.

## What tabs fixed

Recorded because the fix was better than the workaround it replaced, and the
mistake is one worth not repeating.

An earlier draft had browsing *be* editing: following a link wrote one, closing
it removed one. That made a main space's log a permanent record of everything
ever opened — appends are forever (§2.1), and `:deleted` hides a link without
removing the event. A growth shape unlike anything else in the design, and a
privacy shape nobody chose, since the history would sync wherever the space did.

The answer proposed at the time was compaction (§9.2, unbuilt) — narrowing the
window rather than closing it, which `../working/LEARNINGS.md` §5 warns about in another
context.

Separating *open* from *keep* removes the problem instead of deferring it.
Nothing is written unless someone decides to keep it, and the open set is
interface state that touches no log. It also disposes of a second thing the
draft had flagged as unresolved: a "peek" needing an open-but-unlinked notion of
a space. That notion is the tab list.

## What this does not solve

**A remote client cannot tell whether a peer is healthy.** Covered above: it is
a decision, not an oversight, and the cost is that someone wanting disk usage or
connection counts opens a terminal. The model gives a remote UI *content* for
free and *operations* not at all, and that split is clean — but it is a split,
and the earlier claim that the control API is "much smaller than `CLIENTS.md`
proposed" was true about writes and wrong about observability.

**Curating a shared hub needs multi-writer, and multi-writer has no
attribution.** Editing a hub's main space means holding a writing key for it.
Handing out *the space key* is wrong — it is the space's identity and root
authority (§7.2.1). The right answer is `:writers`, which exists (stage 9). But
a curator is then an ordinary writer who cannot admit other curators, and every
curation is attributable to a key rather than a person (`../working/LEARNINGS.md` §1).

A shared hub is precisely where *who added this link* starts to matter, so this
design puts weight on a gap it does not create.

**Cycles are certain, not hypothetical.** Two hubs linking each other, a link
back to your own main space. §3.4's cycle-breaking handles `:parent` cycles
*within* one space's fold; a cycle *between* spaces is a different graph and
nothing walks it today. Whatever renders "one big filesystem" must not recurse
forever, and that is a renderer concern rather than a fold one — but it needs
saying, because the fold's guarantee does not extend across a link.

## What would test it

Cheap, in the engine, before any UI:

1. **A link folds in a client that has never heard of links.** The tree is
   correct, the object appears, its kind is unrecognised (§3.1).
2. **Two devices with one main-space key converge on an inventory**, including
   concurrent link additions, and — before it was dropped — concurrent `:serves`
   additions from two
   devices — the case a register would silently lose.
3. **Resolution answers from live connections**, not from stored addresses: a
   peer serving K, or connected to one that does, answers; a peer merely
   holding a link to K does not invent an address for it.
4. **A cycle between two spaces terminates.** See below; the answer differs for
   fetching and for drawing, and neither needs a depth limit.
5. **A client replicates a server's space** over a socket and renders it, with
   no code that is not already peer replication.

The second and fifth are the load-bearing ones. Two would prove the OR-set is
needed; five would prove the whole claim.
