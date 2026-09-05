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
  import { contentHash, entry, read, type Space } from '@thing/peer';
  import type { Client } from '../client.js';

  interface Props {
    client: Client;
    spaceId: string;
    space: Space;
    id: Uuid;
  }

  const { client, spaceId, space, id }: Props = $props();

  let bytes = $state<Uint8Array | null>(null);
  let loading = $state(false);
  let asked = $state(false);

  const item = $derived(entry(space.state, id));
  const hash = $derived(contentHash(space.state, id));

  $effect(() => {
    // Re-read whenever the selection or the space changes.
    void id;
    bytes = null;
    asked = false;
    void load();
  });

  async function load(): Promise<void> {
    loading = true;
    bytes = await read(space, id);
    loading = false;
  }

  function fetchFromPeers(): void {
    if (hash === null) return;
    asked = true;
    client.requestBlob(spaceId, hash);
    // The blob arrives asynchronously; the client's change signal redraws.
    setTimeout(() => void load(), 500);
  }

  const text = $derived.by(() => {
    if (bytes === null) return null;
    const kind = item?.kind ?? '';
    if (!kind.startsWith('text/') && kind !== 'application/json') return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  });

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
        <button onclick={download} title="Download">⤓</button>
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
        {#if asked}
          Asked connected peers; nothing yet.
        {:else}
          <button onclick={fetchFromPeers}>Fetch from peers</button>
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
