<script lang="ts">
  import type { RendererProps } from './registry.js';

  let { bytes }: RendererProps = $props();

  /** Guard against decoding something enormous into the DOM. */
  const LIMIT = 512 * 1024;

  let text = $derived(
    bytes.length > LIMIT
      ? new TextDecoder().decode(bytes.subarray(0, LIMIT))
      : new TextDecoder().decode(bytes),
  );
  let truncated = $derived(bytes.length > LIMIT);
</script>

<pre class="preview-text">{text}</pre>
{#if truncated}
  <p class="state-detail">Truncated — showing the first {LIMIT / 1024} KB.</p>
{/if}
