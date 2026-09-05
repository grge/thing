<script lang="ts">
  /**
   * The file tree.
   *
   * Draws the folded state and nothing else — it takes entries and reports a
   * selection. Renaming and moving go back through `Space.write`, which is an
   * ordinary attribute write: the tree is derived, never stored.
   */
  import { hex, type Uuid } from '@thing/core';
  import { type Entry, list, move, remove, rename, restore, type Space } from '@thing/peer';
  import Icon from './Icon.svelte';

  interface Props {
    entries: Entry[];
    selected: Uuid | null;
    space: Space | null;
    writable: boolean;
    onselect: (id: Uuid) => void;
  }

  const { entries, selected, space, writable, onselect }: Props = $props();

  let expanded = $state(new Set<string>());
  let dragging = $state<string | null>(null);
  let dropTarget = $state<string | null>(null);

  function toggle(id: Uuid): void {
    const k = hex(id);
    const next = new Set(expanded);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    expanded = next;
  }

  function childrenOf(id: Uuid): Entry[] {
    return space === null ? [] : list(space.state, id);
  }

  async function doRename(entry: Entry): Promise<void> {
    if (space === null) return;
    const name = prompt('Rename', entry.name);
    if (name === null || name === '') return;
    await rename(space, entry.id, name);
  }

  async function onDrop(target: Entry): Promise<void> {
    dropTarget = null;
    if (space === null || dragging === null || !target.isFolder) return;
    const source = entries.find((e) => hex(e.id) === dragging);
    dragging = null;
    if (source === undefined || hex(source.id) === hex(target.id)) return;
    await move(space, source.id, target.id);
  }
</script>

{#snippet row(entry: Entry, depth: number)}
  <div
    class="row"
    class:selected={selected !== null && hex(selected) === hex(entry.id)}
    class:deleted={entry.deleted}
    class:drop={dropTarget === hex(entry.id)}
    style="padding-left: calc({depth} * var(--indent))"
    draggable={writable}
    role="treeitem"
    tabindex="0"
    aria-selected={selected !== null && hex(selected) === hex(entry.id)}
    onclick={() => onselect(entry.id)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') onselect(entry.id);
    }}
    ondragstart={() => (dragging = hex(entry.id))}
    ondragover={(e) => {
      if (entry.isFolder) {
        e.preventDefault();
        dropTarget = hex(entry.id);
      }
    }}
    ondragleave={() => (dropTarget = null)}
    ondrop={(e) => {
      e.preventDefault();
      void onDrop(entry);
    }}
  >
    {#if entry.isFolder}
      <button
        class="twisty"
        onclick={(e) => {
          e.stopPropagation();
          toggle(entry.id);
        }}
        aria-label={expanded.has(hex(entry.id)) ? 'Collapse' : 'Expand'}
        ><Icon name={expanded.has(hex(entry.id)) ? 'chevronDown' : 'chevronRight'} size={12} /></button
      >
    {:else}
      <span class="twisty-space"></span>
    {/if}

    <span class="name">{entry.name}</span>

    {#if entry.object.bodyRuleMissing !== undefined}
      <!-- §3.4: an unknown body rule costs one object, never the space. -->
      <span class="badge" title="No rule for {entry.object.bodyRuleMissing}">
        <Icon name="fileQuestion" size={12} />
      </span>
    {/if}

    {#if writable}
      <span class="row-actions">
        <button
          onclick={(e) => {
            e.stopPropagation();
            void doRename(entry);
          }}
          title="Rename"
          aria-label="Rename"><Icon name="pencil" size={12} /></button
        >
        {#if entry.deleted}
          <button
            onclick={(e) => {
              e.stopPropagation();
              if (space !== null) void restore(space, entry.id);
            }}
            title="Restore"
            aria-label="Restore"><Icon name="rotate" size={12} /></button
          >
        {:else}
          <button
            onclick={(e) => {
              e.stopPropagation();
              if (space !== null) void remove(space, entry.id);
            }}
            title="Delete"
            aria-label="Delete"><Icon name="trash" size={12} /></button
          >
        {/if}
      </span>
    {/if}
  </div>

  {#if entry.isFolder && expanded.has(hex(entry.id))}
    {#each childrenOf(entry.id) as child (hex(child.id))}
      {@render row(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

<div class="tree" role="tree">
  {#each entries as entry (hex(entry.id))}
    {@render row(entry, 0)}
  {:else}
    <p class="tree-empty">Nothing here yet. Drag files in.</p>
  {/each}
</div>
