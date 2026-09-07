<!--
  A file tree, expanding in place.

  Folders open below themselves rather than replacing the view: navigating away
  to see what is inside a folder loses the context of where it sits, which is
  the thing a tree is for.

  Recursive by snippet, over `FileEntry` from the engine's fold. Depth is
  passed down rather than computed, so indentation costs nothing.
-->
<script lang="ts">
  import { hex, isLink, list, type FileEntry, type State, type Uuid } from '@thing/engine';

  interface Props {
    state: State;
    expanded: Set<string>;
    selected: Uuid | null;
    onSelect: (e: FileEntry) => void;
    onToggle: (id: Uuid) => void;
  }

  const { state, expanded, selected, onSelect, onToggle }: Props = $props();

  const roots = $derived(list(state));

  /** A folder, or an object with children — either way it opens. */
  function opens(state: State, e: FileEntry): boolean {
    return e.isFolder || list(state, e.id).length > 0;
  }
</script>

{#snippet row(e: FileEntry, depth: number)}
  {@const key = hex(e.id)}
  {@const canOpen = opens(state, e)}
  {@const isOpen = expanded.has(key)}
  <li>
    <div class="row" class:selected={selected !== null && hex(selected) === key}>
      <button
        class="twisty"
        aria-label={isOpen ? 'Collapse' : 'Expand'}
        aria-expanded={canOpen ? isOpen : undefined}
        disabled={!canOpen}
        style="margin-left: calc({depth} * var(--space-3))"
        onclick={() => canOpen && onToggle(e.id)}
      >
        {canOpen ? (isOpen ? '▾' : '▸') : ''}
      </button>
      <button class="name" onclick={() => onSelect(e)}>
        {#if isLink(e)}<span class="glyph" title="a link to another space">→</span>{/if}
        {e.name}
      </button>
    </div>

    {#if canOpen && isOpen}
      <ul>
        {#each list(state, e.id) as child (hex(child.id))}
          {@render row(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<ul class="tree" role="tree">
  {#each roots as e (hex(e.id))}
    {@render row(e, 0)}
  {:else}
    <li class="empty">Empty.</li>
  {/each}
</ul>

<style>
  .tree, ul { list-style: none; padding: 0; margin: 0; }
  .row { display: flex; align-items: center; }
  .row:hover { background: var(--canvas-raised); }
  .row.selected { background: var(--canvas-sunken); }
  .twisty {
    background: none; border: none; cursor: pointer;
    color: var(--ink-faint); font: inherit;
    width: 1.25rem; padding: 0; flex: none;
  }
  .twisty:disabled { cursor: default; }
  .name {
    flex: 1; text-align: left;
    background: none; border: none; color: inherit; font: inherit;
    padding: var(--space-1) var(--space-1);
    cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .glyph { color: var(--ink-faint); margin-right: var(--space-1); }
  .empty { color: var(--ink-muted); padding: var(--space-2); }
</style>
