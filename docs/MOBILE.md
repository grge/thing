# Mobile mode — plan

Companion to [PLAN.md](PLAN.md) and [SPEC.md](SPEC.md) §8. The UI as built is
desktop-only; this plans what "usable on a phone" means for v0 and in what
order it gets built. Not a new mode in the §7 sense — no new event shape, no
new attribute. It is the existing modes 1 and 2, made reachable from a touch
device.

## Why this isn't optional for v0

The three POC questions (SPEC §0) already assume a phone shows up:

- **Q1** measures peer-pair connection failure without TURN. The README's own
  two-device test asks for "one on wifi, one on a phone hotspot" — a phone is
  the natural second device, not an optional extra one.
- **Q3** asks whether paste-then-share-a-URL *feels good*. A share code or
  link pasted into a chat app is opened on whatever device that chat app is
  running on, and for most people most of the time that's a phone. Testing Q3
  only on two laptops answers a different, easier question.

So this is a gap in how faithfully the POC can test what it already claims to
test, not scope creep on top of it.

## Current desktop-only assumptions

What the app depends on today, concretely:

1. **Fixed two-pane layout.** `app.css`'s `.panes` is
   `grid-template-columns: minmax(14rem, 22rem) 1fr` with no collapse. On a
   ~375px viewport the tree claims its 14rem floor and the preview gets what's
   left — both unusable.
2. **Every content-in and re-parent gesture is native HTML5 drag-and-drop** —
   `draggable`, `ondragstart`/`ondragover`/`ondrop` in `Tree.svelte` and
   `App.svelte` (drag files in, drag to re-parent, drag onto a tab for §8.5).
   Mobile browsers don't make this touch-operable by default.
3. **No non-drag upload path exists.** There is no `<input type="file">`
   anywhere in the actual app — only in the throwaway `transport.html`
   harness, which the app doesn't share code with.
4. **Paste is `window.onpaste`**, fired by Ctrl/Cmd+V. There's no on-screen
   affordance that reaches the same code path.
5. **Rename/delete are keyboard shortcuts** (`onkeydown` in `Tree.svelte` /
   `App.svelte`) with no on-screen equivalent.
6. **One gesture is already mobile-shaped**: typing an 8-character share code
   to join (README, §7.2). This was designed with a phone in mind — "no need
   to transcribe a URL" — and is the thing to build outward from, not replace.

## Scope decision: reader-first, not full parity

Touch drag-and-drop (long-press-to-lift, autoscroll, drop-target feedback) is
a real, separate UI problem, and full parity buys nothing toward Q1/Q2/Q3 that
a narrower scope doesn't already get. Proposed split:

- **Must** — a mode 2 **reader** tab fully usable on a phone: join by code,
  single-pane tree navigation, tap to select and trigger fetch, all five
  preview states (§8.2) visible, tab switching. This is the half Q1 and Q3
  actually need — someone opening a shared link on their phone.
- **Should** — space creation and content-in from a phone, so the same person
  can be the writer under test, not only the reader. `NewSpace`'s dialog is
  already width-responsive (`max-width: min(26rem, calc(100vw - 2rem))`);
  what's missing is a non-drag way to get a file or pasted text in.
- **Won't, this pass** — touch drag-to-reparent, touch drag-to-move across
  space tabs (§8.5). Left desktop-only and tracked
  ([ISSUES I21](ISSUES.md#i21-no-touch-path-for-re-parent-or-cross-space-move--limit)),
  the same way §8.5 already narrows the drag-into-reader-tab gesture rather
  than trying to make every gesture symmetric.

## Build stages

### Stage A — Single-pane responsive shell

**Build:** a breakpoint that switches `.panes` from side-by-side to one pane
visible at a time below some width (~640px is a reasonable first guess — a
common phone/tablet split, not derived from anything in this codebase yet),
tree shown by default, with a one-tap way back from preview to tree. Layout
only — no gesture changes.

**Done when:** on a ~375px viewport the tree is fully legible and tappable,
selecting an item shows a full-width preview, and there's a one-tap path back.

**Status: done 2026-08-29.** `.panes` collapses at `max-width: 40rem` to a
single `1fr` column, showing `.pane-tree` until something is selected and
`.pane-preview` (with a back button, `.preview-back`) once it is — driven by
one existing bit of state, `selected`, no new tracking needed. The same touch
hit-area trick already used on `.twisty` was extended to the whole row under
`@media (pointer: coarse)`, decoupled from viewport width on purpose. Checked
headlessly at 375×667 with touch emulation: `.panes` renders as one `375px`
column, row hit-area grows from 24px to ~33.5px content + 8px padding each
side (desktop/mouse: unchanged 24px, no padding) — confirms the CSS actually
fires as designed, not that 33.5px+16px of overflow is *enough*; that still
wants a real device.

### Stage B — Touch-safe read path (mode 2 reader)

**Build:** confirm the join flow (share-code entry), tap-to-select, and tab
switching work on a touch browser with no hover-only affordance hiding
anything from touch.

**Done when:** a phone on its own network (cellular or hotspot) joins a share
code created on a desktop writer, browses the tree, and watches a blob arrive
live — the same two-device test the README already describes, with a phone as
one of the two devices instead of assumed. This is where Q1's phone-hotspot
evidence actually comes from.

**Status: not started.** Nothing here is peer-to-peer specific — the join
dialog, tap-to-select, and tab switching are all exercised by Stage A/C's
checks and depend on no code this plan hasn't already touched — but the
actual two-real-devices-over-a-real-network test needs hardware this
environment doesn't have. Unverified, same as Q1's TURN question.

### Stage C — Non-drag content-in (mode 1 / writer, on phone)

**Build:** an upload button wired to `<input type="file">`, feeding the same
path `App.svelte`'s drop handler uses; a "paste as file" action using the
async Clipboard API behind a tap, with the same name-from-first-line /
timestamp-fallback behaviour §8.4 already specifies for drag-paste.

**Done when:** creating a file from a phone with no drag available produces
the same event shape (`:kind`, `:name`, `:content`, `:parent`) as a desktop
drop.

**Not here:** touch re-parent. A file added this way lands under whatever
"selected directory" already means today — a tap-based "add here", not a
drop target.

**Status: done 2026-08-29.** An upload button opens a hidden
`<input type="file" multiple>` wired to the same `addFiles()` a drop calls; a
paste button calls `navigator.clipboard.readText()` behind the tap and hands
the result to the same `pasteText()` Ctrl+V uses. Both checked headlessly at
375×667 with touch emulation and clipboard permissions granted: the upload
button produced a file with the expected name and content, and the paste
button — with `hello from a phone` actually on the clipboard via
`navigator.clipboard.writeText()`, not simulated — produced a
`pasted-from-a-phone….txt` with matching bytes, previewable immediately.
Neither path is drag, and neither needed a keyboard. Cross-browser clipboard
permission behaviour (iOS Safari in particular) is still unverified — that
part needs a real device, as the Risks section below already says.

## Explicitly deferred, not solved

- Touch drag-to-reparent within the tree.
- Touch drag-to-move across space tabs (§8.5).
- Anything beyond one breakpoint — a binary phone/desktop split is enough to
  answer Q1 and Q3; tablet-intermediate sizing isn't.

## Risks

- **Touch target size.** `tokens.css`'s TUI-tight `--row: 1.5rem` (24px) is
  below common touch-target guidance (~44px). Stage A should widen the tappable
  hit-area on touch without changing desktop row height or `--row` itself —
  padding the hit target, not the token. Whether that's enough, or whether
  mobile needs its own density decision, is a real open question the stage 2
  design gate didn't cover (it closed on desktop density only); flag it there
  rather than deciding it here.
- **Clipboard and File API gaps across mobile browsers** (iOS Safari's async
  Clipboard permissions in particular) can't be fully checked outside a real
  device. Once Stage C is tested on-device, write what actually happened into
  [FINDINGS.md](FINDINGS.md) — same treatment as Q1's TURN question, not an
  assumption baked into the plan.
