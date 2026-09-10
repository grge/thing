# The web client: what it still wants

**Live.** Settled decisions are in `../design/WEB-CLIENT.md`; the eight build
stages that got here are recorded in `DONE.md`.

All eight stages are built. What remains is not on that list.

## Settings wants a refresh — **noted, not designed**

Built as one panel of three sections with a paragraph of prose above each. The
prose is doing work the interface should do, and two of the three sections are
in the wrong place.

- **Cut the explanations.** They were written to justify the settings to
  someone reading the code, and that is not who is looking at the panel. The
  reasoning belongs here and in §5.1.1; the panel needs labels.
- **Keys belong to a space, not to the client.** A key is per-space (§5.1), so
  listing every space's key under a global panel is organising by where the
  code lives rather than by what the thing is. They want a per-space settings
  view — reachable from the space, alongside its other per-space choices.
- **That view is also where sync depth goes.** "Keep a copy of this space"
  (`mirrorBlobs`) is currently a toolbar icon with no explanation and no
  neighbours; it is a per-space policy and belongs beside the key.

**The substantive change is import, not layout.** Today a key can only be
copied *out*. §5.1.1 lists "an explicit export the user is prompted to keep"
among the candidate answers to key loss — and an export nobody can restore is
half a mechanism. A per-space settings view should let a **missing key be
supplied**: paste the seed for a space that currently opens read-only, and it
becomes writable again.

Two things that need care when it is built, both from §5.1.1:

- **A supplied key must be checked against the space id**, since a space is its
  public key. Accepting a seed whose public key is not this space would present
  a different space wearing its name, which is the exact failure the read-only
  fallback exists to prevent.
- **It is the recovery path, so it is also an attack surface.** Pasting a seed
  is handing over write access to whoever produced it; the view should say what
  is being granted rather than treating it as a preference.

## What the object header changed — **built**

Every object in the preview pane now carries a collapsed header showing what it
*is*: uuid, space, parent, the body's rule and value, and every attribute slice
with the rule it folded by. Struck-through cases — an unreadable body
(`bodyRuleMissing`), a cycle-broken parent, held-aside entries — show only when
they apply.

**It shows the fold's own vocabulary rather than a summary**, which is the whole
point: a view that paraphrases hides exactly what you need when something is
wrong. A file, a folder, a link and a document all read the same way, and the
difference between them is visible as the rule their body folded by.

This overlaps the debug panel below. The header answers *what is this object*;
the panel answers *what is this client doing*. Worth checking, when the panel is
reorganised, whether the per-space views it wants are better reached from here.

## The debug panel wants rethinking — **noted, not designed**

Built as a global panel, and most of what is in it is not global. Peers,
chains, blobs and much of the log are **facts about one space**, and a person
looking at them is almost always asking about the space in front of them. That
suggests a debug *view per space* rather than one panel with a space column —
which would also make it a way to navigate: pick a space, see its peers, its
chains, what content it is missing.

Two things stop that being a simple change:

- **Links complicate it.** A tab's space is not the only space it touches: an
  expanded link is a second space this client holds, cached to show what is
  inside it. A per-space view has to decide whether those are part of the space
  you are looking at or separate subjects of their own — and the answer differs
  between "a link I expanded once" and "a hub whose contents I browse".
- **Storage is genuinely not per-space.** It is a view *across* spaces, and its
  whole purpose is to show the ones no tab points at (above) — the spaces a
  per-space view could never reach, because there is no space to hang them off.
  So even a fully per-space debug view leaves storage somewhere else.

Left as-is for now. The current panel works and shows the right facts; what is
wrong is the axis it organises them on.

**1–3 are the ones that make it a client.** 5 is the one that makes it *this*
client rather than a generic file browser.

**All eight are built.** What remains is not on this list: the debug panel's
organising axis (below), and the resolution work that would let an expanded
link actually fetch anything (§5.3, stage 8 of `PLAN.md`).

## The open question this surfaces

**What does a client without a space of its own do first?** A pure viewer holds
a keyring and a tab list, so an empty client has nothing to show and no obvious
action. Options: create a space on first run (which contradicts the model's
"holds nothing until asked"), or show an empty state offering both *make one*
and *paste a share link*.

The second is honest, and it makes the first-run experience a choice rather than
a side effect. But it means the empty state is the most-seen screen for anyone
who only ever views other people's spaces, and it deserves more thought than a
paragraph here.

## Resolution is the real blocker

Expanding a link holds an empty space and never fetches anything, because
nothing tells it where that space is. That is §5.3, and it is stage 8 of
`PLAN.md` rather than a web problem — but it is what makes the link graph
inert in a browser today.
