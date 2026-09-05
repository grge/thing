<script lang="ts">
  /**
   * What one object is.
   *
   * The interesting case is a file whose *metadata* is here and whose bytes are
   * not: events replicate to everyone, blobs are pulled by whoever wants them
   * (§2.4). So this can know a file's name, kind and size while having nothing
   * to show — and says so, rather than looking broken.
   */
  import { hex, type Uuid } from '@thing/core';
  import { contentHash, entry, isTextual, read, type Space } from '@thing/peer';
  import { onMount } from 'svelte';
  import type { Client } from '../client.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    spaceId: string;
    space: Space;
    id: Uuid;
    /** From the same source the footer uses, so the two cannot disagree. */
    peerCount: number;
  }

  const { client, spaceId, space, id, peerCount }: Props = $props();

  /**
   * How many peers there are to ask.
   *
   * Passed in rather than read from the client, because a plain method call is
   * invisible to the reactive system: this component would compute it once and
   * then disagree with the footer, which is exactly what happened.
   */
  const peers = $derived(peerCount);

  let bytes = $state<Uint8Array | null>(null);
  let loading = $state(false);
  let asked = $state(false);

  const item = $derived(entry(space.state, id));
  const hash = $derived(contentHash(space.state, id));

  $effect(() => {
    // Re-read whenever the selection or the space changes, and ask for the
    // content if it is not here. Selecting a file *is* wanting to see it, so
    // making a person click again to fetch was a step with no decision in it.
    void id;
    bytes = null;
    asked = false;
    void (async () => {
      await load();
      if (bytes === null && hash !== null) fetchFromPeers();
    })();
  });

  async function load(): Promise<void> {
    loading = true;
    bytes = await read(space, id);
    loading = false;
  }

  function fetchFromPeers(): void {
    if (hash === null) return;
    asked = true;
    if (peers === 0) return;
    client.requestBlob(spaceId, hash);
    // Arrival is asynchronous and the client signals it, so the subscription
    // below picks it up. A single timed re-read would miss a large blob or a
    // slow link and then never try again.
  }

  onMount(() =>
    client.subscribe(() => {
      // A blob may have landed. Only re-read while something is missing, so a
      // file already shown is not re-read on every unrelated change.
      if (bytes === null && hash !== null && !loading) void load();
    }),
  );

  $effect(() => {
    // Ask again when a peer appears. Selecting a file before a connection is
    // up is ordinary — a space is held first and reached second — and without
    // this the request made against nobody would never be retried.
    if (peers > 0 && bytes === null && hash !== null && !asked) fetchFromPeers();
  });

  const text = $derived.by(() => {
    if (bytes === null) return null;
    // The kind is advisory (§4.2) and may be wrong or absent — a file written
    // by something that only had a filename to go on. So try to decode
    // regardless, unless the kind positively says otherwise: bytes that are
    // valid UTF-8 without control characters are text whatever the label says.
    const kind = item?.kind ?? null;
    if (kind !== null && (kind.startsWith('image/') || kind.startsWith('audio/') ||
        kind.startsWith('video/') || kind === 'application/pdf')) {
      return null;
    }
    if (isTextual(kind)) return decodeUtf8(bytes);
    return looksTextual(bytes) ? decodeUtf8(bytes) : null;
  });

  function decodeUtf8(b: Uint8Array): string | null {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      return null;
    }
  }

  /** Bytes with no NULs and few control characters read as text. */
  function looksTextual(b: Uint8Array): boolean {
    const sample = b.subarray(0, 1024);
    let odd = 0;
    for (const byte of sample) {
      if (byte === 0) return false;
      if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) odd += 1;
    }
    return odd / Math.max(1, sample.length) < 0.05;
  }

  const imageUrl = $derived.by(() => {
    if (bytes === null || !(item?.kind ?? '').startsWith('image/')) return null;
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: item!.kind! }));
  });

  function download(): void {
    if (bytes === null || item === null) return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

{#if item !== null}
  <div class="preview">
    <div class="preview-head">
      <span class="preview-name">{item.name}</span>
      {#if bytes !== null}
        <button onclick={download} title="Download" aria-label="Download"
          ><Icon name="download" /></button
        >
      {/if}
    </div>

    <dl class="preview-meta">
      <dt>kind</dt>
      <dd>{item.kind ?? '—'}</dd>
      {#if hash !== null}
        <dt>content</dt>
        <dd class="mono">{hex(hash).slice(0, 16)}…</dd>
      {/if}
      {#if bytes !== null}
        <dt>size</dt>
        <dd>{bytes.length} bytes</dd>
      {/if}
    </dl>

    {#if item.object.bodyRuleMissing !== undefined}
      <p class="note">
        This client has no rule for <code>{item.object.bodyRuleMissing}</code>, so it cannot read
        this. Everything else about the space is unaffected.
      </p>
    {:else if loading}
      <p class="note">Reading…</p>
    {:else if bytes === null && hash !== null}
      <!-- §2.4: metadata replicates to everyone; blobs are fetched on demand. -->
      <p class="note">
        The content is not held here.
        {#if peers === 0}
          <!-- Asking nobody is not the same as asking and being refused. -->
          No peers are connected, so there is nobody to ask.
        {:else if asked}
          Asked {peers} peer{peers === 1 ? '' : 's'}; waiting.
        {:else}
          <button onclick={fetchFromPeers}>Ask {peers} peer{peers === 1 ? '' : 's'}</button>
        {/if}
      </p>
    {:else if text !== null}
      <pre class="preview-text">{text}</pre>
    {:else if imageUrl !== null}
      <img class="preview-image" src={imageUrl} alt={item.name} />
    {:else if bytes !== null}
      <p class="note">No preview for this kind. {bytes.length} bytes.</p>
    {:else}
      <p class="note">This is a folder.</p>
    {/if}
  </div>
{/if}
