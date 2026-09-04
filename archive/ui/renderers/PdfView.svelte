<script lang="ts">
  import type { RendererProps } from './registry.js';

  let { bytes, name }: RendererProps = $props();

  /**
   * Hands the bytes to the browser's own PDF viewer. Pagination, zoom, search,
   * text selection and printing all come free, and nothing is added to the
   * bundle — PDF.js would be ~350KB gzipped, which is more than the whole app.
   *
   * What this cannot do is produce a thumbnail, so the canvas may need PDF.js
   * later. That would be a lazy import behind this same registry entry, paid
   * for only by people who open a PDF.
   */
  let url = $state<string | null>(null);

  $effect(() => {
    const made = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    );
    url = made;
    return () => URL.revokeObjectURL(made);
  });

  /**
   * `<embed>` fires no load or error event we can rely on across browsers, and
   * a blocked `object-src` or a mobile browser that refuses inline PDFs both
   * render as a silent blank. So the fallback is always present underneath and
   * simply covered when the viewer paints.
   */
  let showFallback = $state(false);
  $effect(() => {
    url;
    showFallback = false;
    // If nothing has painted shortly after mount, assume it will not.
    const t = setTimeout(() => (showFallback = true), 1200);
    return () => clearTimeout(t);
  });

  function open(): void {
    if (url !== null) window.open(url, '_blank', 'noopener');
  }
</script>

<div class="render-pdf">
  {#if url !== null}
    <embed src={url} type="application/pdf" title={name ?? 'PDF'} />
  {/if}

  {#if showFallback}
    <div class="render-pdf-fallback">
      <p class="state">Your browser did not display this PDF inline.</p>
      <p class="state-detail">
        Some browsers refuse inline PDFs, and a strict <code>object-src</code>
        policy blocks them.
      </p>
      <button type="button" onclick={open}>Open in a new tab</button>
    </div>
  {/if}
</div>
