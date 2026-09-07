# The web client

**Status: a design.** What the browser client should be, what the previous two
versions had that the current one does not, and what to build in what order.

Written because the rebuild has been growing a feature at a time, which is how a
client ends up as a pile of panels rather than a thing with a shape.

---

## What it is

**A window onto spaces.** Not a file manager that happens to sync — a way to
look at, and sometimes edit, a handful of spaces at once.

The model (`docs/MAIN-SPACE.md`) settles most of the structure:

- **Tabs, not an inventory.** Several spaces open at once. Opening writes
  nothing; keeping is deliberate.
- **A tree per tab**, with links to other spaces in it. Following one opens a
  tab; it does not descend in place.
- **Not an admin console.** Health, disk usage and restart are the CLI's. A
  browser edits spaces and nothing else.

That last one is a real constraint and worth restating: **there is no server
dashboard here, ever**, because space authority cannot answer operator questions
and remote administration would need an auth model this design does not have.

## What the previous versions had

Two are archived. `archive/ui/` is v1 — the fuller of the two — and
`archive/web/ui/` is the version this rebuild replaced.

| | v1 (`archive/ui`) | v2 (`archive/web/ui`) | now |
| --- | --- | --- | --- |
| tree with drag-to-reparent | ✅ | ✅ | ✗ |
| preview pane beside the tree | ✅ | ✅ | below it |
| renderer registry, by media type | ✅ | ✗ | ✗ |
| text / image / PDF renderers | ✅ | partial | text + image |
| download a file | ✅ | ✅ | ✗ |
| share links | ✅ | ✅ | ✗ |
| join by code | ✅ | ✅ | via URL only |
| debug: version vectors, forks | ✅ | ✅ | ✗ |
| peer list | ✅ | in debug | ✗ |
| settings | ✅ | ✗ | ✗ |
| mobile single-pane | ✅ | ✅ | ✗ |
| upload button (non-drag) | ✅ | ✅ | ✅ |
| rename, delete | ✅ | ✅ | ✗ |

**The current version is behind both.** That is expected — it was rebuilt for
the tab model and only what the model changed was carried across — but it means
"what is missing" is most of a client.

### Three things worth taking rather than reinventing

**The renderer registry** (`archive/ui/renderers/registry.ts`). A renderer
claims *format patterns*, not object types, and selection walks a degradation
chain most-specific-first: a `text/markdown; variant=todo` object is claimed by
a todo renderer if one exists and by a markdown renderer otherwise, so an object
stays readable rather than failing. That is the same tiering §3.1 applies to the
fold, at the presentation layer, and it is the right shape.

**The mobile scope decision** (`docs/v0/MOBILE.md`). Settled, and worth not
relitigating: **reader-first, not full parity.** A phone must be able to open a
share link, navigate, select, and see every preview state. Space creation and
non-drag content-in are wanted. Touch drag-to-reparent is explicitly *not* —
it is a separate UI problem that buys nothing the narrower scope does not.

**The preview's fetch discipline** (`archive/web/ui/Preview.svelte`), already
carried over: a blob may not be held, so ask peers and retry when one appears,
and treat `:kind` as advisory.

## The shape

```
┌────────────────────────────────────────────────┐
│ tabs                                    ⚙ ⓘ    │
├──────────────┬─────────────────────────────────┤
│              │                                 │
│  tree        │   preview                       │
│  (sidebar)   │   (the rest)                    │
│              │                                 │
│  + file      │                                 │
│  + folder    │                                 │
│  + link      │                                 │
└──────────────┴─────────────────────────────────┘
```

**Sidebar and pane, not stacked.** Reading a file while navigating is the
common case, and stacking makes the tree scroll away.

**Below ~40rem: one pane.** The tree, and selecting pushes the preview over it
with a back affordance. `docs/v0/MOBILE.md` did this at exactly that breakpoint
and it worked.

**Two panels behind icons**, not tabs of their own — they are occasional:

- **Settings** ⚙ — signalling URL, ICE servers, this client's keys.
- **Debug** ⓘ — version vectors, forks, connected peers, recent activity. Named
  honestly rather than dressed up as "status", because it is for someone
  developing this, and the operator view lives in the CLI.

## What each piece is

**The tree.** A folder listing with drag to re-parent, drag from the desktop to
add, and links marked as links. Rename in place; delete to `:deleted` (§7.2.3's
shape — hidden, not unwritten).

**Links expand like folders**, showing what is inside the space they point at.
Expanding is *looking inside*; opening in a tab is *going there*, and they are
different acts — a tree that yanked you into another space every time you
opened a link would be unusable for browsing a hub. Expanding a link this
client does not hold yet fetches it first.

**The preview.** A renderer chosen by media type through the registry, with the
degradation chain. Text, image and PDF to start. Every file gets a **download**
button regardless of whether anything can render it — that is the honest
fallback and it is missing today.

**Links.** The gesture is **dragging a tab into a space**: it means *keep this
here*, and it is the same act as dragging a file in — content arriving from
outside. A hub gets curated by opening spaces and dragging their tabs into it,
which needs no key typed and no dialog.

That is also the clearest expression of the model's central distinction: a tab
is a space you are *looking at*, a link is one you have *kept*, and dragging one
into the other is exactly the moment that changes. Pasting a key stays available
for a space nobody has open, but it is the fallback rather than the path.

**Share.** A link carrying `k`, `n`, `t`, and optionally `l` (§5.4). The `l`
hint is the one locator source that works before you know anybody, so it is not
decoration — but per `docs/LOCATORS.md` it belongs in a *share link* and never
in a stored one.

**Join.** Paste a share link or a short code. Currently only a URL fragment
works, which means a phone cannot join from a message it was sent unless the
link is tappable.

## Closing a tab deletes the space

**Deliberate, and a footgun.** The alternative is that closing leaves the log
behind — which means spaces accumulate with no way to remove one, and a browser
that has visited a few hubs holds every space it ever expanded. Before this was
decided, nothing in the client deleted anything, ever.

The reason for choosing the destructive rule is that the safe-looking
alternative is not safer, only quieter: **a client cannot know whether its copy
is the last one.** No policy can decide what is safe to close, so deciding is
the person's job however this behaves, and a rule they can state in a sentence
beats one that guesses on their behalf. The UI asks first and says what it
means.

Spaces held only to expand a link go too, unless another open tab links to them.

**That is not reference counting**, which cannot work here: links live inside
spaces this client may not hold, so the graph cannot be walked without already
holding all of it, and it has cycles by design. The rule is narrower — **a space
that is not a tab is cached** — and cached spaces are disposable because losing
one costs a fetch. The one-hop check from open tabs is what stops a shared space
vanishing while something still shows it.

### The storage view, and why it is needed

Deferred to stage 7 rather than built now, but it is not optional.

With closing-deletes and no inventory, **a space in storage that no tab points
at is unreachable**: nothing lists it, nothing can open it, and nothing can
remove it. That should not happen — closing sweeps, and `restore` reopens what
was open — but "should not happen" is exactly the class of thing that wants a
way to look.

Three cases it covers:

- **A bug leaves a space behind.** Every cleanup path here is code that can be
  wrong, and this is the only way to see that it was.
- **A partial write.** A tab closed mid-delete, a browser killed during
  `restore` — the sweep runs on next start, but seeing what it found beats
  trusting that it ran.
- **Recovering a space whose tab was lost.** If the tab list and the storage
  ever disagree, this is the only route back to the data.

So: list what `IdbStore.list()` reports, alongside which are open. Restore one
to a tab, or delete it outright. It belongs in the debug panel rather than the
main interface — it is for when something has gone wrong, and putting it
forward would suggest that browsing storage is an ordinary thing to do.

**One caveat for whoever builds it.** `IdbStore.list()` uses
`indexedDB.databases()`, which is not available everywhere; its own comment says
the caller's record is the answer where it is missing. So this view is
best-effort, and on a browser without that API it can only show what the
inventory already knows — which is precisely the case it is least useful in.
Worth saying in the panel rather than showing an empty list that looks
authoritative.

## Build order

Each stage should leave a client someone can use.

1. ~~**Layout: sidebar tree, preview pane, mobile breakpoint.**~~ **Done.**
   `minmax(14rem, 22rem) 1fr`, collapsing to one pane at 40rem with selection
   pushing the preview over the tree — the mechanism `docs/v0/MOBILE.md`
   arrived at by building it. `app.css` went from 615 lines to 70: the rest was
   component CSS for components this rebuild does not have, and a global rule
   for a component that does not exist is a rule nothing checks. It is in
   `archive/ui/app.css` for when a panel comes back.
2. ~~**Download, rename, delete.**~~ **Done**, plus the tree itself: folders
   now expand in place rather than replacing the view, which is what makes it a
   tree rather than a navigator. Recursive by snippet over `FileEntry`, with
   expansion held as interface state — the same shape `archive/ui/Tree.svelte`
   used. Delete is `:deleted`, which hides without unwriting (§7.2.3).
3. ~~**Drag: re-parent within a tree, and desktop-to-tree.**~~ **Done**, plus
   dragging a tab into a space to keep it. Dropping onto a file means *into the
   folder containing it*; a move that would put a folder inside itself is
   refused rather than resolved, since §3.4 would re-parent it to the root
   deterministically and that is a baffling thing to watch happen. Internal
   drags and file drops are distinguished by `dataTransfer.types`, so an
   internal drag does not raise the whole-window "drop files" outline.
4. ~~**The renderer registry**, with text, image and PDF.~~ **Done.** Type
   parsing and the degradation chain went into the engine, since they are
   platform-free and a terminal client wants the same fallbacks; the registry
   and the three renderers are in `web/src/ui/renderers/`.
5. ~~**Links: pasting a key**, for a space nobody has open.~~ **Done.** One
   parser takes a bare key or a whole share link, since both are things people
   copy; **not** a short code, which is derived from a key's hash and cannot be
   reversed (§5.4). Two entry points, matching the drag: *open* puts it in a
   tab, *link here* keeps it in the current space.
6. ~~**Share.**~~ **Done** — the link, the key and the code, each with what it
   guarantees, since they are not interchangeable. Joining by *pasting* landed
   in stage 5; there is no join-by-code, because a code cannot be reversed to a
   key (§5.4) and so cannot open anything on its own.
7. ~~**Debug panel** — vectors, forks, peers, activity, **and storage**.~~
   **Done.** Reached from the tab bar, closed by default: it is for when
   something has gone wrong, and putting storage forward would suggest that
   browsing it is ordinary. It renders outside the "a space is open" branch,
   because the storage view is most useful exactly when nothing will open.

   Six tabbed views — peers, chains, storage, blobs, ephemeral, log — rather
   than one scrolling page, because they answer unrelated questions and only
   one is ever being asked. Everything is a table; the log filters.

   It earned its place immediately. On first run against a real browser it
   showed **seven spaces with no tab** — every link expanded during testing,
   held and unreachable — and the blobs view showed rows marked *referenced but
   missing*, which is the "Fetching…" case made visible. `canEnumerate` on
   `IdbStore` reports whether the listing is complete, so a browser without
   `databases()` says so rather than showing a short list that looks
   authoritative.

   **A status footer sits above it, always visible.** Connectedness is not a
   debugging concern — it decides whether anything you do reaches anyone — so
   the peer count for the current space, its name, any fork and whether it is
   keeping copies are on screen permanently, with the peer list as a popout.
   Revealing that only on demand makes "nothing is syncing" look identical to
   "everything is fine".

   **One trap worth recording.** `refresh` writes `$state` and is driven by
   `client.subscribe`, which fires on every fold. Calling it from inside an
   `$effect` made the effect depend on its own writes and froze the tab hard
   enough to need closing; a sync of a few hundred events also fires the
   subscription a few hundred times, each starting an async read of storage and
   every blob hash. It is now guarded against overlap and coalesces a trailing
   pass, and the effect tracks only the space id.
8. ~~**Settings** — signalling, ICE, keys.~~ **Done.** In the footer beside
   debug, and the two are exclusive — both are panels about the client rather
   than about a space.

   Three things that are not the same kind of thing. **Signalling and ICE** are
   how a peer is reached: addresses, disposable in the way §5.2 says locators
   are, where a wrong value costs a failed connection. **Keys** are the
   opposite — §5.1.1 calls key loss the largest unresolved risk in the design,
   so the section is an export, and it is the reason the panel exists at all.

   Two details worth keeping. Changes apply **on reload**, said plainly rather
   than papered over: a `Client` reads both at construction, and reconnecting
   every peer to apply a preference would drop live transfers to no purpose.
   And an **empty ICE list is a real choice** — no STUN, local network only —
   so it is stored as `[]` and never folded into "unset", which would silently
   restore the default.

### Settings wants a refresh — **noted, not designed**

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

### The debug panel wants rethinking — **noted, not designed**

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

## What is deliberately not here

- **Server administration.** Covered above; it is the CLI's, permanently.
- **Touch drag-to-reparent.** `docs/v0/MOBILE.md`'s settled scope decision.
- **Editing a remote space.** Needs the `:writers` bootstrap
  (`docs/MAIN-SPACE.md`); reading a hub works, curating one does not yet.
- **A space list.** There is no inventory. Tabs are the only set of open spaces,
  and what you keep lives as links in a space of your own.

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
