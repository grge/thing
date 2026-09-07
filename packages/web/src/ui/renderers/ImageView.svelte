<!--
  An image.

  The object URL is revoked when the bytes change or the component goes, so a
  long session does not leak one per file viewed.
-->
<script lang="ts">
  import type { RendererProps } from './registry.js';

  const { bytes, type, name }: RendererProps = $props();

  let url = $state<string | null>(null);

  $effect(() => {
    const next = URL.createObjectURL(
      new Blob([bytes as BlobPart], ...(type === null ? [] : [{ type }])),
    );
    url = next;
    return () => URL.revokeObjectURL(next);
  });
</script>

{#if url !== null}
  <img src={url} alt={name ?? ''} />
{/if}

<style>
  img { max-width: 100%; max-height: 100%; object-fit: contain; }
</style>
