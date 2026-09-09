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
    isText,
    read,
    targetOf,
    type Space,
    type Uuid,
  } from '@thing/engine';
  import type { Client } from '../client.js';
  import { rendererFor } from './renderers/index.js';
  import TextEdit from './TextEdit.svelte';

  interface Props {
    client: Client;
    space: Space;
    spaceId: string;
    id: Uuid;
    peers: number;
    /** Whether this space keeps copies of content it names (§2.4). */
    mirrors: boolean;
    /** Whether this client may write here, for editable documents. */
    writable: boolean;
  }

  const { client, space, spaceId, id, peers, mirrors, writable }: Props = $props();

  let bytes = $state<Uint8Array | null>(null);
  let loading = $state(false);
  let asked = $state(false);
  /**
   * Peers that answered "I do not hold that" (§2.4).
   *
   * Counted rather than flagged, because a refusal is per peer: one peer
   * saying no while another is still transferring is not the same as everyone
   * having said no, and only the second is worth telling a person about.
   */
  let refusedBy = $state(0);

  const item = $derived(entry(space.state, id));
  /** A document whose body folds by the sequence rule, so it is editable. */
  const isTextDoc = $derived(item !== null && isText(space.state, id));
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
    refusedBy = 0;
    if (peers === 0) return;
    client.requestBlob(spaceId, hash);
  }

  $effect(() => {
    // Re-runs when the selected file changes.
    void id;
    bytes = null;
    asked = false;
    refusedBy = 0;
    void (async () => {
      await load();
      if (bytes === null && hash !== null) fetchFromPeers();
    })();
  });

  onMount(() => {
    const off = client.subscribe(() => {
      // A blob may have landed. Only re-read while something is missing, so a
      // file already shown is not re-read on every unrelated change.
      if (bytes === null && hash !== null && !loading) void load();
    });
    // A peer saying it does not hold these bytes is an answer, and used to be
    // silently swallowed — the view could only ever say "fetching", so a blob
    // nobody had looked identical to one still arriving.
    const offRefused = client.observe({
      onNoBlob: (s, h) => {
        if (s === spaceId && hash !== null && h === hex(hash)) refusedBy += 1;
      },
      // A retry may follow a refusal (the peer was still fetching it itself),
      // so an arrival clears the count rather than leaving a stale "nobody
      // has this" over content that is now here.
      onBlob: (s, h) => {
        if (s === spaceId && hash !== null && h === hex(hash)) refusedBy = 0;
      },
    });
    return () => {
      off();
      offRefused();
    };
  });

  $effect(() => {
    // Ask again when a peer appears. Selecting a file before a connection is up
    // is ordinary — a space is held first and reached second — and without this
    // a request made against nobody would never be retried.
    if (peers > 0 && bytes === null && hash !== null && !asked) fetchFromPeers();
  });

  /**
   * The renderer for this object's type, if anything claims it.
   *
   * `:kind` is advisory (§4.2) — a file written by something that only had a
   * filename may be labelled wrongly or not at all — so when nothing claims the
   * declared type, bytes that decode as UTF-8 are offered to the text renderer
   * anyway. A wrong label should not make a readable file unreadable.
   */
  const chosen = $derived.by(() => {
    const declared = rendererFor(item?.kind ?? null);
    if (declared !== null) return declared;
    if (bytes !== null && looksTextual(bytes)) return rendererFor('text/plain');
    return null;
  });

  /** Valid UTF-8 with no control bytes is text, whatever it claims to be. */
  function looksTextual(b: Uint8Array): boolean {
    const sample = b.subarray(0, 1024);
    for (const byte of sample) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) return false;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample);
      return true;
    } catch {
      return false;
    }
  }
</script>

<section class="preview">
  <h2>{item?.name ?? 'file'}</h2>

  {#if isTextDoc}
    <!-- A text document is live state, not bytes: it has no blob to fetch and
         the point is to change it, so it does not go through the renderer
         registry (§3.8). -->
    <TextEdit {client} {space} {spaceId} {id} writable={writable} />
  {:else if link !== null}
    <p class="note">A link to another space.</p>
    <p class="key">{hex(link)}</p>
  {:else if bytes === null}
    {#if hash === null}
      <p class="note">This item has no content.</p>
    {:else if peers === 0}
      <p class="note">
        The content is stored elsewhere. Connect to a peer that has it to see it.
      </p>
    {:else if refusedBy >= peers}
      <p class="note">
        No connected peer holds this content.
        {#if !mirrors}
          Turning on <strong>keep a copy</strong> for this space makes it fetch
          content as it arrives, rather than only when asked.
        {/if}
      </p>
    {:else}
      <p class="note">Fetching…</p>
    {/if}
  {:else if chosen !== null}
    {@const View = chosen.component}
    <div class="body" class:fills={chosen.fills === true}>
      <View {bytes} type={item?.kind ?? null} name={item?.name ?? null} />
    </div>
  {:else}
    <p class="note">
      Nothing here can show {item?.kind ?? 'this'} — {bytes.length} bytes. Download it instead.
    </p>
  {/if}
</section>

<style>
  .preview { display: flex; flex-direction: column; min-height: 0; flex: 1; }
  h2 {
    font-size: var(--text-0);
    font-weight: normal;
    margin: 0 0 var(--space-2) 0;
  }
  /* Ordinary renderers scroll here. */
  .body { min-height: 0; overflow: auto; flex: 1; }
  /*
   * One that fills scrolls itself, so this must not scroll *and* must give it
   * a real height — `flex: 1` against a `min-height: 0` column does that, and
   * `overflow: hidden` stops a second scrollbar fighting the renderer's own.
   */
  .body.fills { overflow: hidden; display: flex; }
  .note { color: var(--ink-muted); font-size: var(--text--1); }
  .key {
    font-family: var(--font-data);
    font-size: var(--text--2);
    color: var(--ink-faint);
    word-break: break-all;
    margin: var(--space-1) 0 0 0;
  }
</style>
