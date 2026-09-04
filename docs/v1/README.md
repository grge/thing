# v1 — archived

**Superseded by [../ARCHITECTURE.md](../ARCHITECTURE.md), which describes a
different system.** Nothing here is current. It is kept because the reasoning is
worth preserving and because several arguments in it were expensive to reach.

v0 was a working proof of concept: an append-only event log replicated between
browser peers over WebRTC, folded into a filesystem. v1 was an in-progress
incremental evolution of it — signing, addressing, links — carried out by editing
v0's source rather than restarting.

**What the rewrite is instead.** ARCHITECTURE.md keeps the substrate almost
unchanged and reorganises everything above it: one universal fold driven by
declared merge rules, spaces that carry a type, applications shipped as views
over the network, and permission and privacy as two separate per-space keys. The
filesystem stops being the model and becomes one type among several.

## What is here

| Doc | What it was |
|---|---|
| [DESIGN.md](DESIGN.md) | The standing description of v0/v1 — model, addressing, transport, crypto |
| [V1.md](V1.md) | Why v1 was not a rewrite, and the sequence it went in |
| [ISSUES.md](ISSUES.md) | What was wrong at the time. Mutable |
| [FINDINGS.md](FINDINGS.md) | Evidence gathered while building. Append-only |
| [NEXT.md](NEXT.md) | Product reasoning behind the design. Pre-spec |
| [ADDRESSING.md](ADDRESSING.md) | The addressing argument in full |
| [RESOLUTION.md](RESOLUTION.md) | Hubs, locators and gossip — proposal |
| [SPACES.md](SPACES.md) | Space types and applications-as-spaces — the direction that became the rewrite |
| [../v0/](../v0/) | The proof of concept's own spec, plan and mobile notes |

## What carried forward, and what did not

Read in this order if you are looking for why something in ARCHITECTURE.md is
the way it is.

**Carried forward largely intact.** The event envelope, per-writer hash chains,
version vectors, the total fold, blob transfer, and the identity model (a space
is an Ed25519 keypair; locators are separate, plural and disposable). DESIGN.md
§1–§7 and ADDRESSING.md are the arguments behind those, and they are still the
best statement of them.

**Carried forward with the reasoning changed.** RESOLUTION.md worked out
announce-on-serve, one-hop relaying and the three-way empty answer in far more
detail than ARCHITECTURE.md §5.3 restates. SPACES.md is the direct ancestor of
the rewrite and states the universal-fold bet, including why it might fail.

**Superseded outright.** V1.md's sequence, ISSUES.md's triage, and DESIGN.md's
single-writer social model. The rewrite is not reached by editing v0's source,
so "v1 is not a rewrite" no longer describes the plan.

**Reversed.** DESIGN.md §9 leans toward interlinked single-writer spaces
specifically to avoid CRDTs and compaction; ARCHITECTURE.md takes multi-writer
spaces and a CRDT-per-attribute fold as the direction. NEXT.md's compaction
analysis stands, and its conclusion — only a writer may compact its own chain —
is preserved in ARCHITECTURE.md §9.3.

## Note on cross-references

These documents cite each other, and cite v0/SPEC.md, by section number. Those
references are internally consistent and still resolve within this directory.
References to ARCHITECTURE.md do not exist here: it was written after, and it
deliberately carries no dependency on any of this.
