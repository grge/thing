<!--
  A file tree, expanding in place.

  Folders open below themselves rather than replacing the view: navigating away
  to see what is inside a folder loses the context of where it sits, which is
  the thing a tree is for.

  Recursive by snippet, over `FileEntry` from the engine's fold. Depth is
  passed down rather than computed, so indentation costs nothing.
-->
<script lang="ts">
  import {
    hex,
    isLink,
    list,
    targetOf,
    type FileEntry,
    type PublicKey,
    type State,
    type Uuid,
  } from '@thing/engine';
  import Icon from './Icon.svelte';

  interface Props {
    state: State;
    /**
     * The state of a linked space, if this client holds it.
     *
     * A link expands like a folder — showing what is *inside* the space it
     * points at — which needs that space's fold. Absent means not held yet, so
     * the row offers to open it instead.
     */
    linked: (target: PublicKey) => State | null;
    /** The id of the space `state` belongs to. */
    spaceId: string;
    expanded: Set<string>;
    writable: boolean;
    /** Which row a drag is currently over, by path. */
    dropTarget: string | null;
    /** The currently selected row's path, if any. */
    selectedPath: string | null;
    /** The entry, and the space it came from — which is not the tab's space
     * once a link has been expanded. */
    onSelect: (e: FileEntry, fromSpace: string, path: string) => void;
    /** Keyed by *path*, not id: the same space reached twice is two rows. */
    onToggle: (path: string) => void;
    /** Fetch a linked space so it can be expanded in place. */
    onExpandLink: (e: FileEntry, target: PublicKey) => void;
    onDragStart: (id: Uuid) => void;
    onDragOver: (path: string | null) => void;
    onDropOn: (id: Uuid) => void;
  }

  const {
    state,
    linked,
    spaceId,
    expanded,
    writable,
    dropTarget,
    selectedPath,
    onSelect,
    onToggle,
    onExpandLink,
    onDragStart,
    onDragOver,
    onDropOn,
  }: Props = $props();

  const roots = $derived(list(state));

  /** A folder, or an object with children — either way it opens. */
  function opens(state: State, e: FileEntry): boolean {
    return e.isFolder || list(state, e.id).length > 0;
  }
</script>

{#snippet row(e: FileEntry, depth: number, from: State, fromId: string, parentPath: string)}
  {@const key = hex(e.id)}
  {@const path = `${parentPath}/${key}`}
  {@const target = isLink(e) ? targetOf(from, e.id) : null}
  {@const inside = target === null ? null : linked(target)}
  {@const canOpen = target !== null || opens(from, e)}
  {@const isOpen = expanded.has(path)}
  <li>
    <div
      class="row"
      class:selected={selectedPath === path}
      class:drop={dropTarget === path}
      draggable={writable}
      role="treeitem"
      tabindex="-1"
      aria-selected={selectedPath === path}
      ondragstart={(event) => {
        // A row carries its own id, so a drop elsewhere knows what moved.
        event.dataTransfer?.setData('text/plain', key);
        onDragStart(e.id);
      }}
      ondragover={(event) => {
        if (!writable) return;
        // Only claim the drag when it is a row being moved: a file coming from
        // the desktop should fall through to the whole-space handler.
        if (event.dataTransfer?.types.includes('Files') === true) return;
        event.preventDefault();
        event.stopPropagation();
        onDragOver(path);
      }}
      ondragleave={() => onDragOver(null)}
      ondrop={(event) => {
        if (event.dataTransfer?.types.includes('Files') === true) return;
        event.preventDefault();
        event.stopPropagation();
        onDropOn(e.id);
      }}
    >
      <button
        class="twisty"
        aria-label={isOpen ? 'Collapse' : 'Expand'}
        aria-expanded={canOpen ? isOpen : undefined}
        disabled={!canOpen}
        style="margin-left: calc({depth} * var(--space-3))"
        onclick={() => {
          if (!canOpen) return;
          // A link this client does not hold yet has nothing to show, so
          // expanding it fetches first.
          if (target !== null && inside === null) onExpandLink(e, target);
          onToggle(path);
        }}
      >
        {canOpen ? (isOpen ? '▾' : '▸') : ''}
      </button>
      <button class="name" onclick={() => onSelect(e, fromId, path)}>
        <span class="glyph">
          {#if target !== null}
            <Icon name="link" />
          {:else if canOpen}
            <Icon name="folder" />
          {/if}
        </span>
        {e.name}
      </button>
    </div>

    {#if canOpen && isOpen}
      <ul>
        {#if target !== null}
          {#if inside === null}
            <li class="empty" style="padding-left: calc({depth + 1} * var(--space-3))">
              Fetching…
            </li>
          {:else}
            {#each list(inside) as child (hex(child.id))}
              {@render row(child, depth + 1, inside, hex(target), path)}
            {:else}
              <li class="empty" style="padding-left: calc({depth + 1} * var(--space-3))">
                Empty, or not yet synced.
              </li>
            {/each}
          {/if}
        {:else}
          {#each list(from, e.id) as child (hex(child.id))}
            {@render row(child, depth + 1, from, fromId, path)}
          {/each}
        {/if}
      </ul>
    {/if}
  </li>
{/snippet}

<ul class="tree" role="tree">
  {#each roots as e (hex(e.id))}
    {@render row(e, 0, state, spaceId, '')}
  {:else}
    <li class="empty">Empty.</li>
  {/each}
</ul>

<style>
  .tree, ul { list-style: none; padding: 0; margin: 0; }
  .row { display: flex; align-items: center; }
  .row:hover { background: var(--canvas-raised); }
  .row.selected { background: var(--canvas-sunken); }
  .row.drop { outline: 1px solid var(--action); outline-offset: -1px; }
  .twisty {
    background: none; border: none; cursor: pointer;
    color: var(--ink-faint); font: inherit;
    width: 1.25rem; padding: 0; flex: none;
  }
  .twisty:disabled { cursor: default; }
  .name {
    display: flex; align-items: center;
    flex: 1; text-align: left;
    background: none; border: none; color: inherit; font: inherit;
    padding: var(--space-1) var(--space-1);
    cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .glyph {
    display: inline-flex;
    align-items: center;
    width: 1rem;
    color: var(--ink-faint);
    margin-right: var(--space-1);
    flex: none;
  }
  .empty { color: var(--ink-muted); padding: var(--space-2); }
</style>
