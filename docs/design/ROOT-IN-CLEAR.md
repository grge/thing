# The root is not encrypted

**Status: a design, not built.** It settles which parts of an encrypted space
stay readable, and why the root is a different case from the `:kind` exemption
§6 already considered and rejected.

---

## The problem it answers

An event from a writer nobody admitted is stored, replicated and never folded
(OPEN.md 8a). The obvious fix — refuse it at the store — cannot be taken,
because **a peer without the reading key cannot evaluate membership**:
`:writers` lives on the root and the root is encrypted like everything else. So
an encrypted space could only be hosted by someone able to read it, which is
what §6.2 exists to avoid.

Half of that dissolves if the root is not encrypted.

## What the root actually holds

Three attributes, across the whole codebase:

| | what it is | what leaving it in clear discloses |
| --- | --- | --- |
| `:writers` | a list of public keys | **nothing** — the space key is in it and *is* the space id |
| `:moderators` | a list of public keys, a subset of the above | nothing beyond `:writers` |
| `:name` | what the space calls itself | a name per space |

The first two leak nothing that holding the space id does not already leak. The
third is a real disclosure and is treated separately below.

## Why this is not the exemption §6 rejects

§6 declines to exempt `:kind` from encryption, and the reasoning is worth
quoting because it is *also* the reasoning for treating the root differently:

> leaking the kind of every object in a space is a real disclosure — it says
> which objects are conversations, which are documents, which are images — and
> it buys only compaction by peers who cannot read what they are compacting.

Two things separate the root.

**Scale.** `:kind` is per object: exempting it leaks the shape of the entire
space, growing with its contents. The root is one node, and what it holds is
bounded and mostly public already.

**What it buys.** The `:kind` exemption bought compaction by peers who cannot
read. This buys the *authority model working at all* for a ciphertext-only peer:

- §7.2.1's phase 1 folds without the reading key, so a keyless peer computes the
  writer set.
- Such a peer can therefore tell whether an event will ever fold — which is what
  a bound on unadmitted writes needs, and what nothing could do before.
- §6.1's table gains a row it could not have: *evaluate membership* — **yes**.

## What is exempted, exactly

**Root-targeted events are not encrypted. Everything else is.**

Not "the `:writers` attribute wherever it appears" — the exemption is on the
*target*, because the fold already partitions on exactly that. §7.2.1's phase 1
selects root events by `isRoot(e.target)` before anything else happens, so this
is a property of a partition that exists rather than a special case threaded
through the codec.

That also makes it checkable: an encrypted space has ciphertext in every event
whose target is not the root, and cleartext in every event whose target is. A
peer can verify the invariant without knowing what any of it says.

## `:name` is the one real cost

A hub operator would see what every hosted space is *called*. For a personal
file-sync space that is "laptop docs" visible to whoever runs the box — much
smaller than the contents, and not nothing.

**Two options, and the choice should be deliberate:**

- **Exempt the whole root.** Simple to state and to check: root in clear,
  everything else encrypted. Costs one name per space.
- **Exempt `:writers` and `:moderators` only**, encrypting `:name` like any
  other value. Leaks strictly nothing beyond the space id, at the cost of an
  attribute-level rule inside the root rather than a target-level one — and a
  keyless peer then cannot show an operator what it is hosting.

**Recommended: exempt the whole root**, and treat the name as public. A space
holding secrets should not be *called* something that gives them away, which is
a smaller thing to ask of a person than it sounds, and the alternative makes the
invariant harder to state and to check. But this is a privacy trade rather than
a technical one, and it should be made rather than defaulted into.

## What it does not fix

**Membership is still time-dependent.** §7.2.3 judges an event against the set
its author had seen, so a peer may hold an event that a not-yet-arrived root
event would legitimise. A store that refused on arrival would drop events an
append-only log cannot un-refuse.

So this turns *cannot check* into *can check, but must not check too early* —
which is a much smaller problem. The likely shape: **store it, decline to
relay it, and reconsider when the root changes.** Declining to relay is not
un-storing, and it bounds the cost at one peer rather than propagating it.

**It does not hide activity**, which §6.3 already concedes. A keyless peer
learns the writer set, which it could largely infer anyway from who signs what.

## What to check while building

- **The nonce.** Root events are not encrypted, so they consume no nonce. The
  input remains `(writer, point, seq)` (`CAPABILITIES.md`) and nothing about
  this changes it — but a construction that derived a key per *object* would
  need to say what the root's is, and should not have one.
- **An unencrypted space and an encrypted one must fold identically.** The
  exemption is about what is encrypted, never about what is admitted; §7.2.1's
  phase 1 already ignores everything but the signature.
- **A space that gains a reading key later** has cleartext root events written
  before it and after it, which is consistent — the root was never encrypted at
  either point.
