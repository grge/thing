# Resolution, hubs, and gossip — a proposal

**Status: proposal, for decision.** Captured from a scoping conversation,
2026-09-02, after v1 steps 1–3 landed. Nothing here is built. It exists because
the *destination* constrains what the current code should avoid foreclosing, and
because three cheap changes now save an expensive migration later (§7).

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

## 5. Collating locators

A client turns a code into a *list* of locators, in preference order, from four
sources:

1. **The link hint** — `&l=` in a share link ([ADDRESSING.md](ADDRESSING.md)
   §5.4). The bootstrap case: the only source that works before you know anyone.
2. **Cache** — locators for spaces opened before.
3. **Learned** — whatever peers have announced (§4).
4. **Default resolver** — the client's configured fallback, today the public
   PeerJS broker.

Then dial through the list in order. Which order is right is partly an empirical
question; the obvious first cut is cheapest-and-most-likely first, meaning
`{ws}` before `{via, peer}` and fresher before staler.

### 5.1 Cached locators are first-tried, first-discarded

Caching is what makes reopening a space fast, and it should be done. But a
cached locator is a **stale** locator by default, so it must be dropped on
failure rather than retried, and it must never be the reason a space is reported
unreachable — that would turn "your cache is old" into "this space is gone".

Worth naming: a cache of *which spaces this browser has opened and where* is a
browsing history. It is local, so not a leak, but it matters on a shared device
and it rhymes with [I13](ISSUES.md#i13-one-blob-store-shared-across-spaces-leaks-existence-between-them--rewrite)'s
complaint that the blob store already leaks existence between spaces.

---

## 6. A hub can relay instead of TURN

**The most valuable idea here, and it removes a dependency rather than adding a
feature.**

Two peers behind carrier-grade NAT cannot reach each other directly, and
[NEXT.md](NEXT.md#settled) settled that v1 assumes a TURN relay for this. TURN
is a dumb pipe: it costs bandwidth, and it proxies bytes it cannot read and does
not keep.

But if both peers can reach a hub, there is a better move: **the hub seeds the
space.** Both peers open a WebSocket to it and sync through it using the
ordinary protocol. What you get instead of a relay:

- no TURN cost and no TURN dependency for that pair;
- a **third replica** of the data, which is exactly the emergent persistence
  [NEXT.md](NEXT.md#settled) wants;
- a relay that is a **participant** rather than a proxy — it can serve the space
  to others afterwards.

This does not remove TURN entirely: it helps only where a mutually-reachable hub
exists, and the direct WebRTC path stays preferable when it works. But it turns
the fallback from an infrastructure cost into more of the thing the system is
already for.

---

## 7. What v1 should avoid foreclosing

None of this is v1 work — it needs metadata relay and peer lists underneath it
(§8), which are not built. But three things in the current code would make it
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

## 8. Open questions

These are the next set of changes to think about, not this one.

### 8.1 Does a hub answer for spaces it does not serve?

Pure relay of resolution knowledge makes discovery markedly better and makes
hubs a target for pollution. Serve-only is safe and thin but keeps the
resolution graph shallow.

**Instinct: serve-only, plus whatever it learned from directly-connected peers —
one hop, no transit.** Stated as instinct rather than decision because it is
exactly the kind of thing that is hard to walk back once two implementations
exist.

### 8.2 "I don't know" versus "nobody is serving it"

These are different answers and a client that cannot tell them apart cannot
decide whether to ask elsewhere. The resolution response should say which. Cheap
now, expensive once there is a second implementation — the same class of
decision as [ADDRESSING.md](ADDRESSING.md) §6's note on canonical bytes.

### 8.3 Whether and how peer lists are shared

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

### 8.4 Is there a gossip layer, and what does it carry?

The sharpest version: **which objects within a space are held by which peers?**

Resolution (§1–§5) answers *where is this space*. That is space-granular. But
[F14](FINDINGS.md#f14-peer-meshing-in-mode-2--three-separable-things-not-one)
established that a version vector describes **events, never blobs**, so two
peers with identical VVs may hold completely different blob sets — and `WANT`
has no routing, because a peer cannot know whom to ask. `HAVE` is the
object-granular answer to the same shape of question.

So there are plausibly two gossip layers with the same mechanics at different
granularity:

| | Question | Granularity | Where it lives |
|---|---|---|---|
| Resolution | where is space K? | space | §1–§5 |
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

## 9. Difficulties worth naming

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
system, and that is the share link — which is the argument for §7's `&l=`.
