<script lang="ts">
  /**
   * The app shell: tabs across the top, a tree and a preview below, status at
   * the foot.
   *
   * **This component owns no protocol state.** Spaces, connections, syncing and
   * storage all live in `Client`; this subscribes and draws. That is the
   * correction to the previous implementation, where twenty-odd pieces of
   * reactive state in one file meant none of it could be reasoned about without
   * a browser.
   */
  import { hex, ROOT, type Uuid } from '@thing/core';
  import { list, makeFile, makeFolder } from '@thing/peer';
  import { onMount } from 'svelte';
  import { Client, parseShareLink, type SpaceStatus } from '../client.js';
  import Preview from './Preview.svelte';
  import Share from './Share.svelte';
  import Tree from './Tree.svelte';

  const client = new Client(undefined, {
    signallingUrl: import.meta.env['VITE_SIGNALLING'] ?? undefined,
  });

  let spaces = $state<SpaceStatus[]>([]);
  let activeId = $state<string | null>(null);
  let selected = $state<Uuid | null>(null);
  let showDeleted = $state(false);
  let sharing = $state(false);
  let message = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  /** Bumped on every client change, so derived values recompute. */
  let epoch = $state(0);

  const active = $derived(spaces.find((s) => s.id === activeId) ?? null);
  const space = $derived.by(() => {
    void epoch;
    return activeId === null ? null : client.space(activeId);
  });
  const entries = $derived.by(() => {
    void epoch;
    const s = space;
    return s === null ? [] : list(s.state, ROOT, { includeDeleted: showDeleted });
  });

  onMount(() => {
    const off = client.subscribe(() => {
      spaces = client.spaces();
      epoch += 1;
    });

    void (async () => {
      await client.restore();
      // A share link is how a space this browser has never met arrives (§5.4).
      // The key is in the fragment, so it never reached a server.
      const link = parseShareLink(location.hash);
      if (link !== null) {
        await joinFrom(link);
        history.replaceState(null, '', location.pathname);
      }
      spaces = client.spaces();
      if (activeId === null && spaces.length > 0) activeId = spaces[0]!.id;
    })();

    return off;
  });

  async function joinFrom(link: ReturnType<typeof parseShareLink>): Promise<void> {
    if (link === null) return;
    await client.hold(fromHex(link.key));
    activeId = link.key;
    // A link naming a reachable peer works with no signalling at all.
    if (link.locator !== null) {
      try {
        await client.connectTo(link.key, link.locator);
      } catch {
        say('That peer could not be reached.');
      }
    } else if (link.token !== null) {
      try {
        await client.meetAt(link.key, link.token);
      } catch {
        say('No signalling server, so this space cannot find peers yet.');
      }
    }
  }

  function say(text: string): void {
    message = text;
    setTimeout(() => (message = null), 4000);
  }

  async function newSpace(): Promise<void> {
    const name = prompt('Name this space');
    if (name === null) return;
    activeId = await client.create(name);
    selected = null;
  }

  async function addFolder(): Promise<void> {
    if (space === null) return;
    const name = prompt('Folder name');
    if (name === null || name === '') return;
    await makeFolder(space, name, selectedFolder());
  }

  /** Where a new object should go: inside the selection if it is a folder. */
  function selectedFolder(): Uuid {
    if (selected === null || space === null) return ROOT;
    const entry = entries.find((e) => hex(e.id) === hex(selected!));
    return entry?.isFolder === true ? selected : ROOT;
  }

  async function onFiles(files: FileList | null): Promise<void> {
    if (files === null || space === null) return;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await makeFile(space, file.name, bytes, {
        parent: selectedFolder(),
        kind: file.type === '' ? 'application/octet-stream' : file.type,
      });
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    void onFiles(event.dataTransfer?.files ?? null);
  }

  function fromHex(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
</script>

<div class="app" ondragover={(e) => e.preventDefault()} ondrop={onDrop} role="application">
  <div class="tabs" role="tablist">
    {#each spaces as s (s.id)}
      <button
        class="tab"
        class:active={s.id === activeId}
        role="tab"
        aria-selected={s.id === activeId}
        data-mode={s.writable ? 'writer' : s.openElsewhere ? 'elsewhere' : 'reader'}
        onclick={() => {
          activeId = s.id;
          selected = null;
        }}
      >
        {s.names.display}
        {#if s.peers > 0}<span class="tab-peers">{s.peers}</span>{/if}
      </button>
    {/each}
    <button class="tab-new" onclick={newSpace} title="New space" aria-label="New space">+</button>
    <span class="tabs-spacer"></span>
  </div>

  {#if active === null}
    <div class="empty">
      <p>No spaces yet.</p>
      <button onclick={newSpace}>Create one</button>
    </div>
  {:else}
    <div class="panes" class:has-selection={selected !== null}>
      <div class="pane-tree">
        <div class="pane-head">
          <span class="pane-title">{active.names.display}</span>
          <span class="pane-actions">
            <button onclick={addFolder} disabled={!active.writable} title="New folder">＋</button>
            <button
              onclick={() => fileInput?.click()}
              disabled={!active.writable}
              title="Add files">⇪</button
            >
            <button onclick={() => (showDeleted = !showDeleted)} title="Show deleted"
              >{showDeleted ? '◉' : '◎'}</button
            >
            <button onclick={() => (sharing = !sharing)} title="Share">⤴</button>
          </span>
        </div>

        {#if sharing}
          <Share {client} space={active} onclose={() => (sharing = false)} />
        {/if}

        <Tree
          {entries}
          {selected}
          space={space}
          writable={active.writable}
          onselect={(id) => (selected = id)}
        />
      </div>

      {#if selected !== null && space !== null}
        <div class="pane-preview">
          <Preview {client} spaceId={active.id} {space} id={selected} />
        </div>
      {/if}
    </div>
  {/if}

  <div class="status">
    {#if active !== null}
      <span class="status-mode" data-mode={active.writable ? 'writer' : 'reader'}>
        {active.writable ? 'you write' : active.openElsewhere ? 'open in another tab' : 'read-only'}
      </span>
      <span class="status-sep">·</span>
      <span>{active.peers} peer{active.peers === 1 ? '' : 's'}</span>
      {#if active.forks.length > 0}
        <span class="status-sep">·</span>
        <!-- §2.3: a fork is reported loudly, and confines itself to one chain. -->
        <span class="status-fork">
          {active.forks.length} forked chain{active.forks.length === 1 ? '' : 's'}
        </span>
      {/if}
    {/if}
    <span class="status-spacer"></span>
    {#if message !== null}<span class="status-message">{message}</span>{/if}
  </div>

  <input
    bind:this={fileInput}
    type="file"
    multiple
    hidden
    onchange={(e) => void onFiles((e.currentTarget as HTMLInputElement).files)}
  />
</div>
