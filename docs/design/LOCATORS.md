# Finding a space

**Status: analysis, settling an open question.** It works through the scenarios
in which a client needs to know where a space is, crosses them against every
mechanism proposed, and arrives at which are needed.

It **corrects `MAIN-SPACE.md`**, which had `:at` on a link as the primary
locator store. §5.3 had already considered and rejected that, with an argument
the design conversation had not reached; the cross-check below supports §5.3.

**It has since corrected §5.3 in turn.** This document originally kept
`:serves`, a signed locator list on a space's root, which §5.3 ranked the best
source of all. It is dropped — see "What is dropped" — because the peer that
knows a serving address usually cannot write the root, and because reachability
is a property of a pair of peers rather than of a space. **No locator is stored
in any space now.** The scenario tables below predate that and are marked.

---

## The scenarios

**First contact**

1. A share link, and its hint works.
2. A share link whose **hint is dead** — the sender's server moved, or it is a
   LAN address that means nothing to you, or the link is a month old.
3. A share link with no hint: a typed code, a QR, a key read aloud.
4. Following a hub's link to a space you have never opened, **and the hub serves
   it**.
5. Following a hub's link **which the hub does not serve** — it curated the
   link, it does not host the space.
6. Someone hands you a raw key with no context at all.

**Return visits**

7. A space you kept; the address you used last time still works.
8. A space you kept; the address is dead because **the space moved**.
9. A space you kept; the address is dead because **the space is offline**. You
   cannot tell 8 and 9 apart from a failed dial.
10. An open tab, working, whose connection drops mid-session.
11. You have been offline a month. Everything you knew is stale.

**More than one address**

12. Served from a home server *and* a laptop.
13. Reachable at a LAN address for you and a public one for everyone else.
14. Served by you *and* by a hub.

**Failure, and peers behaving badly**

15. The space is genuinely gone. Nobody serves it.
16. A peer answers with a wrong or hostile locator.
17. A peer floods answers, crowding out the real entry.
18. Two peers give different addresses and both are live and correct.

**Structural**

19. **A server's own main space**, which is nobody's link anywhere.
20. Your own space, syncing between your devices.
21. A space you hold and never connect to — an archival replica.

## The mechanisms

| | lives in | authored by | reaches |
| --- | --- | --- | --- |
| **share-link hint** | a URL fragment | whoever shares | one recipient, one moment |
| ~~**`:serves` on a root**~~ | the target's own space | that space's writers | everyone holding its log |
| ~~**`:at` on a link**~~ | your space | the link's curator | everyone holding *your* space |
| **client-side cache** | outside any space | you | you |
| **announce** (push) | ephemeral (§10) | a peer that serves | its current connections |
| **query** (pull) | ephemeral (§10) | asked peers | one hop |
| **fallback resolver** | configuration | an operator | whoever configures it |

## Crossing them

**The two struck-through rows are what this document went on to drop** — `:at`
in "The correction", `:serves` in "What is dropped". The tables below are the
analysis that led there and are kept as written: the crossing is what showed
`:at` covered one scenario alone, and the same exercise is what made the case
for `:serves` look stronger than it was. Read them as the working, not the
conclusion.

| scenario | covered by |
| --- | --- |
| 1 | hint |
| **2, 3, 6** | **query only** — no hint, no log held, nothing cached |
| 4 | query; the hub serves it, so the hub answers |
| **5** | **query, with the hub relaying what it learned** — or nothing works |
| 7 | a cache, wherever it lives |
| 8, 11 | query, or cache — `:serves` was the answer here and is dropped |
| **9** | **nothing distinguishes moved from offline** — see below |
| 12, 13, 14 | any multi-valued source |
| 15 | query, returning empty — the honest answer |
| 16, 17 | bounds: timeout, caps |
| 18 | merge; both kept |
| **19** | **its own configuration** — a server knows the address it listens on |
| 20 | your own configuration, for the same reason |
| 21 | never needs one |

Three things fall out.

**Query does most of the work.** Scenarios 2, 3, 5, 6 and the recovery half of 8
and 11 have no other source at all. That is §5.3's claim that resolution
knowledge travels along the link graph: *"reaching a space that contains a link
generally means reaching what it points at, because the peers you are already
talking to are the ones who can say where the target is."*

~~**`:serves` covers what nothing else can.**~~ **This was the argument that
kept it, and it does not survive.** Scenario 19 — a server's own main space,
held as nobody's link — has no `:at` available even in principle, and that
looked decisive. But a server does not need to *learn* where it serves: it is
the thing serving, and its address is configuration. The scenario that looked
like the strongest case for a root declaration turns out not to need one, and
what remained after that is in "What is dropped".

**`:at` covers scenario 7 alone**, and only by saving a round trip. Every case
it looked like it covered — 4 and 5, following a hub's links — turns out to be
query.

## The correction

`MAIN-SPACE.md` reasoned its way to `:at` on a link as the durable locator
store. §5.3 had already rejected it:

> **A share link should carry a locator hint; a link stored inside a space
> should not.** A share link is a one-shot introduction whose staleness is
> recoverable by resharing it. A stored link is data that outlives its target's
> hosting arrangements, and a rotted address embedded there is worse than no
> address at all.

The argument the conversation had not reached: **rot in replicated data is worse
than absence.** A stale address in a link looks authoritative, gets tried, and
propagates to everyone who holds your space — and keeps propagating long after
it stopped working. A stale address in a client-side cache costs one dial and
dies with the client.

That reduces `:at` from a locator *store* to a return-visit *optimisation*, and
once it is only that, §5.3's argument settles where it belongs: **outside any
space.** Losing it costs a query.

## What is kept

**Announce and query, on the ephemeral channel.** §5.3's two halves, unchanged.
Push on starting to serve and on reconnect; pull by asking connected peers in
parallel and merging. One hop, no transit, because at one hop every entry is
about a live connection the answering peer can vouch for.

**A client-side cache**, holding what worked. Not in any space, not replicated,
never authoritative. This is where `:at` went — and, since `:serves` was dropped
too (below), it is now the whole of "returning to a space you already hold".

That weight changes its shape. `get(space) -> url` is too thin for three
reasons: a locator is not a string (§5.2 has two shapes, and `{via, peer}` is
how a browser is reached); several may be worth keeping, since reachability
differs per client; and nothing records whether one *worked*, which is what
"first tried, first discarded" implies an ordering for. So it is a small
bounded list per space, ordered by what most recently succeeded, with the
client recording outcomes as it dials.

**The share-link hint**, which §5.3 calls a primitive rather than decoration:

> Bootstrap is the one case none of this solves. Every mechanism above moves
> knowledge between peers who are already in contact. The very first contact
> with a stranger's space needs one locator from outside the system.

## What is dropped

**`:serves` on a space's root.** This document previously kept it, and §5.3
ranked it the *best* source: durable, signed, replicated with the log, still
valid months after every announcement expired. It is dropped for two reasons,
and they are worth stating because the idea is a natural one to have again.

**The peer that knows the address cannot write it.** Only the space key writes
the root (§7.2.1), and a peer that serves a space is usually a replica holding
no key for it — which is exactly what a hub hosting someone else's space is
(§6.1). The knowledge sits with the host; the authority sits with the writers.

**Reachability is not a property of the space.** Whether a locator works is a
fact about a *pair* of peers. Replicating one answer means every client folds
the same list and they disagree about which entry is real — a fact about the
network stored as a fact about the space.

A third, smaller: hosting changes more often than content, so a durable record
of it means frequent writes to the most contended attribute in the system.

**What it was for is now unfilled, deliberately.** Scenario 19 — a server's own
main space — needs no locator from the log: a server knows its own address as
configuration. What is genuinely lost is the long-gap case: a client holding a
space, cache cleared, with no live peer that knows. §5.3 now says that is the
same shape as §5.1.1's key loss — per-client state whose loss is unrecoverable
in-band — and the honest answer is a re-shared link.

**`:at` on a link.** A link names a space and carries no address. Scenario 4 and
5's case — following a hub's curation — is answered by asking the hub, which is
connected and knows, rather than by the hub having cached an address that may
have rotted since.

## Two things that stay unresolved

**Scenario 9: moved or offline?** A failed dial does not say. §5.3's three-way
empty answer is the partial answer — *I do not track this space* (stop asking
this peer), *I track it and nobody is serving, last seen at T* (ask elsewhere,
and tell the person something true), *here are locators* — which at least lets a
client say something honest rather than "gone".

**Scenario 5 and "one hop".** A hub answering for a space it does not serve must
relay what it learned from *its* connections. That is one hop from the hub and
two from you. §5.3 says one hop and no transit, and this is the case where the
distinction needs stating precisely: a peer may answer from what its own live
connections announced, and may not answer from what *those* peers were told.

## What a client actually resolves

**On demand, for spaces it is opening.** Not every link it holds: a hub with a
hundred links would mean resolving a hundred spaces nobody is looking at, which
is the eager-fetch problem manual expansion already avoids
(`MAIN-SPACE.md`).

Announcements arrive unbidden for whatever a peer's connections serve, so some
knowledge is free. Query is for the rest, when someone actually opens something.

## The numbers

Deliberately absent, per §5.3: dial timeout, cap per space, cap per announcing
peer, default expiry. *"They belong in a measurement against a real network."*

The cap per announcing peer is the one §5.3 singles out as important — it is
what stops one peer crowding the real entry out of a list.
