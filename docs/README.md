# docs

Two kinds of document, kept apart because they are read for different reasons
and go stale in different ways.

## `ARCHITECTURE.md`

The design. One document, section-numbered, and **everything else defers to
it** — code comments cite its sections, and where another document disagrees
with it, it is the other document that is wrong. Each section carries a mark
saying how settled it is: **Proven** (built and working), **Decided** (settled
on paper, no code), **Open** (genuinely unresolved).

## `design/` — how decisions were reached

Working through a problem in more depth than a section of `ARCHITECTURE.md`
can hold. Written to *reach* a decision; kept because the reasoning is what
justifies the shape, and because a conclusion without its argument is a thing
nobody can safely revisit.

**These do not go stale in the ordinary way.** A design record describes what
was true when the decision was made, so one may be superseded without being
wrong — `CLIENTS.md` is, and says so at the top. Check the status line before
treating one as current.

## `working/` — live

Things that change as the work does.

| | |
| --- | --- |
| `PLAN.md` | build order, and what each completed stage cost |
| `OPEN.md` | questions the design has not answered |
| `LEARNINGS.md` | what building it taught, mostly about how it goes wrong |
| `WEB-NEXT.md` | held for later, for the web client |

## `archive/`

Two earlier attempts, `v0` and `v1`, superseded by `ARCHITECTURE.md`. Kept
because they contain measurements and scope decisions that were made once and
should not be made again — `v0/MOBILE.md` is still cited. Nothing here is
current.
