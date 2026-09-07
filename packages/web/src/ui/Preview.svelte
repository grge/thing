<!--
  One file's contents.

  Two things here are not obvious and were learned by building the previous
  version, so they carry over rather than being rediscovered:

  **A blob may not be here yet.** Events replicate to everyone; bytes are pulled
  by whoever wants them (§2.4). So a file can be in the tree with its content
  elsewhere, and selecting it asks connected peers. Arrival is asynchronous, so
  the client's subscription picks it up — a single timed re-read would miss a
  large blob or a slow link and never try again.

  **`:kind` is advisory** (§4.2). A file written by something that only had a
  filename to go on may be labelled wrongly or not at all, so bytes that decode
  as UTF-8 are shown as text whatever the label says — unless the label
  positively says otherwise.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    contentHash,
    entry,
    hex,
    isLink,
    isTextual,
    read,
    targetOf,
    type Space,
    type Uuid,
  } from '@thing/engine';
  import type { Client } from '../client.js';

  interface Props {
    client: Client;
    space: Space;
    spaceId: string;
    id: Uuid;
    peers: number;
  }

  const { client, space, spaceId, id, peers }: Props = $props();

  let bytes = $state<Uint8Array | null>(null);
  let loading = $state(false);
  let asked = $state(false);

  const item = $derived(entry(space.state, id));
  const link = $derived(item !== null && isLink(item) ? targetOf(space.state, id) : null);

  /**
   * The blob this object's body names, if it has one.
   *
   * **A link's body is a key, not a hash.** `contentHash` returns any
   * `Uint8Array` body, so without this a link looks like a file whose bytes are
   * missing — and the preview offered to fetch a blob that does not exist.
   */
  const hash = $derived(link !== null ? null : contentHash(space.state, id));

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
  }

  $effect(() => {
    // Re-runs when the selected file changes.
    void id;
    bytes = null;
    asked = false;
    void (async () => {
      await load();
      if (bytes === null && hash !== null) fetchFromPeers();
    })();
  });

  onMount(() =>
    client.subscribe(() => {
      // A blob may have landed. Only re-read while something is missing, so a
      // file already shown is not re-read on every unrelated change.
      if (bytes === null && hash !== null && !loading) void load();
    }),
  );

  $effect(() => {
    // Ask again when a peer appears. Selecting a file before a connection is up
    // is ordinary — a space is held first and reached second — and without this
    // a request made against nobody would never be retried.
    if (peers > 0 && bytes === null && hash !== null && !asked) fetchFromPeers();
  });

  const text = $derived.by(() => {
    if (bytes === null) return null;
    const kind = item?.kind ?? null;
    if (
      kind !== null &&
      (kind.startsWith('image/') ||
        kind.startsWith('audio/') ||
        kind.startsWith('video/') ||
        kind === 'application/pdf')
    ) {
      return null;
    }
    if (isTextual(kind)) return decodeUtf8(bytes);
    return looksTextual(bytes) ? decodeUtf8(bytes) : null;
  });

  const imageUrl = $derived.by(() => {
    if (bytes === null) return null;
    const kind = item?.kind ?? null;
    if (kind === null || !kind.startsWith('image/')) return null;
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind }));
  });

  function decodeUtf8(b: Uint8Array): string | null {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      return null;
    }
  }

  /** Valid UTF-8 with no control bytes is text, whatever it claims to be. */
  function looksTextual(b: Uint8Array): boolean {
    const sample = b.subarray(0, 1024);
    for (const byte of sample) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) return false;
    }
    return decodeUtf8(sample) !== null;
  }
</script>

<section class="preview">
  <h2>{item?.name ?? 'file'}</h2>

  {#if link !== null}
    <p class="note">A link to another space.</p>
    <p class="key">{hex(link)}</p>
  {:else if bytes === null}
    {#if hash === null}
      <p class="note">This item has no content.</p>
    {:else if peers === 0}
      <p class="note">
        The content is stored elsewhere. Connect to a peer that has it to see it.
      </p>
    {:else}
      <p class="note">Fetching…</p>
    {/if}
  {:else if text !== null}
    <pre>{text}</pre>
  {:else if imageUrl !== null}
    <img src={imageUrl} alt={item?.name ?? ''} />
  {:else}
    <p class="note">{bytes.length} bytes — {item?.kind ?? 'unknown type'}</p>
  {/if}
</section>

<style>
  .preview { border-top: 1px solid var(--line, #333); margin-top: 1rem; padding-top: 0.75rem; }
  h2 { font-size: 0.95rem; font-weight: normal; margin: 0 0 0.5rem 0; opacity: 0.85; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 22rem;
        overflow: auto; font: inherit; opacity: 0.9; }
  img { max-width: 100%; max-height: 22rem; }
  .note { color: var(--ink-muted); font-size: var(--text--1); }
  .key {
    font-family: var(--font-data);
    font-size: var(--text--2);
    color: var(--ink-faint);
    word-break: break-all;
    margin: var(--space-1) 0 0 0;
  }
</style>
