# design

How decisions were reached, in more depth than a section of
`../ARCHITECTURE.md` can hold.

**Check the status line at the top of each.** These record what was true when
the decision was made, so one can be superseded without being wrong.

| | |
| --- | --- |
| `MAIN-SPACE.md` | a peer holds one space; everything else is a link inside it |
| `LOCATORS.md` | where a space is found, and why a stored link carries no address |
| `EQUIVOCATION.md` | the literature on one key, one writer — findings, not a proposal |
| `APPEND-POINTS.md` | how a writer's chain is keyed, so two processes never fork |
| `DEPS.md` | judging an event against the writer set its author had seen |
| `SEQUENCE.md` | the sequence rule, written as a specification first (§3.6) |
| `CAPABILITIES.md` | three keys, what a share link carries, what a new space defaults to |
| `CONNECTIONS.md` | a connection carries many spaces, not one |
| `ROOT-IN-CLEAR.md` | **not built** — the root is not encrypted, so a keyless peer can still evaluate membership |
| `WEB-CLIENT.md` | what the browser client is, and what shapes it |
| `CLIENTS.md` | **superseded in part** — append points removed two of its conclusions |

`proto/` holds the throwaway programs that checked a design before it was
built. They are kept because two of the three bugs in the `deps` work were
found there rather than in the implementation.
