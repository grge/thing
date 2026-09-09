<!--
  A text document, edited in place (§3.8).

  **Not a renderer.** The registry takes `bytes` and shows them; this has no
  bytes — a text document is live folded state, and the point is to *change*
  it. So it sits beside the renderers rather than among them.

  Two things here are not obvious.

  **Local text is authoritative while you type.** Rebuilding the textarea from
  the fold on every keystroke would fight the caret: the fold is a beat behind,
  so the value would snap back and the cursor jump to the end. Instead the local
  value leads, edits are written, and the fold is only allowed to overwrite it
  when someone *else* changed it — which is what `applied` tracks.

  **Writes are debounced into runs.** An element's id is its event's, so one
  event is one element: a character per keystroke would be an event per
  keystroke, each with a signature and a `deps` set. Pausing coalesces a burst
  of typing into one run, which is the granularity `fs/text.ts` is built around.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { readText, writeText, type Space, type Uuid } from '@thing/engine';
  import type { Client } from '../client.js';

  interface Props {
    client: Client;
    space: Space;
    spaceId: string;
    id: Uuid;
    writable: boolean;
  }

  const { client, space, spaceId, id, writable }: Props = $props();

  /** What the textarea shows. Leads the fold while typing. */
  let value = $state('');
  /** The last text this client wrote or accepted, to spot others' changes. */
  let applied = '';
  let area = $state<HTMLTextAreaElement | null>(null);
  let saving = $state(false);
  /** Who else is here, from the ephemeral channel (§10). */
  let others = $state<{ peer: string; at: number }[]>([]);

  /** How long a pause ends a run. Unmeasured; long enough to type through. */
  const FLUSH_MS = 400;
  /** How often to say where the caret is, and how long that stays true. */
  const CURSOR_MS = 2000;
  const CURSOR_TTL = 6000;

  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    timer = null;
    if (!writable) return;
    const wanted = value;
    saving = true;
    try {
      await writeText(space, id, wanted);
      applied = readText(space.state, id);
    } finally {
      saving = false;
    }
  }

  function onInput(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flush(), FLUSH_MS);
  }

  onMount(() => {
    value = readText(space.state, id);
    applied = value;

    const off = client.subscribe(() => {
      const now = readText(space.state, id);
      // **Only when someone else changed it.** If the fold matches what this
      // client last wrote, there is nothing to take; overwriting would undo
      // whatever has been typed since and move the caret.
      if (now !== applied && timer === null) {
        applied = now;
        value = now;
      }
      others = [...client.presence(spaceId)]
        .map(([peer, p]) => ({ peer, at: typeof p === 'object' && p !== null && 'at' in p
          ? Number((p as { at: unknown }).at) : 0 }))
        .filter((o) => Number.isFinite(o.at));
    });

    // Say where the caret is, repeatedly: presence expires on its own, so
    // saying it once would make this client vanish while still sitting here.
    const beat = setInterval(() => {
      if (area === null) return;
      client.announcePresence(spaceId, { at: area.selectionStart }, CURSOR_TTL);
    }, CURSOR_MS);

    return () => {
      off();
      clearInterval(beat);
      if (timer !== null) {
        clearTimeout(timer);
        void flush();
      }
    };
  });
</script>

<div class="editor">
  <textarea
    bind:this={area}
    bind:value
    oninput={onInput}
    onblur={() => void flush()}
    readonly={!writable}
    spellcheck="false"
    placeholder={writable ? 'Type here. Everyone with this space sees it.' : 'Read-only.'}
  ></textarea>
  <footer>
    <span class="muted">{value.length} characters</span>
    {#if saving}<span class="muted">saving…</span>{/if}
    {#if !writable}<span class="muted">read-only</span>{/if}
    {#each others as o (o.peer)}
      <!-- A cursor position is a fact about *now*, so it lives on the
           ephemeral channel and disappears when its sender does (§10). -->
      <span class="peer" title={o.peer}>someone at {o.at}</span>
    {/each}
  </footer>
</div>

<style>
  .editor { display: flex; flex-direction: column; height: 100%; min-height: 20rem; }
  textarea {
    flex: 1;
    width: 100%;
    resize: none;
    background: none;
    color: var(--ink);
    border: 1px solid var(--rule);
    padding: var(--space-3);
    font-family: var(--mono);
    font-size: 0.85rem;
    line-height: 1.6;
  }
  textarea:focus { outline: 1px solid var(--ink-muted); outline-offset: -1px; }
  footer {
    display: flex; gap: var(--space-3); align-items: center;
    padding: var(--space-1) 0; font-size: 0.75rem;
  }
  .muted { color: var(--ink-muted); }
  .peer { color: var(--ink); }
</style>
