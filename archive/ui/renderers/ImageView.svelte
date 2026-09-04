<script lang="ts">
  import { downloadType } from '../../app/mime.js';
  import type { RendererProps } from './registry.js';

  let { bytes, type, name }: RendererProps = $props();

  // An object URL rather than a data URI: no base64 inflation, and it can be
  // revoked when the bytes change.
  let url = $state<string | null>(null);

  $effect(() => {
    const blob = new Blob([new Uint8Array(bytes)], { type: downloadType(type, name) });
    const made = URL.createObjectURL(blob);
    url = made;
    return () => URL.revokeObjectURL(made);
  });
</script>

{#if url !== null}
  <img class="render-image" src={url} alt={name ?? 'Image'} />
{/if}
