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
5. **Links: pasting a key**, for a space nobody has open. The drag gesture
   landed in stage 3.
6. **Share and join**, including a pasted code rather than only a URL.
7. **Debug panel** — vectors, forks, peers, activity.
8. **Settings** — signalling, ICE, keys.

**1–3 are the ones that make it a client.** 5 is the one that makes it *this*
client rather than a generic file browser.

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
