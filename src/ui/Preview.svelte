<script lang="ts">
  import type { ObjectState } from '../fold/index.js';
  import { hex } from '../fold/index.js';

  interface Props {
    obj: ObjectState | null;
    path: string;
    /** Resolved blob, or null when this peer does not hold it. */
    blob: { bytes: Uint8Array; mime: string } | null;
    loading: boolean;
    childCount: number;
    /** Chunks received, when a peer is sending this blob (§8.2 `fetching`). */
    progress?: { got: number; total: number } | null;
    /** No connected peer holds it — NOBLOB answered (§8.2 `unavailable`). */
    unavailable?: boolean;
  }

  let {
    obj,
    path,
    blob,
    loading,
    childCount,
    progress = null,
    unavailable = false,
  }: Props = $props();

  const TEXT_LIMIT = 256 * 1024;

  function isText(mime: string): boolean {
    return mime.startsWith('text/') || mime === 'application/json' || mime === '';
  }

  function size(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  let text = $derived.by(() => {
    if (blob === null || !isText(blob.mime)) return null;
    if (blob.bytes.length > TEXT_LIMIT) return null;
    return new TextDecoder().decode(blob.bytes);
  });

  /**
   * Copy and download exist because the design system asks that ordinary web
   * powers be preserved — copy, export, leave. They are available whenever the
   * blob is actually held, which is the same condition as `rendered` or
   * `not-renderable`.
   */
  let copied = $state(false);
  let copyFailed = $state(false);

  async function copyText(): Promise<void> {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      copyFailed = false;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard access can be refused; say so rather than failing silently.
      copyFailed = true;
      setTimeout(() => (copyFailed = false), 3000);
    }
  }

  function download(): void {
    if (blob === null || obj === null) return;
    const type = blob.mime === '' ? 'application/octet-stream' : blob.mime;
    // Copy into a fresh buffer: the stored bytes may be a view onto a larger
    // ArrayBuffer, which Blob would otherwise serialise in full.
    const url = URL.createObjectURL(new Blob([new Uint8Array(blob.bytes)], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = obj.name ?? 'untitled';
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * The five states of §8.2. `fetching` and `unavailable` are deliberately
   * distinct: in mode 2 they mean quite different things, and collapsing them
   * would hide the failure POC question 1 exists to measure.
   */
  let previewState = $derived.by(() => {
    if (obj === null) return 'empty';
    if (obj.content === null) return 'no-content';
    if (blob !== null) return text !== null ? 'rendered' : 'not-renderable';
    // Distinct on purpose: `fetching` means a peer is sending it, `unavailable`
    // means none has it. Collapsing them hides what question 1 measures (§8.2).
    if (progress !== null || loading) return 'fetching';
    if (unavailable) return 'unavailable';
    return 'fetching';
  });
</script>

<div class="pane-preview">
  <div class="pane-head">
    <span>preview</span>
    <span>{blob?.mime || (obj?.kind ?? '')}</span>
  </div>

  {#if obj === null}
    <div class="preview-body">
      <div class="state" data-state="empty">Nothing selected.</div>
      <div class="state-detail">Select an object in the tree.</div>
    </div>
  {:else}
    <div class="preview-head">
      <div class="preview-name">{obj.name ?? '(unnamed)'}</div>
      <div class="preview-facts">
        <span>{path}</span>
        {#if obj.content !== null}
          <span>{hex(obj.content).slice(0, 8)}…{hex(obj.content).slice(-6)}</span>
        {/if}
        {#if blob !== null}
          <span>{size(blob.bytes.length)}</span>
        {/if}
        {#if obj.deleted}
          <span>deleted</span>
        {/if}
      </div>

      {#if blob !== null}
        <div class="preview-actions">
          {#if text !== null}
            <button type="button" onclick={copyText}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          {/if}
          <button type="button" onclick={download}>Download</button>
          {#if copyFailed}
            <span class="action-error">Clipboard unavailable</span>
          {/if}
        </div>
      {/if}
    </div>

    <div class="preview-body">
      {#if previewState === 'rendered'}
        <pre class="preview-text">{text}</pre>
      {:else if previewState === 'no-content'}
        <div class="state" data-state="no-content">No content.</div>
        <div class="state-detail">
          {obj.kind === 'dir' ? `A directory with ${childCount} children.` : 'An object holding no blob.'}
        </div>
      {:else if previewState === 'fetching'}
        <div class="state" data-state="fetching">Fetching…</div>
        {#if progress !== null}
          <div class="state-detail">chunk {progress.got} / {progress.total}</div>
          <span class="progress">
            <span style="width: {progress.total === 0 ? 0 : (progress.got / progress.total) * 100}%"></span>
          </span>
        {:else}
          <div class="state-detail">Requested from peers.</div>
        {/if}
      {:else if previewState === 'unavailable'}
        <div class="state" data-state="unavailable">
          Unavailable — no connected peer holds this blob.
        </div>
        <div class="state-detail">Metadata is complete; only the content is missing (§6.1).</div>
      {:else}
        <div class="state" data-state="not-renderable">
          No renderer for {blob?.mime || 'this type'}.
        </div>
        <div class="state-detail">The blob is held locally.</div>
      {/if}
    </div>
  {/if}
</div>
