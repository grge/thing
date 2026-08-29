<script lang="ts">
  import type { TreeNode } from '../app/tree.js';

  interface Props {
    nodes: TreeNode[];
    expanded: Set<string>;
    selected: string | null;
    writable: boolean;
    dropTarget: string | null;
    onSelect: (key: string) => void;
    onToggle: (key: string) => void;
    onDragStart: (key: string) => void;
    onDropOn: (key: string) => void;
    onDragOver: (key: string | null) => void;
  }

  let {
    nodes,
    expanded,
    selected,
    writable,
    dropTarget,
    onSelect,
    onToggle,
    onDragStart,
    onDropOn,
    onDragOver,
  }: Props = $props();

  /** Children are only counted for the meta column; sizes come from blobs. */
  function meta(n: TreeNode): string {
    if (n.obj.kind === 'dir') return String(n.children.length);
    return n.obj.content === null ? '—' : '·';
  }
</script>

{#snippet row(n: TreeNode)}
  {@const isDir = n.children.length > 0 || n.obj.kind === 'dir'}
  <li>
    <div
      class="row"
      class:is-deleted={n.obj.deleted}
      class:is-drop-target={dropTarget === n.key}
      role="treeitem"
      tabindex="-1"
      aria-selected={selected === n.key}
      aria-expanded={isDir ? expanded.has(n.key) : undefined}
      data-kind={n.obj.kind ?? 'file'}
      style="padding-left: calc({n.depth} * var(--indent))"
      draggable={writable}
      onclick={() => onSelect(n.key)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(n.key);
        }
      }}
      ondragstart={() => onDragStart(n.key)}
      ondragover={(e) => {
        if (!writable) return;
        e.preventDefault();
        onDragOver(n.key);
      }}
      ondragleave={() => onDragOver(null)}
      ondrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropOn(n.key);
      }}
    >
      <span
        class="twisty"
        data-leaf={!isDir}
        role="button"
        tabindex="-1"
        aria-label={expanded.has(n.key) ? 'Collapse' : 'Expand'}
        onclick={(e) => {
          e.stopPropagation();
          if (isDir) onToggle(n.key);
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            if (isDir) onToggle(n.key);
          }
        }}
      >{isDir ? (expanded.has(n.key) ? '▾' : '▸') : '·'}</span>

      <span class="row-name">{n.obj.name ?? '(unnamed)'}</span>

      {#if n.obj.cycleBroken}
        <span class="badge" title="Re-parented to root to break a cycle (§4.1)">cycle</span>
      {/if}

      <span class="row-meta">{meta(n)}</span>
    </div>

    {#if isDir && expanded.has(n.key) && n.children.length > 0}
      <ul role="group">
        {#each n.children as child (child.key)}
          {@render row(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<ul class="tree" role="tree" aria-label="Files">
  {#each nodes as n (n.key)}
    {@render row(n)}
  {/each}
</ul>
