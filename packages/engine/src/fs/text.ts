/**
 * A text document two people can edit at once (§3.8).
 *
 * **This is the central bet, used.** §3.8 claims every attribute merges by a
 * fixed, universally known rule, so any client can compute any space's state
 * without the application that wrote it. The sequence rule
 * (`design/SEQUENCE.md`) was built to test that on the hardest case — an
 * ordered list two writers edit concurrently — and nothing had used it. This is
 * the smallest thing that does.
 *
 * A text document is an ordinary object whose `:kind` is `text`, so its body
 * folds by the sequence rule. A client that has never heard of text still folds
 * the tree and the names (§3.1); it simply cannot show the contents. That
 * tiering is what the universal fold is *for*.
 *
 * **Runs, not characters.** An element's id derives from the event that created
 * it (`elementIdOf`), so one event is one element. A character per element
 * means an event per keystroke — a signature, a `deps` set and a chain position
 * each — which is the cost this design is most exposed to. So an insertion of
 * contiguous text is one element holding a run.
 *
 * The price is worth stating rather than discovering: **concurrent edits inside
 * one run resolve at run granularity.** Two people typing at different points
 * interleave exactly. Two typing into the same run produce two elements
 * anchored at the same place, ordered by the rule's tiebreak, rather than
 * merging character by character — splitting a run would need an element id
 * that the event creating it cannot supply.
 */
import { hex, type State, type Uuid } from '../core/index.js';
import { type ElementId, ordered, type SeqAcc, type SeqOp } from '../core/sequence.js';
import { ROOT } from '../core/event.js';
import type { Space } from '../space.js';
import { newUuid } from './files.js';

const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();

/**
 * The `:kind` a text document carries.
 *
 * **`sequence`, because `:kind` names the rule** (§4.2) — it says what the body
 * *is*, and the body is an ordered list of runs. An invented kind like `text`
 * resolves to no rule at all, and the fold marks the object unreadable rather
 * than guessing, which is §3.1's tiering doing its job: a client without the
 * rule can still see the name and the tree.
 *
 * That the kind is the rule is also what makes this shareable. Any client
 * holding the sequence rule can edit this document without knowing what wrote
 * it — the whole of §3.8's claim.
 */
export const TEXT_KIND = 'sequence';

/** Create an empty text document. */
export async function makeText(space: Space, name: string, parent: Uuid = ROOT): Promise<Uuid> {
  const id = newUuid();
  await space.write(id, ':name', UTF8.encode(name));
  await space.write(id, ':parent', parent);
  await space.write(id, ':kind', UTF8.encode(TEXT_KIND));
  return id;
}

/** Whether an object is a text document. */
export function isText(state: State, id: Uuid): boolean {
  return state.objects.get(hex(id))?.attrs.get(':kind')?.value === TEXT_KIND;
}

/** One element of a document: a run of text, and what an edit anchors to. */
export interface TextRun {
  readonly id: ElementId;
  readonly text: string;
}

/**
 * The document's runs, in order.
 *
 * An editor needs the ids as well as the text — an insertion anchors *after* an
 * element and a deletion names one — so this is what editing works from, and
 * `readText` is the convenience over it.
 */
export function runs(state: State, id: Uuid): TextRun[] {
  const body = state.objects.get(hex(id))?.body;
  if (body === undefined || body.rule !== 'sequence') return [];
  return ordered(body.acc as SeqAcc).map((n) => ({ id: n.id, text: FROM_UTF8.decode(n.body) }));
}

/** The document as one string. */
export function readText(state: State, id: Uuid): string {
  return runs(state, id)
    .map((r) => r.text)
    .join('');
}

/**
 * Turn a wanted text into the operations that would produce it.
 *
 * **A diff against runs, not characters**, because runs are what elements are.
 * A common prefix and suffix are found, everything between is deleted whole,
 * and the new middle is inserted as one run — which is why typing into the
 * middle of a paragraph rewrites that paragraph's element rather than editing
 * it in place.
 *
 * Returns nothing when the text is unchanged, so a caller may run this on every
 * keystroke without writing an event for each.
 */
export function edit(state: State, id: Uuid, wanted: string): SeqOp[] {
  const current = runs(state, id);
  const text = current.map((r) => r.text).join('');
  if (text === wanted) return [];

  // How many *runs* are untouched at each end. Whole runs, because an element
  // is the unit that can be kept: a run whose text changed at all is replaced.
  let head = 0;
  while (
    head < current.length &&
    wanted.startsWith(current.slice(0, head + 1).map((r) => r.text).join(''))
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < current.length - head &&
    wanted.endsWith(current.slice(current.length - tail - 1).map((r) => r.text).join(''))
  ) {
    tail += 1;
  }

  const kept = current.slice(0, head);
  const dropped = current.slice(head, current.length - tail);
  const after = current.slice(current.length - tail);

  const prefix = kept.map((r) => r.text).join('');
  const suffix = after.map((r) => r.text).join('');
  const middle = wanted.slice(prefix.length, wanted.length - suffix.length);

  const ops: SeqOp[] = dropped.map((r) => ({ op: 'del' as const, target: r.id }));
  if (middle !== '') {
    // Anchored after the last kept run, or at the start when there is none.
    ops.push({
      op: 'ins',
      after: kept.length === 0 ? null : kept[kept.length - 1]!.id,
      body: UTF8.encode(middle),
    });
  }
  return ops;
}

/**
 * Apply an edit, writing one event per operation.
 *
 * Each operation is its own event because each becomes its own element, and an
 * element's id *is* the event's (`elementIdOf`). Batching them into one event
 * would give them one id between them.
 */
export async function writeText(space: Space, id: Uuid, wanted: string): Promise<number> {
  const ops = edit(space.state, id, wanted);
  const { sequence } = await import('../core/sequence.js');
  for (const op of ops) {
    await space.write(id, ':body', sequence.codec.encode(op));
  }
  return ops.length;
}
