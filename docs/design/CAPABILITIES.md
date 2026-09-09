# Three keys, and what a link carries

**Status: built**, except the reading key (`r=`), which waits on stage 10. It settles how reading, writing and replicating
are separated, what a share link says, and what a new space defaults to — the
things §6 and §7.2 each specify from one side and neither joins up.

---

## The gap

§6 settles the reading key. §7.2.1 settles who may write. Both are thorough, and
between them sits something neither says: **a share link carries one key, and
there are three.**

```
https://<app>/#k=<public key>&n=<name>&l=<locator>
```

That is the *public* key — identity. §6 says the reading key goes "in the
fragment, alongside the public key"; the format has no slot for it. Nothing at
all says how write authority travels.

**And the default is wrong.** `mayWrite` admits everyone when no writer set is
declared (§7.2.1: an absent set is not an empty one), and nothing writes
`:writers` — so every space made today is writable by anyone holding its public
key, which is exactly what a share link is made of. Sharing a space to be *read*
currently hands over the ability to change it.

That is the sharper of the two problems. An unencrypted space on a public server
is a privacy failure; a world-writable one is a correctness failure, and §6.3
already notes there is no revocation to fall back on.

## Three capabilities

They are genuinely different acts, and the design already treats them as such
(§6.2: *"handing someone the space key asks them to help keep a space alive;
handing them the reading key too invites them in"*). What is missing is a
representation.

| | what it is | what it grants | how it is held |
| --- | --- | --- | --- |
| **space public key** | Ed25519 public | replicate, verify, serve | it *is* the space id |
| **reading key** | symmetric | decrypt values and blobs | shared out of band, §6 |
| **space private key** | Ed25519 seed | write the root: membership, and hence everything | held by whoever administers |

A **writer key** is a fourth thing and not a capability to share: each client
mints its own per space (§5.1), and it is useful only once the space key has
admitted it. Nothing hands one to anybody.

**Note the asymmetry.** Reading is a key you either have or lack. Writing is a
key *plus an admission*: the space key writes `:writers`, and a writer key that
is not in the set signs events every peer stores and no peer folds (§7.2.1). So
"give someone write access" is two steps — they mint an identity, you admit it —
and only the second is yours to do.

## What a link carries

Three links, distinguished by what they contain rather than by a mode flag:

```
#k=<public key>                       replicate — verify and serve, read nothing
#k=<public key>&r=<reading key>       read — the ordinary share
#k=<public key>&r=<...>&w=<seed>      administer — hands over the space itself
```

**All in the fragment**, which never reaches a server (§5.4), and `n` and `l`
ride along as now.

**The third is not "write access".** It hands over the space key, and whoever
holds that *is* the space's authority — they can admit and remove writers,
including you, and §7.2.3 notes there is no way to un-hand it. It exists because
moving a space between your own devices is a real need and this is the honest
way to say what it costs. It should look alarming in a UI, because it is.

**Giving someone write access is not a link at all.** They open your read link,
their client mints a writer key (§5.1), they tell you its public key, and you
admit it. That is a round trip, and it is the round trip that makes revocation
mean anything: an admission can be withdrawn, a key handed over cannot.

## What a new space defaults to

**`create` writes `:writers` naming the creator's key alone.**

Today it writes `:name` and stops, so the writer set is absent and §7.2.1 admits
everyone. The mechanism exists — `Space.addWriter` — and has no caller.

The consequence to accept deliberately: **a space with a declared writer set can
only gain writers from its space key.** That is §7.2.1's cost, and it means a
client that opens someone's space and mints an identity holds a key that cannot
write until admitted. `writable` in a UI must therefore distinguish *I hold a
key* from *my key is admitted* — `Space.admitted` already exists for exactly this
and nothing calls it.

**Opening a space does not make you a writer**, which is the change a person will
notice. Today it silently does.

## The nonce, which §6 already flagged

§6 says the nonce input is `(writer, seq)`, and that this is safe **because one
identity has one chain** — then says the bullet must be revisited before §6 is
built if that ever stops holding. It stopped holding: append points
(`APPEND-POINTS.md`) give one identity a chain per process, so two processes
under one key produce the same `(writer, seq)` for different plaintexts.

An authenticated cipher does not survive that. The nonce input becomes
**`(writer, point, seq)`** — the same triple that already keys a chain
(`chainOf`), which is the natural fix and not a coincidence: the point exists
precisely because `(writer, seq)` stopped identifying a position.

Worth stating that the flag worked. The dependency was written down at the time,
found on re-reading, and cost nothing — which is the argument for recording a
load-bearing assumption where it is made.

## What is deliberately not here

- **Per-object encryption.** §6 is explicit: one key per space, all of it.
  Dividing readership means dividing the space.
- **Revoking a reading key.** §6.3: anyone who has held it holds it permanently.
  A new key is a new space in all but name.
- **Delegated administration.** §7.2.1: delegating membership authority would
  reintroduce the circularity the root rule removes.
- **Hiding who wrote what.** §6.3: encryption conceals content, not activity.

## What to check while building

- **A space with a writer set must still admit its own root events.** Phase 1
  admits on a signature from the space key alone (§7.2.1); a bug there locks a
  space permanently and no later event can unlock it.
- **`mintFor` on a space you cannot write** must still mint. The key is useless
  until admitted and worth having ready — but nothing should report it as
  writable, which is the distinction `admitted` draws.
- **An existing space has no writer set**, and adding this must not lock people
  out of spaces they already share. An absent set still admits everyone;
  only newly created spaces declare one.
