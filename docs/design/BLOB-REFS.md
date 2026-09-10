# `:body` holds two different things, and encryption made it matter

**Status: a problem statement, not a decision.** Written after stage 10 shipped
and immediately regressed a promise §6.2 makes. It records what broke, why the
diagnosis took three wrong turns, and what the candidate fixes are — so the
decision can be made deliberately rather than under pressure from a bug.

Nothing here is settled. **The naming and the blast radius are the two things
still to work through**, and both are open.

---

## What is broken

§6.1 says a peer without the reading key is *"a complete, verifying, useful
replica of a space it cannot read"*, and §6.2 offers *"always-on peers without
custody"* — a peer that keeps a space alive while holding only ciphertext. The
original design intent was explicitly that **you can mirror a space, blobs
included, without being able to read it.**

After stage 10, you cannot. A keyless peer relays every event and acquires no
blob, so it keeps a file space's *structure* alive and not its bytes. Two peers
never online together see a file listed and cannot fetch it.

## Why: an address got encrypted

A blob is stored and requested by the SHA-256 of **the bytes as stored**, which
for an encrypted space is the ciphertext (§2.4). That is not incidental — §2.4
chose it deliberately, and said why:

> The alternative — addressing by the plaintext hash — buys dedup across spaces
> that share content, and costs the property §6 exists to provide: a peer
> without the reading key could not verify a blob it stores and serves, because
> it cannot rehash what it cannot decrypt.

**That reasoning only makes sense if a keyless peer is expected to acquire
blobs.** §2.4 arranged the addressing so it could, and then stage 10 encrypted
the one thing it needed: the address itself, which lives in `:body`.

So the blocker is neither the cipher nor the store. It is that **a pointer was
put in a slot that gets encrypted**, and a pointer is not content.

### The address is safe in the clear

Worth stating explicitly, because the opposite was assumed at first and it is
what the fix rests on:

- A blob hash is an **address**, not content. §2.4 already addresses by it and
  §6.3 already concedes a host learns *"how large every blob is, and when it
  arrived"* — so it already knows the blob exists and its size.
- Because blob encryption is **randomised** (`ENCRYPTION-PLAN.md`), the
  ciphertext hash is unpredictable *even to someone who guesses the plaintext
  exactly*. Encrypting one file three times gives three unrelated addresses.
  There is therefore **no confirm-a-known-file attack** available from the
  address — which is the attack randomisation was chosen to prevent, so the two
  decisions reinforce each other rather than trading off.

What a keyless peer would newly learn is *which objects are blob-backed* — and
§6.3 already concedes it learns *"which carry a body and so which are files
rather than folders"*. This looks like no new disclosure. **Unverified: worth a
second pass before relying on it.**

## Why `:body` cannot simply be exempted

`:body` is not always an address. It is discriminated by `:kind`, and the three
writers in the codebase do genuinely different things:

| writer | what `:body` holds | is it a reference? |
| --- | --- | --- |
| `fs/files.ts` | a blob hash | **yes** — bytes are elsewhere |
| `fs/links.ts` | a space public key | **yes** — the space is elsewhere |
| `fs/text.ts` | sequence operations | **no** — this *is* the content |

A text document's `:body` carries the characters someone typed. Leaving `:body`
in clear would publish document contents. And exempting it *conditionally on
`:kind`* does not work either, because a keyless peer cannot read `:kind` — that
is §6.1's deliberate design, and un-deliberating it leaks which objects are
conversations, which are documents, which are images.

## This was predicted

§3.9 has been open since it was written, and names this failure exactly:

> A snapshot of a log-backed body (§9.1) is itself a content-addressed blob,
> fetched on demand, belonging to an object whose body is emphatically *not* a
> blob. So **"is this body a blob" and "is this value stored out of line" are
> two different questions, and a design that answers them with one mechanism
> will have to separate them again.**

§3.9 deferred the decision on the grounds that it *"wants to be made against a
real implementation rather than in advance"*, and that nothing depended on which
way it went. Both conditions have now changed: there is a real implementation,
and encryption depends on it. Snapshots (§9.1) are the second forcing case and
are still ahead of us.

## What v1 did

The archive is worth reading before renaming anything. `archive/v1/DESIGN.md` §2
had **no `:body` at all** — three separate attributes:

```
:content   Hash | null              full SHA-256 of the blob
:link      { space, object? }       a reference to another space
:type      string | null            replicated format hint
```

So a blob reference was its own attribute, and a link was another. The current
design merged all three into one `:body` slice discriminated by `:kind`.

**The merge was not a mistake.** §3.3's "exactly one body slice per object"
exists to keep coupled state in one bag a single rule can fold, and that
argument is sound and load-bearing. But it is an argument about *content*, and a
pointer to bytes travelling by §2.4's separate path is not content. The merge
took a good argument slightly further than it reaches.

## Candidate fixes

Not ranked, and none chosen.

**A. Split the reference back out of `:body`.** A blob-backed object carries its
hash in a dedicated attribute, left in clear like the root; `:body` keeps only
in-the-log content and stays fully encrypted. Settles §3.9 toward "out-of-line
is a separate question from body rule", and §9.1's snapshots get the same slot.
- Open: **the name.** v1's `:content` has continuity with the archive but reads
  like it holds content, which is the confusion being fixed. `:ref`, `:blob`,
  `:at` are all candidates and none is obviously right.
- Open: **does a link share it?** A link target is also an out-of-line
  reference. One attribute for both, or two as v1 had?
- Open: **migration.** Everything written since stage 10 puts blob hashes in
  `:body`. Either those spaces migrate, or both spellings are read, or they are
  abandoned. Nothing has shipped to anyone, so this may be free — worth
  confirming rather than assuming.

**B. A clear marker inside the value.** Keep `:body` merged; make an out-of-line
value a small envelope whose marker byte and address stay in clear while the
bytes remain encrypted. Avoids a vocabulary change and works for any slice.
- Largely option A wearing a disguise, without a named attribute to hang
  documentation and tooling on. Also puts a format inside a value the substrate
  is supposed to treat as opaque (§2.1), which cuts against the grain.

**C. An unencrypted `:blobs` list on the root.** The root is already in clear, so
listing every referenced address there needs no new exemption and no rule
change. Keyless mirroring becomes one flat read.
- Only the space key writes the root (§7.2.1), so this centralises something any
  writer can currently do alone, and duplicates state `:body` already holds —
  two sources that can disagree.

**D. Forward `WANT_BLOB` through relays.** Leave encryption alone; let a peer
that lacks a blob ask its own peers on the requester's behalf.
- Turns a relay into a proxy: loop detection, amplification limits. And the hub
  still stores nothing, so *"keeps a space alive when everyone else is offline"*
  — the actual promise — still fails.

**E. Revert the blob half of stage 10.** Ship value encryption, leave blobs
unencrypted for now, and take §3.9 as its own piece of work rather than under
pressure from a bug.
- Honest about scope. Costs the privacy of file contents in the meantime, which
  is most of what encryption was for in a file-sync space.

## What is not broken, and was thought to be

Two dead ends, recorded so they are not re-explored:

- **The tree walk.** `referencedBlobs` recurses through `:parent` via `list`,
  which a keyless peer cannot resolve. This looked like a second blocker and is
  not: `state.objects` is a flat map, and iterating it directly reaches the same
  objects for less work. The recursion is gratuitous regardless of encryption
  and should probably go either way.
- **The hash being secret.** It is not, per above. An early reading of this
  problem assumed the address had to be derived or published separately; it is
  already in `:body`, already a ciphertext address, and already exactly what
  `WANT_BLOB` takes.

## What a keyless peer already retains

Useful for whichever fix is chosen: `Folder` keeps every `:body` event's raw
value in `bodyEntries` **whether or not it can pick a rule** — so a keyless peer
is already holding the encrypted address and simply cannot open it or see it.
`ObjectState` does not expose those entries. No new replication is needed by any
of the options; this is entirely about what is encrypted and what is named.

## Next

Decide A–E, and if A, settle the name and the link question. Then check the
blast radius against §3.3, §3.9, §4.2 and §9.1 — snapshots especially, since
they are the case §3.9 said would force this and they are still unbuilt.
