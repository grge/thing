# Resolution, hubs, and gossip — a proposal

**Status: proposal. Nothing here is settled** — including the parts written in
the declarative. Captured from a scoping conversation, 2026-09-02, after v1
steps 1–3 landed, and none of it is built. It exists because the *destination*
constrains what the current code should avoid foreclosing, and because three
cheap changes now save an expensive migration later (§9).

Read the section headings as the strongest claims in the document, not as
decisions: where one says a thing "is" so, that is the proposal's shape rather
than a commitment. The open questions in §10 are the ones that are *obviously*
unresolved; they are not the only ones.

The question it answers: **how does a peer get from a space's identity to
somewhere it can actually connect?** [DESIGN.md](DESIGN.md) §4.2 says a locator
is separate, plural and disposable, and that the signalling layer is "in effect
a resolver interface". This is that interface, worked out.

---

## 1. The shape

Identity resolves to locators; locators are dialled.

```
Identity      space = Ed25519 public key                  never changes
    ↓ resolve
Locator       { ws } | { via, peer }                      many, changing, expiring
    ↓ dial
Transport     WebSocket direct | WebRTC via signalling
```

The prompt for this was noticing that **a link needs no rendezvous of its own.**
A `:link` carries identity only ([DESIGN.md](DESIGN.md) §2.1), and if you can
reach a space that contains a link, you can generally reach what it points at —
because the peers you are already talking to can tell you where the target is.

That is the property worth designing for: **resolution knowledge propagates
along the same edges the link graph does.** Not because a link carries a
locator — it must not, locators are ephemeral and a link outlives them — but
because traversing to a space teaches you peers, and peers answer resolution
questions.

---

## 2. A hub is an ordinary peer

**Decided in shape.** A hub is not a new kind of participant. It is a peer that
happens to be:

- **reliably reachable**, because it holds a stable WebSocket address rather
  than an ephemeral browser session, and
- **able to do WebRTC signalling** for clients that register with it.

Otherwise it speaks the same protocol, holds the same logs, serves the same
blobs, and has no privileged role. This is the same stance as
[NEXT.md](NEXT.md#settled)'s "there is no persistence server": rather than build
a privileged path and then discipline it, never build it. A headless persistence
client and a browser tab differ in **reachability**, not in kind.

The practical consequence: everything below is one protocol, and a hub is where
you *notice* it because a hub is reachable enough to be useful.

---

## 3. Two locator shapes

Both name a server, and optionally a session on it. Flat — a locator is never
expressed in terms of another locator.

| Shape | Means | Dialable by |
|---|---|---|
| `{ ws: <url> }` | Open a socket here. The endpoint *is* the peer. | anyone |
| `{ via: <url>, peer: <session id> }` | Signal through this server, ask for this session. | anyone who can reach `via` |

`via` is **the signalling server the serving peer is registered on** — not the
peer that relayed the knowledge. This matters: it means a locator is
self-contained and survives relaying unchanged. A `{via, peer}` learned
third-hand is exactly as usable as one learned directly, provided you can reach
`via`.

Today's arrangement is already this shape with the server implicit: a v1 writer
is `{ via: <the public PeerJS broker>, peer: "thing-<code>" }`. Making `via`
explicit is most of the migration.

### 3.1 `{via, peer}` is more perishable than `{ws}`

A browser session id does not survive a reload, and PeerJS ids are ephemeral —
the fragility [F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one)
flagged, now with a mechanism that can express it. So:

- a `{via, peer}` locator's TTL should be **short and tied to the session**,
  not a fixed duration picked in advance;
- a peer must **re-announce on reconnect**, because its old locator is dead the
  moment it drops;
- `{ws}` locators can carry a much longer TTL, since the whole point of a hub is
  that its address outlives any particular connection.

**TTL belongs on the locator, set by the announcer.** The announcer knows its
own volatility; a receiver cannot guess it. Without expiry a resolution table
fills with corpses and "resolve" degrades into "try forty dead entries".

---

## 4. Announce on serve

A peer that starts serving a space tells peers it is already connected to:

```
{ code, locator: { via: <hub I am registered on>, peer: <my session>, ttl } }
```

and a hub seeding a space announces its own directly-dialable address:

```
{ code, locator: { ws: <my url>, ttl } }
```

Availability is therefore a **push**, maintained by the same traffic that does
the work — no separate crawl, no polling.

### 4.1 Fanout needs a policy — **open, but the default is obvious**

As stated, "announce to some or all peers" has no damping, and unbounded gossip
is a bad thing to discover in a browser. The cheapest policy that keeps the
shape:

- announce only spaces you **actually serve**;
- only to peers you are **already connected to**;
- only on **connect** and on **change** — no periodic re-flood;
- let **TTL** do the forgetting.

That is closer to BitTorrent's `HAVE` than to a DHT, which is the right register
for a browser and matches what F14 already asked for. Whether anything more is
needed is genuinely open, and should be answered by observing a real network
rather than by design.

---

## 5. The pull side: `RESOLVE`

§4 is the push — a peer volunteering what it serves. That is not enough on its
own: a peer that joins after an announcement has already gone past has no way to
catch up, and a client following a link has a code and no reason to expect
anybody to have mentioned it. So there is a query, and it is the same table read
from the other end.

**Push and pull are one mechanism.** Announcements write the table; `RESOLVE`
reads it. A peer with nothing to serve still participates, because it can still
answer for what it has heard.

Proposed shape:

```
RESOLVE  { code }
       → { code, locators: [ { locator, ttl }, … ] }
       | { code, empty: "unknown" | "none-serving" }
```

- **Asked of any connected peer**, and of several in parallel — no peer is
  authoritative (§11), so a single answer is a hint and several agreeing is
  better evidence.
- **Answers are merged**, not taken from the first responder. Duplicate locators
  collapse; the longest surviving TTL wins, since one peer's stale entry should
  not shorten another's fresh one.
- **The empty case says which kind of empty it is.** That distinction is §10.2,
  and it is the reason the response is a variant rather than a possibly-empty
  list: a client that cannot tell "I have never heard of this" from "I know it
  and nobody is up" cannot decide whether asking elsewhere is worth anything.

Open, and deliberately unanswered here:

- **Whether `RESOLVE` recurses.** If a peer does not know, may it ask its own
  peers and relay the answer? That is §10.1 in its sharpest form, and it is the
  difference between a resolution *table* and a resolution *network*.
- **Whether answering is obligatory.** A peer that answers reveals what it knows
  about, which is a weak form of the membership problem in §10.3.
- **Rate and repetition.** Nothing above stops a client asking constantly, and
  nothing stops a peer being asked by everyone. Needs a cap; the shape of the
  cap is not obvious.

---

## 6. Collating locators

A client turns a code into a *list* of locators, in preference order, from five
sources:

1. **`:seeds` on the target's ROOT** — the writer's own signed statement of
   where its space is served (§6.1). The only durable source.
2. **The link hint** — `&l=` in a share link ([ADDRESSING.md](ADDRESSING.md)
   §5.4). The bootstrap case: the only source that works before you know anyone,
   and before you hold the log that `:seeds` lives in.
3. **Cache** — locators for spaces opened before (§6.2).
4. **Learned** — whatever peers have announced (§4) or answered (§5).
5. **Default resolver** — the client's configured fallback, today the public
   PeerJS broker.

Then dial through the list in order. Which order is right is partly an empirical
question; the obvious first cut is cheapest-and-most-likely first, meaning
`{ws}` before `{via, peer}` and fresher before staler.

Note the ordering paradox in 1 and 2: `:seeds` is the best source and it is
unavailable at first contact, because it lives in a log you do not have yet.
Once you have synced once, it is the source that still works months later when
every announcement has expired and every cached locator is dead.

### 6.1 `:seeds` — the writer says where its space lives

**Proposal, and the least-settled part of this document.**

[F6](FINDINGS.md#f6-root-is-materialised-as-an-object-by-a-total-fold) established
that `ROOT` is materialised as an object by a total fold, so **attributes on
`ROOT` are space-level attributes** — no new concept required, and the same
mechanism [NEXT.md](NEXT.md#open) earmarks for a space's suggested name.

`:seeds` on ROOT would be a list of locators the writer asserts serve this
space. What it gets that no other source does:

- **Durable.** It is in the log, so it survives every TTL expiring and every
  cache being cleared. Someone reopening a space after six months has something
  to try.
- **Signed.** It is the writer's own statement about their own space
  ([DESIGN.md](DESIGN.md) §5), so it cannot be forged by a peer that would like
  to redirect readers elsewhere.
- **Replicated.** It arrives with the log rather than needing a separate
  exchange, and every peer holding the space holds it.

**Two things to be careful about.**

*It is a locator in durable storage*, which §9 says a `:link` must never be. The
distinction: a `:link` embeds a locator for **someone else's** space, which the
linker has no authority over and no way to correct when it rots. `:seeds` is the
writer's statement about **their own** space, and they can update it by writing
another event. That is legitimate — but stale `:seeds` are a real failure mode,
so a client must treat them as the best *hint*, never as authoritative, and must
fall through to the other sources when they fail.

*It publishes a hosting arrangement.* Anyone who can read the space learns where
it is served. That is probably fine and arguably the point — you are telling
people where to find you — but it is a disclosure rather than a neutral fact,
and it should be a deliberate act by the writer rather than something the client
writes automatically on their behalf.

Open: whether `:seeds` holds full locators or only `{ws}` hub addresses. Only
hubs seems right — a `{via, peer}` naming a browser session is stale within
minutes and has no business in a durable log — but that is an argument, not a
decision.

### 6.2 Cached locators are first-tried, first-discarded

Caching is what makes reopening a space fast, and it should be done. But a
cached locator is a **stale** locator by default, so it must be dropped on
failure rather than retried, and it must never be the reason a space is reported
unreachable — that would turn "your cache is old" into "this space is gone".

Worth naming: a cache of *which spaces this browser has opened and where* is a
browsing history. It is local, so not a leak, but it matters on a shared device
and it rhymes with [I13](ISSUES.md#i13-one-blob-store-shared-across-spaces-leaks-existence-between-them--rewrite)'s
complaint that the blob store already leaks existence between spaces.

---

## 7. A hub can relay instead of TURN — but it reads what it relays

Two peers behind carrier-grade NAT cannot reach each other directly, and
[NEXT.md](NEXT.md#settled) settled that v1 assumes a TURN relay for this.

If both peers can reach a hub, there is another move: **the hub seeds the
space.** Both open a WebSocket to it and sync through it using the ordinary
protocol. What that buys:

- no TURN cost and no TURN dependency for that pair;
- a **third replica** of the data, which is exactly the emergent persistence
  [NEXT.md](NEXT.md#settled) wants;
- a relay that is a **participant** rather than a proxy — it can serve the space
  to others afterwards.

### 7.1 The cost, which is not small

**A TURN server cannot read what it relays. A hub reads everything.**

This is the difference between the two, and it is not a detail. WebRTC's DTLS
terminates at the peers, so a TURN server genuinely is a dumb pipe carrying
ciphertext it has no key for. A hub that seeds a space is *a peer*: it holds the
space key, verifies signatures, folds the log, and stores the blobs. Relaying by
participation means reading.

So this is not a free win over TURN. It is a trade between two different goods:

| | TURN | Hub-as-peer |
|---|---|---|
| Relay can read content | no | **yes, entirely** |
| Data survives both peers leaving | no | yes |
| Cost | bandwidth, ongoing | a participant that was wanted anyway |
| Helps when | any two peers | both peers reach the same hub |

Neither dominates. For a space that would be published anyway, the hub is
strictly better. For two people exchanging something private, TURN's blindness
is the entire point, and swapping it for a hub is a downgrade dressed as an
optimisation.

### 7.2 What would make the trade go away

**Per-subtree encryption** ([DESIGN.md](DESIGN.md) §5.3). A hub that holds
ciphertext and cannot decrypt it relays without reading, keeps a replica that is
useless to it, and the trade collapses into a straight win.

That reframes encryption's priority. DESIGN.md §5.3 has it as an eventual answer
to *who may read a space* — access control, wanted in the long run. This gives
it a nearer and more concrete job: **it is the precondition for hub-relaying to
be safe by default**, and the first customer the encryption work has had.

Until it exists, the honest position is that hub-relaying is opt-in per space
and the interface has to say what it means. "Use a hub" and "use TURN" cannot be
presented as two speeds of the same thing.

---

## 8. PeerJS is on the way out, and the hub is what retires it

[ADDRESSING.md](ADDRESSING.md) already assumes "PeerJS is not a long-term
dependency". This document is the point at which that stops being a hedge and
starts being load-bearing, because most of what is above is shaped around
working within PeerJS's constraints rather than because those constraints are
right:

- **[I22](ISSUES.md#i22-one-writer-two-tabs-the-second-cannot-claim-the-rendezvous-slot--limit)**
  — a writer's second tab cannot claim the slot — exists because PeerJS ids are
  a one-claimant namespace.
- **The `-2`/`-3` slot-probing sketch** ([NEXT.md](NEXT.md#open)) is a workaround
  for that same namespace, not a design anyone would choose.
- **§3.1's perishability** is PeerJS session semantics: ids do not survive a
  reload, which is what makes `{via, peer}` locators expire so fast.
- **`{via, peer}` as a shape at all** exists because signalling is somebody
  else's server. A hub signals for itself.

So the honest read is that PeerJS is the wrong tool. But the ordering matters:

**Displace it, do not replace it.** Building a hub adds a WebSocket path
alongside the existing one — new code, not a modification of what works. Once a
hub can signal, PeerJS's only remaining job is bootstrapping strangers who have
no hub in common, which is a much smaller job and might be served by anything.
Swapping brokers *first* and then building the hub would mean doing a transport
migration twice.

Nothing about PeerJS appears to block building a hub, which is what makes this
ordering available. That should be checked rather than assumed before the hub
work starts.

---

## 9. What v1 should avoid foreclosing

None of this is v1 work — it needs metadata relay and peer lists underneath it
(§10), which are not built. But three things in the current code would make it
expensive later, and all three are cheap now:

- **`Locator` is `{transport, address}`** (`src/app/address.ts`), with no room
  for `via`, `ws` or `ttl`. It is a stored and eventually wire-visible shape, so
  widening it to the §3 union is worth doing before anything persists it.
- **`defaultLocator()` returns one locator.** The whole model is a *list* in
  preference order. Returning a single-element list now costs nothing and makes
  the seam right.
- **The share link's `&l=` hint** is reserved in ADDRESSING.md §5.4 and never
  implemented. §5 shows it is not decoration — it is the bootstrap primitive,
  the one source of locators that works before you know anybody.

A note on where hints belong, since the two cases pull opposite ways:

> **A share link should carry a locator hint; a `:link` should not.** A share
> link is a one-shot introduction whose staleness is recoverable by resharing.
> A `:link` is stored data that outlives its target's hosting arrangements, and
> a stale embedded locator there is worse than no locator at all.

---

## 10. Open questions

These are the next set of changes to think about, not this one.

### 10.1 Does a hub answer for spaces it does not serve?

Pure relay of resolution knowledge makes discovery markedly better and makes
hubs a target for pollution. Serve-only is safe and thin but keeps the
resolution graph shallow.

**Instinct: serve-only, plus whatever it learned from directly-connected peers —
one hop, no transit.** Stated as instinct rather than decision because it is
exactly the kind of thing that is hard to walk back once two implementations
exist.

### 10.2 "I don't know" versus "nobody is serving it"

These are different answers and a client that cannot tell them apart cannot
decide whether to ask elsewhere. The resolution response should say which. Cheap
now, expensive once there is a second implementation — the same class of
decision as [ADDRESSING.md](ADDRESSING.md) §6's note on canonical bytes.

### 10.3 Whether and how peer lists are shared

The unresolved half of [F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one),
and the thing §4's announce mechanism quietly assumes. F14's objection stands:
peer ids become **de-facto membership with no way to leave**, which makes
[I7](ISSUES.md#i7-share-codes-cannot-be-revoked-or-rotated--rewrite) worse
rather than better.

Two things have changed since F14, and they pull in opposite directions:

- [NEXT.md](NEXT.md#settled) settled that **peer list sharing is product, not
  optimisation**, and consciously accepted the uncontrollability cost.
- Signing now exists, which was F14's precondition for revisiting this.

F14's cheaper middle is still the most attractive concrete shape: announce peers
*currently connected* — no persistence, no roster, just "these are alive now" —
so readers can mesh while a writer is up and those connections outlive its
departure. Combined with §3.1's TTL, "currently" becomes expressible rather than
implied.

Open: whether opting in is explicit, and whether a peer can meaningfully opt
out. [NEXT.md](NEXT.md#open)'s slot-probing sketch (`thing-<code>-2`, `-3`, …)
is one answer where **opting in is claiming a slot** — and it is also the fix
for [I22](ISSUES.md#i22-one-writer-two-tabs-the-second-cannot-claim-the-rendezvous-slot--limit),
so the two should be decided together.

### 10.4 Is there a gossip layer, and what does it carry?

The sharpest version: **which objects within a space are held by which peers?**

Resolution (§1–§6) answers *where is this space*. That is space-granular. But
[F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one)
established that a version vector describes **events, never blobs**, so two
peers with identical VVs may hold completely different blob sets — and `WANT`
has no routing, because a peer cannot know whom to ask. `HAVE` is the
object-granular answer to the same shape of question.

So there are plausibly two gossip layers with the same mechanics at different
granularity:

| | Question | Granularity | Where it lives |
|---|---|---|---|
| Resolution | where is space K? | space | §1–§6 |
| `HAVE` | who holds blob H? | object | F14's item 2 |

Open: whether they are genuinely one mechanism with a parameter, or two things
that merely rhyme. Worth resisting a premature merge — they have different
cardinalities (a handful of spaces, potentially thousands of blobs), which
usually means different encodings, a list versus a Bloom filter.

Also open, and noted in [NEXT.md](NEXT.md#what-becomes-load-bearing): once blob
availability is answerable, **"is this space alive?" stops being binary.**
Metadata can be complete while specific blobs are permanently gone. *"This space
is mostly here, and these three files are probably gone"* is a new state, and it
is the honest face of a properly distributed system.

---

## 11. Difficulties worth naming

**Resolvers can lie.** A peer can point you at an impostor, or claim not to know
a space it does. The first is already handled — signatures mean a wrong answer
fails verification ([DESIGN.md](DESIGN.md) §5) — and it is a good demonstration
of why signing came first. The second is **not detectable at all**, which is why
resolvers must be treated as hints rather than authorities, and why asking
several matters.

**"Ask everyone" does not scale.** Fine at ten resolvers, bad at a thousand.
Needs an ordering (§5) and a cap. Not hard, but real work rather than a
footnote.

**Bootstrap is unchanged by any of this.** None of it helps the very first
contact with a stranger's space. You still need one locator from outside the
system, and that is the share link — which is the argument for §9's `&l=`.
