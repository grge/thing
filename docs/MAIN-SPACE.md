# The main space

**Status: a proposal.** Nothing here is built. It replaces four separate
mechanisms — the inventory, petnames, locators, and an invented peer-state sync
— with one: **a peer holds exactly one space, and everything else it knows about
is a link inside it.**

---

## The model

A peer is pointed at a single **main space**. That space contains ordinary
objects — files, folders — and among them **links** to other spaces. A link's
`:name` is what this peer calls that space; a link's attributes carry where it
was last reached.

Nothing else is per-peer state. There is no inventory, no petname store, no
locator cache: those were three ways of saying *this peer knows about that
space, calls it X, and last found it at Y*, which is one object with three
attributes.

A **hub** is the same thing with different contents: a curated main space whose
links point at spaces other people want. Not a class of peer (§5.6 stays
intact) — a peer whose space happens to be interesting.

Browsing is editing. Opening a remote space writes a link; closing it removes
one. A UI presenting *"one big filesystem, remote spaces as subfolders"* is
rendering the main space's tree, and the tree is the truth rather than a view
over some other structure.

## What a link is

An object with `:kind` naming it a link, plus:

| attribute | rule | holds |
| --- | --- | --- |
| `:name` | register | what this peer calls it — the old petname |
| `:space` | register | the target's public key, 32 bytes |
| `:at` | (below) | where it has been reached |
| `:parent` | register | which folder it sits in, like any object |

`:name` and `:parent` are the fixed attribute vocabulary already (§3.2), so a
link folds in phase 2 with no new rule and no declaration. That is the point: a
client that has never heard of links still folds the tree correctly, sees an
object with a name and a kind it does not recognise, and shows it — §3.1's
tiering, unchanged.

**`:space` is a key, not a locator.** Identity and address are separate (§5.1,
§5.3): the key is what verification is against and never changes; addresses are
hints that go stale. Conflating them was never on the table and is worth
restating because a link is exactly where the temptation lives.

### `:at` — the locator list

Not a register. A register keeps one address, and a space genuinely has several
— a home server, a laptop, a hub that also carries it. §5.3 says locators are a
*list* with expiry.

So `:at` wants a set rule, and the vocabulary does not have one. Two options:

- **An OR-set**, which §3.2's rule table already names as a merge rule and
  nothing implements yet.
- **A register holding an encoded list**, which is what `:writers` does and is
  why concurrent membership edits lose one (§7.4).

The OR-set is right here, and this is the first concrete demand for it. A
locator learned on your laptop and one learned on your phone should both
survive; last-writer-wins would drop one, and the failure would be invisible —
a space that becomes unreachable because the address that worked got
overwritten by one that no longer does.

**Expiry is not a rule concern.** A locator's age is a property of when it was
*written*, which `wall` already carries. Stale entries are filtered at read
time, not merged away — a rule that dropped them would make the fold depend on
the current time, which §3.6 forbids.

## Resolution falls out

§5.3 asks for one thing: **given a public key, produce candidate locators.**

Under this model that is a query over data a peer already holds for another
reason. *Do you have a link whose `:space` is K? If so, what are its `:at`
values?* Nobody maintains an index; the links exist because someone curated
them.

This explains why hubs are useful without granting them authority. A hub answers
more queries because it holds more links — not because it is trusted. §5.3's
safety argument carries over untouched:

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
- **The main space's id.** One value. It cannot live in a space — that is
  circular — so it is configuration: a flag, an env var, a line in a file.

Four interfaces become one interface and one string. That is the shape the
Keystore split was reaching for, arrived at from the other direction.

## The three cases

**A terminal client** points at a local main space, holds it on disk, and edits
it directly. Today's CLI with links added.

**A browser with its own storage** points at its own main space in IndexedDB.
Ordinary peer. Works offline. Its main space syncs with its owner's other
devices if they hold the same key, which is how a person's inventory follows
them.

**A browser viewing a server** connects to the server's main space *by ordinary
replication* — it is a space, so this needs nothing new. The browser holds a
replica, folds it, renders the tree. With the space's writing key it can edit;
without, it reads. Live connection status arrives over the ephemeral channel,
not the log.

That third case is the one the whole design is for, and it works because the
thing the UI needs most — the list of spaces and what they are called — is
exactly what a space replicates well.

## The server's API

Much smaller than `CLIENTS.md` proposed, because most of what that API was
carrying is now a space. What is left is what no space can hold:

```
which main space am I pointing at, and point me at another
what connections do I have open
connect to / disconnect from an address
shut down, restart
```

Local socket, same constraint as before: any caller can control this peer, which
is fine when the filesystem permissions guarding the socket also guard the keys.

## What this does not solve

**Link churn is permanent.** Browsing creates and destroys links, and appends
are forever (§2.1). Your main space's log becomes a record of everything you
opened. `:deleted` hides a link; it does not remove the event.

That is a growth shape nothing else in the design has — a *file* you make is
content, a link you opened once is not — and it is a privacy shape nobody chose:
if your main space ever syncs anywhere, so does that history. §9.2's compaction
is where it belongs, and compaction is unbuilt.

**A short-lived "peek" therefore should probably not write a link at all.**
Which means the UI needs a notion of an open-but-unlinked space, and that is
in-memory state the model does not currently have. Worth deciding deliberately
rather than discovering.

**Curating a shared hub needs multi-writer, and multi-writer has no
attribution.** Editing a hub's main space means holding a writing key for it.
Handing out *the space key* is wrong — it is the space's identity and root
authority (§7.2.1). The right answer is `:writers`, which exists (stage 9). But
a curator is then an ordinary writer who cannot admit other curators, and every
curation is attributable to a key rather than a person (`LEARNINGS.md` §1).

A shared hub is precisely where *who added this link* starts to matter, so this
design puts weight on a gap it does not create.

**Cycles are certain, not hypothetical.** Two hubs linking each other, a link
back to your own main space. §3.4's cycle-breaking handles `:parent` cycles
*within* one space's fold; a cycle *between* spaces is a different graph and
nothing walks it today. Whatever renders "one big filesystem" must not recurse
forever, and that is a renderer concern rather than a fold one — but it needs
saying, because the fold's guarantee does not extend across a link.

**A link is a third kind of reference**, and §3.9 is already open about the
other two. An object's body may be a blob (a hash, fetched separately) or
log-backed; a link points at a *space*. That is a third thing, and §3.9's
argument — that "is this a blob" and "is this stored out of line" are different
questions — suggests the answer is a value encoding rather than a `:kind`, which
would make a link a *value* that happens to name a space. Not settled here, and
it should be settled with §3.9 rather than separately.

## What would test it

Cheap, in the engine, before any UI:

1. **A link folds in a client that has never heard of links.** The tree is
   correct, the object appears, its kind is unrecognised (§3.1).
2. **Two devices with one main-space key converge on an inventory**, including
   concurrent link additions — the OR-set case that a register would fail.
3. **Resolution answers from links.** A peer holding a link to K reports its
   `:at` values; one that does not, does not.
4. **A cycle between two main spaces terminates** when something walks the tree.
5. **A browser-shaped client replicates a server's main space** over a socket
   and renders it, with no code that is not already peer replication.

The second and fifth are the load-bearing ones. Two would prove the OR-set is
needed; five would prove the whole claim.
