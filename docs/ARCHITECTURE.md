# Architecture

A peer-to-peer substrate for collaborative applications, running in the browser.

This document describes the design in full and assumes no prior context. It is
written to be read start to finish by someone who has never seen the system.

---

## 1. Overview

The system replicates **append-only logs of signed events** between browser
peers over WebRTC, with no server holding the data.

A **space** is the unit of everything: identity, sharing, storage and
replication. A space is a log, and a log folds into state. What that state
*means* — a folder of files, a chat, a shared canvas — depends on the space's
declared type. The mechanism that folds the log is the same for all of them.

Three layers, strictly separated:

```
┌──────────────────────────────────────────────────────────────────┐
│ VIEW        draws the state                                      │
│             type-specific · shipped as data over the network     │
├──────────────────────────────────────────────────────────────────┤
│ FOLD        computes state from events                           │
│             universal · one algorithm · driven by declarations   │
├──────────────────────────────────────────────────────────────────┤
│ SUBSTRATE   stores, signs, verifies and replicates events        │
│             payload-blind · never interprets a value             │
└──────────────────────────────────────────────────────────────────┘
```

The separation is the design. Each layer knows strictly less than the one above
it, and the two lower layers are identical for every application:

- The **substrate** moves bytes it never interprets. It can replicate a space
  for an application that does not exist yet.
- The **fold** computes state by applying, to each attribute, the merge rule
  that attribute declares. It is deterministic and identical in every client, so
  two peers holding the same events compute the same state — including peers
  that have never seen the application the space belongs to.
- The **view** is the only layer that is application-specific, the only layer
  that ships over the network, and the only layer that can be wrong without
  consequence for anyone else.

**Applications ship views, never folds.** This is the central constraint and
Section 8 explains what it buys.

Cutting across all three layers, a space has **two keys with separate jobs**: a
keypair whose public half *is* the space's identity and whose private half
authorises writes, and an optional symmetric key that decrypts content. The
first makes a space verifiable, the second makes it private, and because they
are separate, **a peer can hold and serve a space it cannot read** (Section 6).

### 1.1 Properties this produces

| | |
|---|---|
| **No server holds data** | Peers exchange events directly. Infrastructure assists connection, never custody. |
| **Order-independent** | The log is a *set*. Any peer with the same events has the same state, regardless of arrival order. |
| **Offline-capable** | A disconnected peer keeps writing. Reconnection is set reconciliation, not replay. |
| **Verifiable** | Every event is signed. A space's identity is a public key, so provenance is arithmetic rather than convention. |
| **Application-agnostic** | A peer can store, verify, replicate, fold and compact a space whose application it does not have. |
| **Readable only by intent** | Content may be encrypted under a separate key, so a peer can be a complete replica of a space it cannot read. |

---

## 2. The substrate

The substrate stores and replicates events. It never reads a value.

### 2.1 Events

An event is one assertion: *this attribute of this object now has this value.*
Events are never mutated and never deleted.

```
Event {
  writer:  PublicKey      // 32 bytes, Ed25519 — the writer's identity
  seq:     u32            // per-writer, starts at 0, strictly incrementing
  prev:    Hash | null    // hash of this writer's event seq-1; null iff seq == 0
  lamport: u64            // logical clock, for ordering concurrent writes
  target:  Uuid           // the object this asserts about
  attr:    AttrName       // which attribute
  value:   Value          // the asserted value
  wall:    u64            // wall-clock ms — display only, never resolves anything
  sig:     Signature      // 64 bytes, over the canonical encoding of the above
}
```

There is no space field: a space is established once per connection rather than
repeated on every event.

**Objects** are identified by UUID, assigned at creation and never reused. An
object's state is a set of independently-resolved attributes, so two writers
touching different attributes of the same object never conflict.

**Canonical encoding.** Two implementations must produce byte-identical
encodings, since hashing, signing and deduplication all depend on it: fixed field
order, length-prefixed values, no maps, no floating-point in hashed positions.

### 2.2 Chains, clocks and the shape of ordering

**Within a writer**, order is exact. Each event carries the hash of that writer's
previous event, forming a per-writer chain. A gap or a fork is detectable.

**Between writers**, there is no order, and none is needed. Concurrent writes to
the *same attribute of the same object* are resolved by that attribute's merge
rule (Section 3); everything else is genuinely independent.

**Lamport clocks** supply a deterministic tiebreak where a merge rule needs one.
A writer increments its counter on write and raises it to `max(own, incoming)`
on receipt. Ties break on writer public key bytes, so the comparison key
`(lamport, writer)` is a total order.

A writer could inflate its clock to win every conflict. Signing is what makes
this fail: an inflated clock is only usable by the writer whose key signs it,
and a writer that persistently misbehaves can be identified and ignored — the
misbehaviour is attributable rather than anonymous.

### 2.3 Replication

Peers exchange **version vectors**: for each writer, the highest sequence number
held contiguously. Reconciliation is the difference between two vectors, and
events arriving out of order within a writer are held aside until their
predecessor arrives.

The substrate verifies three things and no others:

1. The signature is valid for the claimed writer key.
2. `prev` matches the hash of that writer's previous event.
3. `seq` follows contiguously.

It does not check whether an attribute exists, whether a value is sensible, or
whether the writer is permitted to say it. Those are decisions for higher
layers, and keeping them out is what allows a peer to replicate an application
it does not have — or a space it cannot read (Section 6).

### 2.4 Blobs

Large content does not travel in the log. A `:content` attribute holds the
SHA-256 hash of a blob, and the blob is fetched on demand from any peer that has
it.

- **Content-addressed** by full SHA-256 of the plaintext, so identical content
  deduplicates and integrity is verified by rehashing the reassembly.
- **Chunked** for transfer, with backpressure and resume from a chunk index.
- **Availability is advertised.** Version vectors describe events, never blobs.
  Peers exchange blob-availability sets so "who holds this content" is
  answerable when the original writer is long gone.

The asymmetry is deliberate: **events replicate to everyone, blobs are pulled by
whoever wants them.** Metadata is small and determines what you might want next,
so it is always complete; content is large and often unwanted.

---

## 3. The fold

The fold turns a set of events into state. There is exactly one fold algorithm,
it is identical in every client, and no application supplies its own.

### 3.1 Attributes declare how they merge

Every attribute is declared with a **merge rule** — a small, fixed vocabulary of
conflict-resolution strategies:

| Merge rule | Resolves concurrent writes by | Example attribute |
|---|---|---|
| **LWW-register** | highest `(lamport, writer)` wins | `:name`, `:parent` |
| **Counter** | sum of per-writer counts | `:votes` |
| **OR-set** | add/remove with causal tags; concurrent add wins | `:tags` |
| **Sequence** | positional identifiers, order-preserving | `:text` |
| **Flag** | monotone; set-wins or clear-wins as declared | `:deleted` |

The fold is then, for a space of any type:

> for each `(object, attribute)`, gather every event asserting it and apply the
> merge rule that attribute declares.

Each merge rule is a **join-semilattice**: merging is commutative, associative
and idempotent. Because the fold is nothing but the application of those rules,
the whole fold inherits those properties. Order-independence is therefore
*structural* — a consequence of the algebra, not a property maintained by care.

### 3.2 Totality

Every event set folds to *something*. There is no such thing as a log that
cannot be folded:

- An event referencing an unknown object yields an object with that one
  attribute set.
- A `:parent` cycle is broken at fold time by a deterministic rule (the smallest
  UUID in the cycle is re-parented to the root), and the resolution is
  fold-local — never written back as an event.
- An attribute whose merge rule a client does not recognise is folded as
  unresolved, leaving the rest of the state correct.

Totality is what allows a peer to hold a partial log and still have coherent
state, which is the normal condition in a network where peers come and go.

### 3.3 The root

Every space has a root object, materialised by the fold rather than stored
specially. Attributes on the root are therefore **space-level attributes**, and
no separate concept of space metadata is required.

The root carries the space's type declaration (Section 4), its writer set
(Section 7), a suggested name, and any resolution hints (Section 5.3).

### 3.4 Determinism

The fold is a pure function from an event set to state, with no clock, no
randomness, no I/O and no dependence on arrival order. Two clients holding the
same events produce not merely equivalent state but **byte-identical serialised
state**.

That is a strong requirement and it is deliberate: Section 9 depends on being
able to hash the fold output and have two peers agree on the hash.

---

## 4. Space types

A space's root declares its **type**. A type is two things:

1. **A schema** — for each attribute the type uses, which merge rule it has.
   This is data. The universal fold reads it.
2. **A view** — how to draw the folded state. This is code, and it is the only
   code that ships (Section 8).

**A type never supplies a fold.** If an application appears to need its own fold
algorithm, the correct response is to add a merge rule to the shared vocabulary,
not to let that application interpret the log privately.

### 4.1 What follows from that

- **A peer can replicate a space of an unknown type.** Signatures, chains and
  version vectors do not read payloads.
- **A peer can fold a space of an unknown type**, given the schema, and so can
  verify, snapshot and compact it. It holds correct state it cannot draw.
- **A peer that lacks the view can only refuse to draw.** It refuses explicitly
  rather than rendering a half-understood approximation.
- **The type is not a permission.** It says what the bytes mean, not who may
  write them; that is Section 7.

### 4.2 Example types

| Type | Schema is mostly | State is |
|---|---|---|
| **Filesystem** | LWW on `:name`, `:parent`, `:content` | A tree of files and folders |
| **Chat** | append-only set ordered by clock | A message list |
| **Board** | sequence and positional rules | A spatial canvas |
| **Code** | LWW on module contents | A bundle of executable modules |

The filesystem is the built-in type, shipped with the client so that the system
can bootstrap. It is not otherwise privileged: anything the filesystem view does,
another view can do.

---

## 5. Identity, addressing and connection

Three concerns that are commonly fused, kept separate:

| Layer | What it is | How often it changes |
|---|---|---|
| **Identity** | an Ed25519 public key | never |
| **Location** | who claims to serve this space right now | constantly |
| **Handle** | a human-readable name | per person, privately |

### 5.1 A space is a keypair

**A space's identity is an Ed25519 public key.** Holding the corresponding
private key is what makes someone a writer.

Consequences fall out at once:

- **Read-only is arithmetic, not convention.** A peer without the private key
  cannot produce a valid signature.
- **A fork is honestly a different space** — a different key, no collision, no
  ambiguity about which is which.
- **Links are verifiable.** A reference to a space names a key, so what you
  receive either verifies against it or does not.
- **Copying is not a threat model.** Anyone can copy a space and re-share it.
  What signing protects is not access to content but the *identity* of a space:
  the ability to tell the original from a fork, and to prevent someone else
  claiming to be it.

Signing's job is **provenance, not permissions**. It answers "is this space who
it says it is" — not "may this person read it".

### 5.2 Locators are separate, plural and disposable

Identity says *what* a space is. A **locator** says where it can be reached right
now. They are different kinds of thing with different lifetimes:

```
Identity     an Ed25519 public key                      never changes
   ↓ resolve
Locator      { ws } | { via, peer }                     many, changing, expiring
   ↓ dial
Transport    WebSocket direct | WebRTC via signalling
```

There are two locator shapes, and both are flat — a locator is never expressed
in terms of another locator, so one learned third-hand is exactly as usable as
one learned directly:

| Shape | Means | Lifetime |
|---|---|---|
| `{ ws: <url> }` | Open a socket here. The endpoint *is* the peer. | long — a stable address |
| `{ via: <url>, peer: <session> }` | Signal through this server, ask for this session. | short — dies with the session |

Every locator carries a TTL set by whoever announced it, because only the
announcer knows its own volatility. Without expiry, a resolution table fills with
corpses and "resolve" degrades into "try forty dead addresses".

A space has zero or many locators at any moment and none of them is part of its
identity. Changing transport, or replacing the signalling infrastructure
entirely, invalidates no address anyone has ever shared.

### 5.3 Resolution

Resolution answers one question: **given a public key, produce candidate
locators.** It is a lookup, not an authority.

**Because verification is against the key, a resolver cannot lie in any way that
matters.** A wrong or hostile answer makes you *dial* something; it cannot make
you *believe* something, because what answers either produces validly signed
events for that key or does not. The cost of a bad answer is a wasted connection
attempt, bounded by a dial timeout and a cap on how many entries any one peer may
contribute.

That single property is what allows resolution to be casual. It works by two
halves of one mechanism:

- **Announce (push).** A peer that starts serving a space tells the peers it is
  already connected to, and re-announces on reconnect. Availability is maintained
  by the same traffic that does the work — no crawl, no polling. A peer that
  stops announcing is gone within one TTL, which makes serving a genuine opt-in
  rather than a commitment that cannot be withdrawn.
- **Query (pull).** A peer that arrived after an announcement, or is following a
  link to a space nobody has mentioned, asks connected peers directly. Several
  are asked in parallel and the answers are merged rather than taken from the
  first responder.

A peer answers for what it serves and for what it has learned from peers it is
**currently connected to** — one hop, no transit. At one hop, every entry is
about a live connection, so the answering peer has recent evidence. Relayed-of-
relayed entries are ones nobody in the chain can vouch for.

An empty answer distinguishes three cases, because they call for different
behaviour: *I do not track this space* (stop asking this peer), *I track it and
nobody is serving, last seen at T* (ask elsewhere, and tell the user something
true), and *here are locators* (dial them).

**Where locators come from.** A client collates a list in preference order:

1. **The space's own declaration** — a signed list on the root of where the
   writers say it is served. Durable, replicated with the log, and still valid
   months later when every announcement has expired. Unavailable at first
   contact, because it lives in a log you do not have yet.
2. **The share link's hint** — the bootstrap case, and the only source that works
   before you know anybody.
3. **Cache** — locators for spaces opened before. First tried, first discarded:
   a cached locator is stale by default and must never be the reason a space is
   reported gone.
4. **Learned** — whatever peers announced or answered.
5. **A configured fallback resolver.**

**Resolution knowledge travels along the link graph.** A link names a space and
carries no locator, deliberately — a link outlives any hosting arrangement, and
an embedded address that has rotted is worse than none. It does not need one:
reaching a space that contains a link generally means reaching what it points at,
because the peers you are already talking to are the ones who can say where the
target is.

### 5.4 Sharing

A share link carries the key in the URL fragment, so it never reaches a server:

```
https://<app>/#k=<base32 public key>&n=<suggested name>&l=<locator hint>
```

There is also a short typeable code, derived as a prefix of the hash of the
public key. The code is **a rendezvous hint only** — never identity, never
authority. It is short enough to be guessable, which is precisely why nothing
depends on it: an impostor who claims a code can answer your call, but what they
serve will not verify against the key you actually want.

The two routes therefore have honestly different guarantees. **A link gives full
verification**; **a code gives a hint**. On first successful connection by either
route, the key is pinned against the handle used, and a later mismatch is a
blocking warning rather than a silent substitution — so a typed code is
spoofable at most once, and never for a space already known.

### 5.5 Names are private

There is no global namespace and no registry. Every peer names spaces for
itself; a share link may carry a *suggested* name, which the receiver is free to
accept or replace. Two people can call the same space different things, and two
different spaces can share a name without conflict.

### 5.6 Transport

Peers connect over WebRTC data channels, with a signalling server used only to
introduce them and a relay available when direct connection fails. Both are
infrastructure for *connection*, never for custody: they see encrypted transport
and hold nothing.

A peer may also serve over WebSockets at a stable address. Such a peer is not a
new kind of participant — it speaks the same protocol, holds the same logs and
serves the same blobs as a browser tab. It differs only in **reachability**: it
has a stable address, so it can be dialled directly and can introduce peers to
each other. There is no privileged server role to discipline, because there is no
privileged server role.

That also gives two peers who cannot reach each other directly an option beyond a
blind relay: if both can reach the same always-on peer, they can sync through it
using the ordinary protocol, and it keeps a replica afterwards. A blind relay
carries ciphertext and retains nothing; syncing through a peer means that peer
holds the space. Where the space is encrypted (Section 6), it holds ciphertext
and the distinction largely disappears — which is the case that makes always-on
peers safe to use by default.

### 5.7 The network of spaces

A link is an ordinary attribute value naming a space, optionally an object
within it. Any type may declare a link-valued attribute, so the graph of spaces
is readable by any client that can fold — including one that holds no view.

An object with a link and no content is a portal. An object with both is a card:
a thumbnail that goes somewhere. Links inherit naming, placement and deletion
from whatever object carries them.

Links are one-directional and unlisted. Nobody can enumerate who links to them
without being told, exactly as on the early web.

---

## 6. Privacy and the reading key

Identity is a public key, and it makes a space verifiable. It does not make a
space private: anything a peer can replicate, a peer could read.

Privacy is therefore a separate key. A space may have a **symmetric reading
key**, and where it does, event values and blob contents are encrypted under it.

```
Space key      Ed25519 keypair       identity   · public key names the space
                                                · private key authorises writes
Reading key    symmetric key         privacy    · decrypts values and blobs
                                                · optional; shared out of band
```

The reading key is distributed the same way the space is: **in the fragment of a
share link**, alongside the public key, where it never reaches a server.
Omitting it from a link produces a reference to a space the recipient can
replicate and verify but not read.

### 6.1 What a peer without the reading key can do

Almost everything except read. The substrate never interprets a value
(Section 2), so encryption costs it nothing:

| | Without the reading key |
|---|---|
| Store the log | **yes** |
| Verify signatures and chains | **yes** — signatures are over ciphertext |
| Replicate events to other peers | **yes** |
| Store and serve blobs | **yes** — content-addressed by ciphertext hash |
| Answer resolution queries | **yes** |
| Read any value | **no** |
| Fold into meaningful state | **no** in practice — see below |
| Write | **no** — that needs the private space key, separately |

Folding is the interesting case. The fold is structurally able to run over
ciphertext — it merges opaque values by rules the schema declares, and never
inspects them — so a peer without the reading key can compute *the shape* of the
state: which objects exist, which attributes they carry, which writes won. What
it cannot do is know what any of it means, which makes the exercise pointless in
practice. Such a peer stores and serves; it does not fold.

The consequence is the useful one: **a peer can be a complete, verifying,
useful replica of a space it cannot read.** Storage and readership are separate
concerns, and only the second requires trust.

### 6.2 What this makes possible

- **Always-on peers without custody.** A peer with a stable address can hold and
  serve a space, keeping it alive when everyone else is offline, while holding
  only ciphertext. It is infrastructure without being an audience.
- **Relaying without reading.** Two peers who cannot reach each other directly
  can sync through a third that holds the space. Where that third has no reading
  key, this is a relay that keeps a replica — better than a blind relay, which
  keeps nothing, and no worse in what it learns.
- **Sharing that separates hosting from readership.** Handing someone the space
  key asks them to help keep a space alive. Handing them the reading key too
  invites them in. These are genuinely different acts and the link format makes
  them different.

### 6.3 What it does not do

- **It is not access control.** A reading key cannot be revoked. Anyone who has
  ever held it holds it permanently, and can decrypt anything they have or later
  obtain that was encrypted under it. Restricting access after the fact requires
  a new key and re-encryption, which is a new space in all but name.
- **It does not hide structure.** A peer without the key still sees how many
  events exist, who wrote them, when, how large the blobs are, and how the space
  changes over time. Encrypted values conceal content, not activity.
- **It does not hide identity.** The space's public key is what peers ask for by
  name. Holding an encrypted space is not private in the sense of being secret;
  it is private in the sense of being unreadable.
- **It does not protect against a reader.** Anyone with the reading key can copy
  the plaintext and re-share it. This is true of every system where reading is
  possible, and worth stating because the rest of the design is careful about
  who can do what.

---

## 7. Writers and permission

A space may have many writers. The root declares the **writer set**: the public
keys admitted to the space.

Events signed by a key outside the set are still *replicated* — a peer cannot be
trusted to filter honestly, and refusing to carry them would let any relay
censor silently — but they are **not folded** into state. Validity is therefore a
local, deterministic computation over the log rather than a query to an
authority: two peers holding the same events agree on who may write, because the
answer is in the events.

The space's own key is the root of that authority: the first writer grants are
signed by it, and delegation flows from there.

---

## 8. Applications are spaces

An application is a space of type **code**: a log that folds into a bundle of
executable modules. It is signed, content-addressed, versioned and replicated by
exactly the same machinery as any other space.

A client is correspondingly thin. To open a space it:

1. Replicates the log and verifies the chains.
2. Reads the root's type declaration — a schema and a view reference.
3. Folds the log with the universal fold, using the schema.
4. Resolves the view reference to a code space and replicates it.
5. Runs that view against the folded state.

**Step 3 does not depend on step 4.** A client can hold correct, verified,
compacted state for a space whose view it has never fetched, and can serve that
space to others. An always-on peer needs no application code at all.

Applications therefore distribute over the same network as data — no store, no
CDN, no central registry — and are versioned and signed by construction, because
that is what a space already is.

### 8.1 Why foreign code is tolerable here

A view is code from a stranger, which is normally a serious problem. The layering
makes it a much smaller one.

**What a view structurally cannot do:**

- It cannot change what the log means. The fold ran before the view loaded.
- It cannot make peers disagree. Two clients with the same events compute the
  same state regardless of which view they run, or whether they run one at all.
- It cannot corrupt what is stored, replicated or compacted.
- It needs no ambient authority: it takes folded state in and produces drawing
  out. It does not need the network, the store, or the space's key.

A hostile view can therefore mislead **its own user**, in the ordinary ways
hostile interface code does. It cannot cause disagreement about state, which is
the failure class that would be unrecoverable in a system with no central
authority.

The remaining protections are conventional and effective because the surface is
narrow: code spaces are signed, so trusting an author is a real mechanism;
content addressing means a client can pin exactly the version it ran; and a view
executes against a constrained drawing interface rather than direct access to
the host.

---

## 9. Snapshots and compaction

A log grows without bound. Compaction reduces it, and content addressing is what
makes that safe to share.

A **snapshot** is the hash of the folded state over all events up to a stated
watermark — a version vector naming, per writer, how far the snapshot covers.
Because the fold is deterministic and its output canonically encoded
(Section 3.4), a snapshot needs no signature to be trustworthy: **a peer holding
the same events verifies it by recomputing it.** Disagreement is detectable
rather than silent, and two peers who compact the same log produce byte-identical
snapshots, so snapshots deduplicate like any other content.

Snapshots are stored as ordinary blobs and announced as ordinary events carrying
the watermark and the state hash. They replicate normally, sit in a signed
chain, and cannot be silently inserted.

Per-attribute merge rules make the reduction mechanical: an LWW-register
compacts to one value, a counter to one total per writer, an OR-set to its live
members. Compaction is defined **per merge rule** rather than per application, so
a rule solved once is solved for every type that uses it — and, as with folding,
a peer can compact a space whose view it does not have.

A snapshot is a **cache, never authority**. Events remain the truth; a snapshot
can always be discarded and recomputed from them.

Encryption cuts across this cleanly. Merge rules operate on opaque values, so a
peer holding only ciphertext can still compact — it discards superseded events
without knowing what they said — and the snapshot it produces is ciphertext too,
verifiable by recomputation by anyone holding the same events, readable only by
whoever holds the reading key. What such a peer cannot do is verify a snapshot
someone else made *in plaintext*, which is why snapshots of an encrypted space
are themselves encrypted: the property that makes a snapshot trustworthy is that
peers can agree on its hash, and that requires them to be comparing the same
representation.

---

## 10. Ephemeral state

Presence, cursors, typing indicators and connection gossip are exchanged between
peers on a separate channel and never enter the log. They are not signed history
and not replicated to peers who were not present; they simply expire.

The distinction is durability. If a fact should survive everyone disconnecting,
it is an event. If it describes only who is here right now, it is ephemeral, and
writing it to an append-only log would make every cursor movement permanent.

---

## 11. Summary of constraints

The design holds together only if these hold:

1. **The substrate never interprets a payload.** It moves and verifies bytes.
2. **The fold is universal, pure and deterministic.** One algorithm, driven by
   declarations, byte-identical output across clients.
3. **Every merge rule is a join-semilattice.** Order-independence comes from the
   algebra, not from discipline.
4. **Applications ship views, never folds.** The layer that ships is the layer
   that cannot cause disagreement.
5. **Identity is a key; location is a hint.** Anything that resolves a name is
   advisory, because what it returns is verified against the key.
6. **Storing is not reading.** Verification uses the public key; reading uses a
   separate symmetric key. A peer can be a complete replica of a space it cannot
   read, which is what allows infrastructure to exist without custody.
7. **Events are the truth; everything else is cache.** Snapshots, indexes and
   rendered state are all discardable and recomputable.
