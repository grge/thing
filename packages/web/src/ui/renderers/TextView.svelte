<!--
  Text.

  Decodes strictly: bytes that are not valid UTF-8 are not text, whatever the
  type claimed, and saying so beats showing replacement characters.
-->
<script lang="ts">
  import type { RendererProps } from './registry.js';

  const { bytes }: RendererProps = $props();

  const text = $derived.by(() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  });
</script>

{#if text === null}
  <p class="note">Not readable as text.</p>
{:else}
  <pre>{text}</pre>
{/if}

<style>
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-data);
    font-size: var(--text--1);
  }
  .note { color: var(--ink-muted); font-size: var(--text--1); }
</style>
