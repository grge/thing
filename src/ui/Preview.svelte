<script lang="ts">
  import type { Link, ObjectState } from '../fold/index.js';
  import { hex } from '../fold/index.js';
  import { codeForSpace } from '../app/address.js';
  import { downloadType, effectiveType, parseType } from '../app/mime.js';
  import Icon from './Icon.svelte';
  import { rendererFor } from './renderers/registry.js';
  import './renderers/index.js';

  interface Props {
    obj: ObjectState | null;
    /** Follow a link to its target space. Absent in contexts that cannot. */
    onFollow?: (link: Link) => void;
    path: string;
    /** Resolved blob bytes, or null when this peer does not hold it. */
    blob: Uint8Array | null;
    loading: boolean;
    childCount: number;
    /** Chunks received, when a peer is sending this blob (§8.2 `fetching`). */
    progress?: { got: number; total: number } | null;
    /** No connected peer holds it — NOBLOB answered (§8.2 `unavailable`). */
    unavailable?: boolean;
    /**
     * Return to the tree pane. Only rendered by CSS on the single-pane
     * layout (docs/MOBILE.md, stage A) — on the desktop two-pane layout the
     * tree is already visible, so there is nothing to go back to.
     */
    onBack?: () => void;
  }

  let {
    obj,
    onFollow,
    path,
    blob,
    loading,
    childCount,
    progress = null,
    unavailable = false,
    onBack,
  }: Props = $props();

  /**
   * The object's format (§4.7): what it asserts, else what its name suggests.
   * Never guessed from content — a todo list and a note can hold identical
   * markdown bytes, so only the assertion distinguishes them (FINDINGS F11).
   */
  let type = $derived(effectiveType(obj?.type ?? null, obj?.name ?? null));

  /**
   * The target's short code, derived rather than stored so it cannot drift from
   * the identity it names. Async, hence an effect.
   */
  let linkCode = $state<string | null>(null);
  $effect(() => {
    const link = obj?.link ?? null;
    if (link === null) {
      linkCode = null;
      return;
    }
    let stale = false;
    void codeForSpace(hex(link.space)).then((c) => {
      if (!stale) linkCode = c;
    });
    return () => {
      stale = true;
    };
  });
  let renderer = $derived(rendererFor(type));

  function size(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Copy and download exist because the design system asks that ordinary web
   * powers be preserved — copy, export, leave. They are available whenever the
   * blob is actually held, which is the same condition as `rendered` or
   * `not-renderable`.
   */
  let copied = $state(false);
  let copyFailed = $state(false);

  /** Copy is offered only for text-ish formats, where it means something. */
  let copyable = $derived.by(() => {
    const t = parseType(type);
    return blob !== null && t !== null && (t.top === 'text' || t.suffix === 'json' || t.essence === 'application/json');
  });

  async function copyText(): Promise<void> {
    if (blob === null || !copyable) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(blob));
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
    // Copy into a fresh buffer: the stored bytes may be a view onto a larger
    // ArrayBuffer, which Blob would otherwise serialise in full.
    const mime = downloadType(type, obj.name);
    const url = URL.createObjectURL(new Blob([new Uint8Array(blob)], { type: mime }));
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
    if (blob !== null) return renderer !== null ? 'rendered' : 'not-renderable';
    // Distinct on purpose: `fetching` means a peer is sending it, `unavailable`
    // means none has it. Collapsing them hides what question 1 measures (§8.2).
    if (progress !== null || loading) return 'fetching';
    if (unavailable) return 'unavailable';
    return 'fetching';
  });
</script>

<div class="pane-preview">
  <div class="pane-head">
    <span class="pane-head-left">
      <button
        type="button"
        class="preview-back"
        title="Back to files"
        aria-label="Back to files"
        onclick={() => onBack?.()}
      ><Icon name="arrowLeft" size={12} /></button>
      <span>preview</span>
    </span>
    <span>{type ?? obj?.kind ?? ''}</span>
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
          <span>{size(blob.length)}</span>
        {/if}
        {#if obj.deleted}
          <span>deleted</span>
        {/if}
      </div>

      {#if obj.link !== null}
        <!--
          A link is identity, not a location, so what is shown is the target's
          code — the same derived, typeable handle the share bar shows — rather
          than the 64-character key it derives from (DESIGN.md §4.3).
        -->
        <div class="preview-link">
          <Icon name="link" size={12} />
          <code>{linkCode ?? '········'}</code>
          {#if obj.link.object !== undefined}
            <span class="preview-link-deep" title="Points at one object inside that space">
              /{hex(obj.link.object).slice(0, 6)}…
            </span>
          {/if}
          <button type="button" onclick={() => onFollow?.(obj!.link!)}>Open</button>
        </div>
      {/if}

      {#if blob !== null}
        <div class="preview-actions">
          {#if copyable}
            <button type="button" onclick={copyText}>
              <Icon name="copy" size={12} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          {/if}
          <button type="button" onclick={download}>
            <Icon name="download" size={12} />
            Download
          </button>
          {#if copyFailed}
            <span class="action-error">Clipboard unavailable</span>
          {/if}
        </div>
      {/if}
    </div>

    <div class="preview-body" class:is-filled={previewState === 'rendered' && renderer?.fills === true}>
      {#if previewState === 'rendered' && renderer !== null && blob !== null}
        <renderer.component bytes={blob} {type} name={obj.name} />
      {:else if previewState === 'no-content'}
        {#if obj.link !== null}
          <!--
            A portal holds no blob, but "no content" describes an empty file and
            reads as a fault. What this object is *for* is the link, so say that
            instead (DESIGN.md §2.1).
          -->
          <div class="state" data-state="no-content">A link.</div>
          <div class="state-detail">
            {obj.link.object === undefined
              ? 'Points at another space. Open to go there.'
              : 'Points at one object in another space. Open to go there.'}
          </div>
        {:else}
          <div class="state" data-state="no-content">No content.</div>
          <div class="state-detail">
            {obj.kind === 'dir' ? `A directory with ${childCount} children.` : 'An object holding no blob.'}
          </div>
        {/if}
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
          No renderer for {type ?? 'this format'}.
        </div>
        <div class="state-detail">
          The content is held locally — download it to open elsewhere.
        </div>
      {/if}
    </div>
  {/if}
</div>
