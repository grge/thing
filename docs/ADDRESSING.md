# Addressing and identity — a proposal

**Status: proposal, for decision.** This is stage 0 of the next iteration
([NEXT.md](NEXT.md)): the thing to settle on paper before any code, because
addressing is a *decision* rather than a discovery — building a spike will not
resolve it, and it is cheap to change here and expensive to change once every
space, link and stored log encodes the answer.

It assumes the stances already settled in NEXT.md: mode 3 out, spaces
uncontrollable once shared, forks legitimate, read-only enforced
cryptographically, links between spaces wanted, and **the product is a website
where you create a space, share a link, and drag files in.**

It also assumes two things about the future that constrain the design more than
they first appear:

- **PeerJS is not a long-term dependency.**
- **WebRTC may not be the long-term connection type**, though distributed
  peer-to-peer remains the default.

---

## 1. How it works today

In plain language: **when you create a shared space, the app rolls one random
8-character code, and that single string does four different jobs.**

The code is drawn from a deliberately unambiguous 31-character alphabet — no
`0`/`O`, no `1`/`I`/`l` — because it is meant to be read off one screen and
typed into another. Eight characters of 31 is about **40 bits**.

That one code is simultaneously:

| Job | How |
|---|---|
| **The space's identity** | `space_id` *is* the code |
| **The local storage key** | logs live at `thing:events:<code>`, blobs in a per-space store |
| **The network address** | the writer claims the PeerJS id `thing-<code>`; a reader derives that string and dials it |
| **The access credential** | knowing the code is sufficient to join |

A share URL is just that code plus a display name. Opening the link derives the
storage keyspace from the code, so re-opening it finds the log you already have
rather than re-fetching from zero.

Separately, and unrelated to the code, each browser profile mints a random
**`WriterId`** per space, stored locally. That is what appears in the `writer`
field of every event and what the per-writer hash chain is built on. It is not
derived from anything, not verifiable, and not connected to the share code — it
is simply a random number the client asserts about itself. A reader never mints
one, because the only thing an unused one could do is forge.

So there are two identity-ish things today — the code (the space) and the
`WriterId` (the author) — and **neither is cryptographic**.

---

## 2. What is wrong with it

**2.1 The address is a PeerJS locator.** `thing-<code>` is a string that means
something only inside PeerJS's broker namespace. The identity of a space is
therefore expressed in the vocabulary of one vendor's signalling service. If
PeerJS goes — and it is not a long-term dependency — every address that was ever
shared stops meaning anything. An address must not name a transport.

**2.2 One string does four jobs, so none can change independently.** Rotating
the access credential changes the identity. Changing transport changes the
address. Changing the storage layout changes the identity. They are welded
together by being the same eight characters.

**2.3 Identity is not verifiable, which is now a product problem.** Anyone can
claim any `WriterId` ([I6](ISSUES.md#i6-hello-is-unauthenticated-any-peer-can-claim-any-writer-id)),
and anyone who copies a space's contents can re-share them under a new code.
Nothing lets a reader distinguish the real space from a copy claiming to be it.
That was tolerable when peers were invited by URL and trusted each other. It is
not tolerable now, because:

- spaces are deliberately uncontrollable and copyable, so **copies are expected**;
- links between spaces are wanted, and **a link is a claim about a target that
  the receiver must be able to check**;
- read-only is supposed to stop being convention and become arithmetic.

**2.4 It assumes exactly one location.** One code resolves to one peer id, which
is one place to dial. A mesh has many peers serving one space, changing
constantly. The scheme cannot express that.

**2.5 The address does not outlive the session.** It resolves only while the
writer's tab is open and holding that PeerJS id. But a link handed to someone is
a promise that should still mean something next week — at minimum, "this is
space X and I cannot reach it right now", which is a different statement from
"this is not space X".

**2.6 Squatting is reachable today.** If the writer is offline, anyone who knows
the code can claim `thing-<code>` on the broker and serve a fabricated space to
whoever joins next. With no signatures, the joiner cannot tell. This is not
theoretical; it follows directly from 2.1 and 2.3, and 40 bits is also small
enough to be worth grinding if a code is ever worth impersonating.

---

## 3. Constraints for the target

Derived from decisions already made rather than invented here:

1. **Transport-independent.** The identity must not name PeerJS, WebRTC, or any
   locator. Peer-to-peer stays the default; it is not the definition.
2. **Multi-location.** One identity, many concurrent serving peers, membership
   changing constantly.
3. **Verifiable without trusting the messenger.** A reader must be able to tell
   the real space from an impostor, using only what the link carries — not by
   trusting whoever answered.
4. **Outlives sessions.** "Cannot reach it" and "that is not it" must be
   distinguishable, and a link must remain meaningful while unreachable.
5. **Shareable across devices.** The typeable short code was a deliberate good
   decision; do not simply discard it.
6. **No revocation needed.** Access is admission-only, by design. The identity
   layer does not have to support revocation, which removes a large problem.
7. **Fork-honest.** Copying and re-sharing is legitimate and must produce a
   distinct identity — never a collision, never a silent impostor.
8. **No mandatory central resolver.** A name service everyone must consult would
   contradict the distributed default. A *hint* service is fine; a *required* one
   is not.
9. **Cheap in a browser.** Computable with WebCrypto or a small library, storable
   in browser storage, and small enough to put in a URL and a QR code.

Constraints 3, 5 and 8 are the ones in tension. That tension is Zooko's
triangle: human-meaningful, decentralised, securely unique — pick two.

---

## 4. Options considered

**A. Keep the flat random code; add a keypair only for signing.**
The code stays the address, a key signs events. But if the code does not *commit*
to the key, then resolving a code to a key means trusting whoever answered — an
impostor who squats the code hands you their key and you cannot tell. This works
only with a trusted resolver, violating constraint 8. **Rejected: it does not
actually deliver constraint 3.**

**B. Address is the public key itself.**
Self-certifying, transport-independent, multi-location, fork-honest, no resolver.
An Ed25519 public key is 32 bytes: 52 characters in base32, ~44 in base58, 43 in
base64url. The whole cost is typeability — constraint 5. This is the IPNS / SSB /
Nostr model, and it works.

**C. Address is a truncated hash of the public key.**
Keeps a short typeable address; the full key is supplied at connect time and
checked against the truncation. Attractive, and there is a decisive precedent
against it: **Tor v2 onion addresses were 80-bit truncated hashes, and v3 moved
to full 256-bit keys (56 characters) precisely because truncation became
grindable.** At 40 bits — today's code length — it is grindable now. **Rejected
as the identity: the experiment has already been run.**

**D. Two parts: a short code that finds, a key that verifies.**
The code is a *rendezvous hint* — where to go looking. The key is the *identity*
— what to check when something answers. The share link carries both; the typed
code carries only the hint. Precedents: SSH host key fingerprints, Signal safety
numbers.

**Proposal is D, with B's substance underneath.**

---

## 5. Proposal

### 5.1 A space is a keypair

`space_id` **is an Ed25519 public key**. The private key is what makes someone
the writer. Every event is signed by it, and every peer verifies on receipt.

This collapses two of today's identity concepts into one: with one writer per
space, **the space key and the writer key are the same key**. "Mode 2 is
read-only" stops being convention and becomes *you do not have the private key*
(§7.2's caveat retires). A fork made by copying contents is signed by a different
key and is therefore honestly a different space, with no collision and no
ambiguity.

When multi-writer eventually arrives, the space key becomes an authority that
delegates to writer keys. Not built now, but the shape does not have to change.

### 5.2 Locators are separate, plural, and disposable

```
Locator = { transport: "peerjs" | "websocket" | …, address: string }
```

Nothing about a locator is part of the identity. A space has zero or many at any
moment, and they change constantly. Swapping PeerJS out changes which locator
kinds exist and nothing else — no address anyone has ever shared breaks.

The signalling layer becomes, in effect, a **resolver interface**: *given a space
key, produce candidate locators.* Today that is "derive a PeerJS id and probe the
slot pattern." Later it might be a websocket URL for an always-on peer, or a DHT
lookup. The identity is untouched by all of it.

### 5.3 The short code survives, demoted to a hint

The 8-character code stays — same unambiguous alphabet, same typeability — but it
is **only a rendezvous hint**, never an identity and never an authority.

Derive it from the key by default (`base32(sha256(pubkey))[0..8]`), so there is
one fewer moving part and anyone holding the key can compute where to look. Keep
the link format able to carry explicit locators anyway, so a rendezvous point can
be rotated later if one gets squatted or spammed.

**This is what makes today's squatting problem disappear.** An impostor who
claims the rendezvous slot can still answer you — but what they serve will not
verify against the key in your link, so it is rejected. The code carries no
authority, so stealing it grants nothing.

### 5.4 The share link

```
https://<app>/#k=<base32 pubkey>&n=<suggested name>&l=<optional locator hints>
```

The key goes in the **fragment**, so it never reaches a server log — it is
identity, and under any later encryption scheme it would also be capability.

Two ways in, with honestly different guarantees:

- **Open the link** → you have the key. Full verification. This is the primary
  gesture and the one the product is built around.
- **Type the code** → you have a hint only. You reach *a* space claiming to be
  the one you wanted, and cannot verify it on first contact.

### 5.5 Trust on first use closes the typed-code gap

On first successful join by any route, **pin the key** against the handle the
user used. Every later visit verifies against the pin, and a mismatch is a loud,
blocking warning rather than a silent substitution.

An impostor can therefore fool someone once, on a typed code, for a space they
have never visited — and never again, and never for a space they already know.
That is SSH's model, it costs nothing in UX, and it converts the weakest path
from "permanently spoofable" to "spoofable once, then locked".

### 5.6 Names are petnames, never addresses

Three layers, resolved in this order for display:

1. **Petname** — what this user called it locally. Wins.
2. **Suggested name** — what the space calls itself, signed as part of its own
   data, therefore unforgeable but not unique.
3. **Key prefix** — first ~6 characters, as a disambiguator only.

Nothing ever *resolves* by name. Names are for humans recognising things they
have already met; keys are for machines deciding what something is. That is what
lets Zooko's triangle be dodged rather than solved.

---

## 6. Open sub-decisions

**Where the private key lives — DECIDED: extractable, with an explicit export.**

The tempting alternative is a non-extractable WebCrypto key in IndexedDB, on the
grounds that injected script cannot then steal it. That reasoning does not
survive inspection: **a non-extractable key can still be *used* by injected
script to sign anything it likes.** It is not protected, only unstealable — the
attacker's forgery lasts as long as their code execution rather than forever.
Meanwhile the cost is total: no backup, and Safari's eviction of storage for
sites without recent interaction destroys spaces with no attacker involved at
all.

So the trade is a *routine, attacker-free* failure mode against a partial
mitigation of a rare one. Extractable keys plus a deliberate "save your space
key" export.

The vectors that actually matter, roughly by likelihood: a compromised
dependency shipping code into the bundle; **XSS from peer-supplied content**,
which this design uniquely invites because rendering data from strangers is the
whole job; whoever serves the app; a browser extension with host permissions;
and last, social-engineered bookmarklet or console paste.

The mitigations that help are therefore the ones that stop script executing on
the origin, not the ones that hide the key: CSP, subresource integrity,
dependency discipline, and — highest value for this architecture — **rendering
peer-supplied content inside a sandboxed iframe with no access to the parent
origin.** That should be treated as a real constraint on the renderer registry
(§4.7, [I17](ISSUES.md#i17-renderer-selection-has-no-story-for-active-objects)),
not an optimisation. Encrypting the key at rest under a passphrase defends a
stolen laptop or a storage dump, not live script, which can simply wait for the
user to unlock it.

**Ed25519 availability.** WebCrypto support arrived relatively recently across
browsers; `@noble/ed25519` is the standard small fallback. Verify current support
before committing, and be willing to ship the library rather than depend on the
platform.

**Whether the rendezvous code is derived or independent.** Derived is simpler and
self-consistent; independent allows rotating a burnt rendezvous point without
changing identity. Proposal takes derived, with the link format leaving room for
the other.

**Signature coverage and canonical bytes.** What exactly is signed — the whole
canonical event, or the event minus its id — has to be pinned precisely, because
[NEXT.md's multi-client horizon](NEXT.md) means a second implementation must
reproduce it byte for byte. This is the same §2.1 canonicalisation risk, now
load-bearing for security rather than only for dedup.

---

## 7. What this costs, and what it does not fix

**Costs.** Links get long — a 52-character key is not typed, it is clicked,
copied, or scanned from a QR code. Key management becomes a real thing the
product has to have an answer for, and it is the single most likely place for an
ordinary person to lose something irreplaceable. Every event gains a signature to
compute, transmit and verify.

**Not fixed.** Discovery — this makes identities verifiable, not findable, and
without a DHT you still learn about spaces from links handed to you. Access
control — anyone with the key can read; restricting *who* still needs encryption.
Availability — a verifiable identity for a space nobody is serving is still
unreachable. And v0's existing spaces do not migrate; the codes mean nothing
under this scheme, which is acceptable for a throwaway and should be stated
rather than discovered.
