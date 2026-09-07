# A connection carries many spaces

**Status: built** (PLAN.md stage 8.1). It corrects an assumption the code made without
ever stating it, found by a browser that could see a link and never open it.

---

## The assumption, and where it came from

**A connection was opened *about* a space.** `HELLO` names one, `attach` binds a
store to it, and both ways in — `join` for a connection this peer dialled,
`adopt` for one that arrived — wire every frame to that single session.

Nothing decided this. It is what falls out of building sync first, when a peer
held one space and a connection could only be about that one. The main-space
model (`MAIN-SPACE.md`) made a peer hold many; the transport never followed.

**Exactly one message names a space: `HELLO`.** Every other control message —
`EVENTS`, `WANT`, `SYNCED?`, `WANT_BLOB` — is implicitly about *the* space the
connection is for. That implicit binding is the whole of the problem, and it is
worth saying how small it is: the ephemeral channel already names its space
inside each message, so announcement and resolution are space-independent today.

## What it breaks

A hub hosting a space held only by a browser.

1. The hub folds a link and decides to host space K (`MAIN-SPACE.md`).
2. It has no locator for K, so it asks: `RESOLVE(K)` on its connections. **Works.**
3. The browser answers `RESOLVED(K, known: true, at: [])` — *I have it, and I
   have no address; reach me here*. **Works.**
4. The hub opens a session for K on that connection. **Silently fails.**

Step 4 fails on both sides for the same reason. `adopt` binds the connection to
the first space it heard about and routes later frames there, so the hub's
`HELLO` for K reaches the *other* space's session, which sees a mismatched space
and closes. `join` is worse: it wires every frame to one session with no
dispatch at all.

**And there is no way round it.** A browser cannot be dialled (§5.6), so "open a
second connection" is unavailable by construction — the hub cannot initiate and
the browser does not know it should. If one connection cannot carry a second
space, a hub can only host spaces owned by peers that already have addresses,
which excludes every browser. That inverts who hosting is for: the whole point
is that the browser holds the only copy and the hub is what makes it durable.

## The change

**Every control frame names its space**, not only `HELLO`. A receiver routes by
that name to the session for that space, or opens one.

Two forms were considered. A **session index** — `HELLO` claims a small integer,
later frames carry it — costs a byte or two per frame and buys negotiated state
that a peer can misremember, which misroutes events rather than dropping them. A
**space id per frame** costs 64 bytes as hex in the current JSON encoding and is
stateless.

**Take the id.** Control frames already carry hex event ids and full signatures,
so the id is not where the bytes are, and a wrong id fails closed: there is no
session for it, and the frame is dropped rather than applied to the wrong log.
Blob chunks are the one place per-frame overhead would matter and they are
framed separately, addressed by hash, unchanged by this.

**No protocol version bump.** Nothing is deployed but a demo server, and the
cost of a bump is paid by peers that must interoperate across it. Revisit when
there are any.

## What follows from it

**Refusal becomes per space.** Today a peer that will not hold a space closes
the connection, which is honest when the connection is *about* that space. With
several spaces on one connection it must refuse the one and keep the rest — so
`onRefused` stops being a connection-level event, and a connection survives a
refusal unless it has nothing left.

**`viaPeers` becomes real.** `Client.resolve` already reports peers that serve a
space and offer no address, and `reach` already tries to attach over the
existing connection. That path is currently a promise the transport cannot keep;
this is what keeps it.

**One session per space per connection stays the invariant.** Several sessions
on one transport, never several for one space — the duplicate-delivery bug that
motivated `testwire.ts`'s rules came from exactly that, and the guard belongs in
the dispatch table rather than in each caller.

**`spaceFromHello` stops being special.** It exists because the space was
knowable only from a greeting; when every frame names its space, reading it is
the ordinary path and there is no peeking.

## What this does not change

- **The ephemeral channel.** `ANNOUNCE`, `RESOLVE` and `RESOLVED` already name
  their space in the message. Resolution needed no connection to be *about*
  anything, which is why the flow above works up to step 4.
- **Blob transfer.** Chunks are addressed by content hash and carry no space.
  Two spaces holding the same blob is not a collision; it is deduplication.
- **Who may connect.** A connection still proves nothing about authority. What
  a peer will hold is `acceptUnknownSpaces` and the hosting rule
  (`MAIN-SPACE.md`), unchanged.

## What to check while building

- **A frame for a space the receiver does not hold** must be dropped without
  disturbing the sessions that share the connection.
- **Two spaces syncing concurrently** over one connection must not interleave
  into each other's logs — the failure the "route to whichever space was last
  greeted" shortcut would have produced, invisibly.
- **Closing.** A connection closes when the transport does, not when one space
  finishes with it, and every session on it is dropped together.
