# Design

**Status: current. The standing description of what this system is.**

This is the design document — the place where the load-bearing decisions live:
the data model and the fold, addressing and identity, transport, and crypto. It
supersedes [v0/SPEC.md](v0/SPEC.md), which is archived as the record of what the
proof of concept was.

**What it is not.** Not a build plan — that is [V1.md](V1.md). Not a work list —
that is [ISSUES.md](ISSUES.md). Not evidence — that is
[FINDINGS.md](FINDINGS.md), which is append-only and where numbers go.

**How decided things are.** Each section is marked:

| | Meaning |
|---|---|
| **Built** | Implemented and working in the current codebase. |
| **Decided** | Settled on paper, not yet built. The reasoning is closed; the code is not written. |
| **Open** | Genuinely undecided. Named here so it is not mistaken for settled. |

Where a decision was made elsewhere, this document states it and links rather
than restating the argument. [NEXT.md](NEXT.md) holds the product reasoning and
[ADDRESSING.md](ADDRESSING.md) the addressing argument in full.

---

## 0. What this is

A namespaced, append-only event log replicated between browser peers over
WebRTC, folded into a filesystem.

The floor, which must always work, and against which any other idea loses
([NEXT.md](NEXT.md#what-the-product-is)):

> **A website you go to, where you create a space, share it with peers via a
> link, and drag files into it.**

The fuller ambition is a fast, in-browser, Napster-shaped peer-to-peer network,
with discovery and eventually collaborative editing. The tension in that
comparison is recorded honestly in NEXT.md: Napster's defining feature was a
*central index*, and browser-only discovery is the problem this project has least
answer for.

---

## 1. Core model — **Built**

Unchanged from v0 and not expected to change. This is the part that survived
contact with a real implementation, and §1.3 is why.

### 1.1 Objects

Every object has a **UUID**, assigned at creation and never reused. The UUID is
the only identity; paths are *derived*, never stored.

An object's state is a set of **attributes**, each independently resolved. Two
writers touching different attributes of the same object do not conflict.

### 1.2 Events

An event is a single assertion: *this attribute of this object now has this
value.* Events are never mutated or deleted.

### 1.3 Commutativity

The log is a **set**, not a sequence. Any peer that has applied the same set of
events holds the same state, regardless of arrival order.

This is the load-bearing property. It makes sync a set-reconciliation problem
rather than a consensus problem, and it lets an offline peer reconnect without
replaying history in order. Ordering *within* a writer comes from hash chaining
(§3); there is no ordering between writers and none is needed.

Enforced by a shuffle test (`src/fold/fold.test.ts`) covering delete/undelete
races, absent blobs, unknown parents, and multi-object cycles. It is the single
most valuable test in the project.

### 1.4 The fold

State is a **total fold** over the event set: per-`(target, attr)` last-writer-
wins by `(lamport, writer)`. Totality matters — every event set folds to
*something*, including sets with dangling parents or cycles. Cycle-breaking
(smallest UUID in each cycle re-parented to `ROOT`) is fold-local state, never an
event.

`ROOT` is materialised as an object by that fold
([FINDINGS F6](FINDINGS.md#f6-root-is-materialised-as-an-object-by-a-total-fold)),
which means **attributes on `ROOT` are space-level attributes** — no separate
concept of space metadata is needed. That is where a space's suggested name
lives, and where a fork records what it forked from.

---

## 2. Attributes — **Built**, extended in v1

Full v0 semantics are in [v0/SPEC.md](v0/SPEC.md) §4 and remain accurate for
everything below except `:link`.

| Attribute | Type | Notes |
|---|---|---|
| `:parent` | `Uuid \| ROOT` | Cycles broken in the fold, not the log |
| `:name` | `string` | Sibling collisions are legal and rendered as-is |
| `:content` | `Hash \| null` | Full 32-byte SHA-256 of the plaintext blob |
| `:pos` | `(i32, i32)` | Fixed point; no floats in hashed positions |
| `:deleted` | `bool` | Computed over the whole event set, never incrementally |
| `:kind` | `"file" \| "dir"` | **Advisory** — a `dir` with content is legal |
| `:type` | `string \| null` | Replicated format hint |
| `:link` | `{ space, object? }` | **Decided, not built** — see below |

### 2.1 `:link` — **Built**

A link is **an attribute any object may carry**, not a special object type and
not a sidecar. Decided in [NEXT.md](NEXT.md#open); the short version:

- An object with `:link` and no `:content` is a portal.
- An object with **both** is a card — a thumbnail that goes somewhere, which is
  what a good index entry looks like.
- It inherits naming, parenting, `:pos`, tombstones and cross-space moves for
  free, and degrades gracefully in a client that does not implement it.

Value is `{ space: <pubkey>, object?: <uuid> }` — **identity only, no locator
hints**, since locators are ephemeral and resolving them is the resolver's job
(§4.2).

It lives in metadata rather than blob content because blobs are fetched lazily:
a link determines what you might want next, so it is scope-determining, and
[F13](FINDINGS.md#f13-selective-sync-breaks-what-identifies-a-snapshot)'s rule
applies — whatever determines scope must itself always be replicated in full.

**Deep links are in, with the object optional — settled.** They are natural
given stable UUIDs and break only across cross-space moves, which mint fresh
UUIDs ([I12](ISSUES.md#i12-cross-space-move-is-a-copy-and-delete-not-a-move--limit)).
That leaves a dangling link, which the UI shows honestly — following it lands in
the right space with nothing selected — rather than a reason to forbid the
shape. Restricting later is easier than adding.

**`:link` is a live-attr event** (§4.5), unlike `:kind` and `:type`. Setting a
link is authoring — it is what the object is *for* — so it revives a tombstoned
object exactly as writing `:content` does, and for the same reason: a
resurrected object is recoverable by re-deleting, whereas an authored link
vanishing behind a tombstone looks like data loss.

**How it is built.** The encoding uses a presence byte for the optional object
rather than a length prefix — two shapes, both fixed-size, and a second
implementation must reproduce it byte for byte (ADDRESSING.md §6); an all-zero
UUID therefore cannot encode as no UUID. In the UI a link is a badge in the
tree, and the preview shows the target's *code* (never the key) with an Open
button. Following a link takes the verified path — the key is known before
contact — and carries the linking object's name across as the petname for a
space this device has never met.

**Backlinks are impossible.** Nobody can know who links to them without being
told, exactly as on the pre-webmention web. That constrains how networked the
thing can feel, and it is a property rather than a gap.

---

## 3. Event envelope and log structure — **Built**, signed as of v1 step 1

The envelope is the piece least likely to survive a change cheaply; everything
else reads it. v1 changed it **once**, for signing — done, and the reason
signing was step 1 rather than a retrofit ([V1.md](V1.md#the-sequence)).

```
Event {
  writer:  WriterId       // 32-byte Ed25519 public key — see §4.1, §5
  seq:     u32            // per-writer, starts at 0, strictly +1
  prev:    Hash | null    // hash of this writer's event seq-1; null iff seq == 0
  lamport: u64            // see below
  target:  Uuid           // the object being asserted about
  attr:    AttrName
  value:   Value
  wall:    u64            // ms since epoch, DISPLAY ONLY — never resolves anything
  sig:     Signature      // 64 bytes, not part of its own preimage — see §5
}
```

There is **no `space` field**. Spaces are keyed externally by the storage and
transport layers, and `space` is carried once in the handshake rather than on
every event.

**Canonical encoding.** Two peers must produce byte-identical encodings or
hashing and dedup break: fixed field order, length-prefixed values, no maps, no
floats in hashed positions.

**Lamport clocks.** `counter += 1` on create; `counter = max(counter, incoming)`
on receive. Ties break on `writer` bytes. The comparison key throughout is
`(lamport, writer)`, and it is a total order *only because* a writer's own
lamports are strictly increasing — an obligation on the event creator. Nothing
on the wire enforced it in v0; signing (§5) is what makes an inflated clock fail
verification rather than win.

**Per-writer hash chains** give ordering within a writer. **Version vectors**
(writer → highest *contiguous* seq held) drive sync; a peer holding 0–47 and 49
reports 47. Out-of-order arrival within a writer goes to a hold-aside buffer.

Known-insufficient today and tracked:
[I11](ISSUES.md#i11-version-vectors-cannot-express-i-hold-this-event-but-not-its-predecessor--rewrite)
(version vectors cannot express a held-but-not-contiguous event) and
[I10](ISSUES.md#i10-a-permanently-missing-event-stalls-a-writers-chain-forever--rewrite)
(a permanently missing event stalls a chain forever).

---

## 4. Addressing and identity — **Built**

The full argument is [ADDRESSING.md](ADDRESSING.md). What is settled:

v0 fused three things into one 8-character string — a space's *identity*, its
*storage keyspace*, and its *network location* (`peerIdForCode()` is literally
`` `thing-${code}` ``). That fusion is fine for one writer in a star topology and
breaks under a mesh, forks, and links. The three layers separate:

| Layer | Is | Changes |
|---|---|---|
| Identity | an Ed25519 public key | never |
| Location | who claims to serve this right now | constantly |
| Human handle | a petname, per-person | per-person |

### 4.1 A space is a keypair

`space_id` **is an Ed25519 public key**; the private key is what makes someone
the writer. With one writer per space, the space key and the writer key are the
same key. Consequences, all of which fall out at once:

- **"Mode 2 is read-only" becomes arithmetic rather than convention** — you
  simply do not have the private key.
- **A fork is honestly a different space**, signed by a different key, with no
  collision and no ambiguity.
- **Links become verifiable**, which is what makes §2.1 worth building.

When multi-writer eventually arrives, the space key becomes an authority that
delegates to writer keys. Not built now; the shape does not have to change.

### 4.2 Locators are separate, plural, disposable

```
Locator = { transport: "peerjs" | "websocket" | …, address: string }
```

Nothing about a locator is part of identity. A space has zero or many at any
moment. The signalling layer becomes a **resolver**: *given a space key, produce
candidate locators.* Swapping PeerJS out changes which locator kinds exist and
nothing else — no address anyone has ever shared breaks.

[RESOLUTION.md](RESOLUTION.md) works this interface out: two flat locator shapes
(`{ws}` for a directly-dialable hub, `{via, peer}` for a browser reachable
through a signalling server), announce-on-serve with TTL, and how a client
collates a *list* of candidates. It also records the reason links need no
rendezvous of their own — resolution knowledge propagates along the same edges
the link graph does — and three things the current code should widen before
anything persists a locator (§7 there). Proposal, not built.

### 4.3 The short code survives, demoted

The 8-character code stays, same alphabet and typeability, but is **only a
rendezvous hint** — never identity, never authority. Derived by default as
`base32(sha256(pubkey))[0..8]`.

This dissolves squatting: an impostor claiming the slot can answer you, but what
they serve will not verify against the key in your link. Note the code is
grindable at ~40 bits, which is exactly why it carries no authority.

### 4.4 The link, and trust on first use

```
https://<app>/#k=<base32 pubkey>&n=<suggested name>&l=<optional locator hints>
```

The key goes in the **fragment**, so it never reaches a server log. Two ways in,
with honestly different guarantees: **opening a link** gives full verification;
**typing a code** gives a hint only. On first successful join by either route the
key is **pinned** against the handle used, and a later mismatch is a loud,
blocking warning.

### 4.5 How it is built

`src/app/address.ts` holds identity, the derived code, locators and the link
format; `src/app/pins.ts` holds trust on first use. They are separate from
`storage.ts` on purpose — v0 kept them together because they were the same
string.

- A **writer** space's id is its public key, minted at creation (`mintSpaceKey`)
  so the id can *be* the key rather than name one. A **local** space keeps a
  UUID and never burns a keypair, since it has no identity to prove.
- A writer space whose stored key is missing **opens read-only rather than
  minting a replacement** — a fresh key would be a different space wearing the
  old one's name. This is the key-loss case (§5.4) in the one place it is
  detectable.
- The pin is checked where remote events are applied, so it gates what enters
  the log rather than only what the UI displays. A mismatch rejects the batch.
- **The handshake compares identities, never locators.** A space announces its
  key on `HELLO`; a space joined by typed code announces **nothing**, because its
  record id is the code — a locator standing in as a storage key until the real
  identity arrives with the first signed events. Announcing the code instead
  guarantees a mismatch against the writer's key, which broke join-by-code
  outright until it was caught.
- **The UI shows the code, never the key.** The key is the identity and is 64
  hex characters — unreadable, untypeable, and it overflows the pane. The code
  is derived on demand rather than stored, so it cannot drift from the identity
  it points at. Joining previews the two input kinds differently, because a link
  is verifiable before contact and a typed code is not (§4.4).

### 4.6 Names are petnames

Zooko's triangle says pick two of human-meaningful, decentralised, securely
unique. The escape is a petname system: self-certifying id underneath, a name the
space *suggests* (an attribute on `ROOT`, §1.4), and a local nickname each reader
can override.

---

## 5. Crypto — **Built**

Signing was deferred in v0 ([I5](ISSUES.md#i5-lamport-clocks-are-unenforceable-so-a-malicious-peer-wins-every-conflict--fixed-in-v1),
[I6](ISSUES.md#i6-hello-is-unauthenticated-any-peer-can-claim-any-writer-id--fixed-in-v1))
and returns as v1 step 1.

**Why it came back.** Giving up control makes signing *more* valuable, not less
([NEXT.md](NEXT.md#why-signing-came-back)). Anyone can copy a space and re-share
it; forks are legitimate. Without signing, nobody can tell a fork from the
original, and whoever copies the content can claim the address while the creator
has no way to correct the record. In a system where anyone can copy, the scarce
thing worth protecting is not access to a space but the **identity** of one.

**Signing's job is provenance, not permissions.** No membership, no revocation,
no key-management UX for access control. Just: this space is who it says it is,
this fork is honestly a different thing, this link points somewhere verifiable.

**What it fixes.** Every event is signed and verified on receipt, so a malicious
peer can no longer win conflicts by inflating a Lamport clock (I5) or claim
another writer's id in the handshake (I6).

**Keys are extractable**, decided in [ADDRESSING.md](ADDRESSING.md) — the user
must be able to export and move an identity, which non-extractable WebCrypto keys
would prevent.

### 5.1 `WriterId` is the full public key — **settled**

**32 bytes, the Ed25519 public key itself**, not a hash of one.

The alternative was a truncated hash, keeping the v0 width. It was rejected
because the saving is illusory and the cost is architectural. You cannot verify
a signature against a digest, so the full key would have to travel by some other
route — a new protocol message, a new "held but unverifiable" state, a new
ordering constraint of key-before-events. That is real distributed-systems
machinery bought in exchange for 16 bytes per event, on an envelope that is
already carrying a 64-byte signature. A hash would also re-break the §4.1
collapse, leaving two identifiers for one principal.

Truncation was not free on its own terms either:
[I14](ISSUES.md#i14-truncated-16-byte-hashes-are-not-adversary-resistant--rewrite)
flags 16-byte hashes as not adversary-resistant, and a writer id is a
second-preimage target with an attacker who wants to impersonate a *specific*
writer — a different threat from the dedup collisions v0's truncation argument
was about.

### 5.2 How it is built

- **Ed25519**, with two interchangeable backends chosen once at runtime:
  WebCrypto where available, [@noble/ed25519](https://github.com/paulmillr/noble-ed25519)
  otherwise. Safari's Ed25519 support arrived late enough that the fallback is
  not optional. The two are byte-identical in both directions — the same seed
  over the same message yields the same signature, and each verifies the
  other's — which is what makes picking at runtime safe, and is asserted in
  `sign.test.ts` rather than assumed.
- **The signature is not part of its own preimage.** `encodeEvent` covers the
  envelope through `wall`; `sig` travels beside it. So `EventId` still hashes
  the same preimage it always did, and an event's identity does not depend on
  its signature bytes.
- **Verification happens at the wire boundary**, in `peer.ts` on `EVENTS`,
  before an event reaches the hold-aside buffer. An unverified event is treated
  as one we do not have: dropped, never buffered, never folded.
- **The private key is stored as a raw 32-byte seed**, not a `CryptoKey`.
  WebCrypto will not export an Ed25519 private key as `raw` (only `pkcs8` or
  `jwk`), so owning the seed keeps one storage format across both backends and
  keeps the key genuinely extractable.
- **`PROTOCOL_VERSION` is 2.** A v1 peer and a v0 peer share no readable
  envelope; the handshake rejects the mismatch, and a pre-signing local log is
  ignored with a message that says so rather than reported as corrupt.

### 5.3 Encryption — **Open**

Wanted eventually: publishing a space should not imply it is public to all. But
where readers can copy and re-share, access control governs **admission, never
retention**. In a mesh, any peer is an enforcement point and a naive one serves
anyone — so authorisation cannot be policy, it has to be cryptographic, which
lands on per-subtree encryption.

Stated plainly so it is not promised as more than it is: **encryption gates who
can read; nothing gates who can retain.**

### 5.4 Key loss — **Open, and the biggest risk here**

If identity is a keypair in browser storage, clearing site data permanently
destroys the ability to write to your own space, with no recovery and no way to
tell readers. Safari evicts storage for sites without recent interaction in
roughly a week, making this routine rather than an edge case. SSB and Nostr both
show key loss is where ordinary users fall off.

Any design that makes identity a key needs an answer: export, escrow,
multi-device, or an explicit "identities are cheap and disposable" stance. **None
is chosen yet.**

---

## 6. Blobs — **Built**

Metadata and blobs travel by different paths: **events replicate to every peer,
blobs are fetched on demand.**

- Content-addressed by full SHA-256 of the plaintext.
- Chunked at 16 KiB, sized against the SCTP message limit. Untuned — chosen, not
  measured.
- Backpressure via `bufferedAmount` watermarks; whole-blob integrity verified by
  hashing the reassembly before accepting; resume by re-requesting from a chunk
  index.
- One store shared across spaces, content-addressed so it dedups — which leaks
  existence between spaces ([I13](ISSUES.md#i13-one-blob-store-shared-across-spaces-leaks-existence-between-them--rewrite)).

**The blob/log boundary is no longer scheduled to change.** v0's §6.1
materialization policy argued from size, and
[F12](FINDINGS.md#f12-61-argues-from-size-and-the-size-argument-expires) showed
that argument expires under mode 3 — but [NEXT.md](NEXT.md#settled) settles mode
3 out, which drops the log/blob dichotomy, snapshots and compaction back to
optional. See [V1.md](V1.md).

**`HAVE` — blob availability — becomes required.** A version vector describes
*events*, never *blobs*. In a mesh where the writer may be gone forever, "who
holds this file" is otherwise unanswerable. Direct prior art: BitTorrent's
bitfields.

---

## 7. Transport — **Built**, with TURN

WebRTC data channels via PeerJS for signalling. Requires a secure context —
Firefox will not gather usable ICE candidates over plain `http://` including a
LAN IP ([F1](FINDINGS.md#f1-firefox-needs-a-secure-context-to-gather-usable-ice-candidates)).

**TURN is in, and built.** v0 deliberately configured STUN and no TURN so POC
question 1 could measure how often peers fail without a relay. That measurement
was taken informally — phones mostly fail, consistent with carrier-grade NAT —
and [NEXT.md](NEXT.md#settled) settles that the next round **assumes a relay
rather than measuring its absence.**

The relay is coturn with HMAC ephemeral credentials (`turn/`), fetched from a
credential endpoint, with TURN settings stored per-device rather than baked into
the build.

> **The formal Q1 number was never collected and is not going to be.** v0/PLAN.md
> stages 4 and 5 ask for a peer-pair failure rate across real networks. It stands
> unmeasured, and settling TURN in retires the question rather than deferring it.
> Recorded here so the gap is not mistaken for outstanding work.

**PeerJS is not a long-term dependency, and WebRTC may not be the long-term
connection type.** Both are assumed replaceable in [ADDRESSING.md](ADDRESSING.md),
which is why §4.2 keeps locators out of identity. Distributed peer-to-peer
remains the default.

---

## 8. Topology and roles — **Decided**

**There is no persistence server.** Persistence is not a capability to build; it
is an emergent role of any peer that stays online. Rather than build a privileged
path and then discipline it, never build it. The short-term implementation is
*keep a browser tab open somewhere*.

**Mesh, not star.** v0's star topology makes the writer a single point of failure
([I9](ISSUES.md#i9-star-topology-makes-the-writer-a-single-point-of-failure--rewrite)).
Three things become load-bearing
([F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one),
restated in [NEXT.md](NEXT.md#what-becomes-load-bearing)):

1. **Metadata relay** — required, or a reader cannot get events from any peer
   that is not the writer.
2. **Blob availability (`HAVE`)** — no longer an optimisation (§6).
3. **Peer list sharing** — product, not optimisation.

**A consequence worth designing for: "is this space alive?" stops being binary.**
Metadata can be complete while specific blobs are permanently gone because the
only peer holding them left for good. v0's `stale` and `unavailable` states
assume one writer whose absence explains everything. *"This space is mostly here,
and these three files are probably gone"* is a new state, and it is the honest
face of a properly distributed system.

**Peer list opt-in — Open.** The cheap shape with no roster and no identity: a
peer willing to serve claims `thing-<code>-2`, `-3`, …; a joiner probes the
pattern until someone answers. Opting in *is* claiming a slot. Degrades honestly,
makes squatting possible, which at this scale is itself worth observing. It is
also the fix for [I22](ISSUES.md#i22-one-writer-two-tabs-the-second-cannot-claim-the-rendezvous-slot--limit),
so the two should be decided together
([RESOLUTION.md](RESOLUTION.md#83-whether-and-how-peer-lists-are-shared)).

**Whether there is a gossip layer, and what it carries — Open.** Resolution is
space-granular (*where is space K?*); `HAVE` is object-granular (*who holds blob
H?*). Whether those are one mechanism with a parameter or two that merely rhyme
is [RESOLUTION.md](RESOLUTION.md#84-is-there-a-gossip-layer-and-what-does-it-carry)'s
last open question, and the next thing worth deciding.

---

## 9. Social model — **Decided in shape, not in detail**

**A shared space is out of its creator's control, permanently.** Once shared, the
creator cannot kill it, cannot enumerate where it went, and cannot prevent it
being copied and re-shared under a new identity. This is a design property, not a
defect — it is already true in v0, where a reader can copy contents into a new
space.

**Ending: no remote detonator.** You can delete your own copy; that is all. The
only honest form of "this is over" is a **final signed statement** the creator
publishes, which honest clients render and dishonest ones ignore. A statement,
never enforcement. It pairs naturally with supersession ("moved to X").

**Reciprocity leans toward interlinked spaces, not shared writing.** Your reply
lives in *your* space, signed by *your* key, linking to mine; neither can edit the
other. This is the webmention shape rather than the Google Docs shape, and it buys
a social model with **no CRDTs and no compaction**. Single-writer-per-space stops
being a limitation and becomes the unit of authorship.

---

## 10. Deferred, with reasons

**Mode 3 — concurrent writers and CRDTs.** Out, and this is the decision that
keeps v1 small. Mode 3 breaks §6.1's size argument, forces a second
selective-fetch mechanism, and requires compaction — which needs snapshots whose
identity [F13](FINDINGS.md#f13-selective-sync-breaks-what-identifies-a-snapshot)
shows is not well-defined under selective sync. Deferred, not denied:
[NEXT.md](NEXT.md#where-this-is-going-crdts-and-compaction) records what survives
(the envelope, the hash chains, the version vectors, §1.3) and what breaks.

**Compaction and snapshots.** Follow mode 3. Logs currently grow without bound
([I8](ISSUES.md#i8-no-compaction-so-logs-grow-without-bound--rewrite)).

**Discovery beyond links.** Without a DHT — impractical in a browser — discovery
rides on the signalling server or on links handed over out of band. This is the
thinnest part of the ambition and the one most likely to decide whether
"Napster-shaped" is reachable.

**Other clients, folder backing, a Python API.** Directions this design *opens*
rather than parts of it. Deliberately after the throwaway experiments — nobody
casually rewrites a protocol with three clients.

---

## 11. Risks

**Key loss is catastrophic and browser storage is fragile** (§5.4). The single
largest unanswered question in this design.

**Discovery may stay thin** (§10). The "network" feeling depends almost entirely
on links doing that work, which raises the stakes on §2.1.

**Availability is what it will be judged on.** "Keep a tab open" is fine for an
experiment, but the felt experience of a space going dark is *"my stuff
disappeared"* — the usual reason peer-to-peer systems lose to hosted ones.

**The distinctive bet.** Every close analogue either runs a persistent local
daemon (SSB, hypercore, IPFS) or gives up peer-to-peer for relays (Nostr). This
project attempts browser-only *and* peer-to-peer, the quadrant nobody has
convincingly occupied. That is either the interesting part or the reason it will
stay hard — worth being conscious of which.
