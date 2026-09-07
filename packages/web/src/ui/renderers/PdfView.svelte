<!--
  A PDF, in the browser's own viewer.

  `fills` in the registry, because the viewer scrolls itself and nesting it in
  a scroller gives two scrollbars that fight.
-->
<script lang="ts">
  import type { RendererProps } from './registry.js';

  const { bytes, name }: RendererProps = $props();

  let url = $state<string | null>(null);

  $effect(() => {
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    url = next;
    return () => URL.revokeObjectURL(next);
  });
</script>

{#if url !== null}
  <iframe src={url} title={name ?? 'PDF'}></iframe>
{/if}

<style>
  iframe { width: 100%; height: 100%; border: none; }
</style>
