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
  import Debug from './Debug.svelte';
  import Icon from './Icon.svelte';
  import Join from './Join.svelte';
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
  let joining = $state(false);
  let debugging = $state(false);
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
    try {
      await client.hold(fromHex(link.key));
      // Visible immediately: connecting can take a moment or fail, and a tab
      // that appeared only on success would hide a space genuinely held.
      spaces = client.spaces();
    } catch (err) {
      // Opening storage can fail — private browsing denies IndexedDB, and a
      // blocked database upgrade hangs. Either way, saying so beats a tab
      // that silently never appears.
      say(`Could not open that space: ${describe(err)}`);
      return;
    }
    activeId = link.key;
    // A link naming a reachable peer works with no signalling at all.
    if (link.locator !== null) {
      try {
        await client.connectTo(link.key, link.locator);
        // Refresh again: connecting changes the peer count, and everything
        // downstream — the footer, whether a file can be fetched — reads it
        // from here.
        spaces = client.spaces();
      } catch (err) {
        // Say what actually went wrong. A generic "could not connect" hides
        // the difference between an unreachable address, a refused space and
        // a storage failure, which are three quite different problems.
        say(`Could not reach ${link.locator}: ${describe(err)}`);
      }
    } else if (link.token !== null) {
      try {
        await client.meetAt(link.key, link.token);
        spaces = client.spaces();
      } catch (err) {
        say(`Could not be introduced: ${describe(err)}`);
      }
    }
  }

  /**
   * Join a space by link or key.
   *
   * This browser has no writing key for it, so it opens as a replica: it
   * stores, verifies and serves, and cannot write (§6.1). That is not a
   * degraded state — it is what most participants are.
   */
  async function join(link: {
    key: string;
    token: string | null;
    locator: string | null;
  }): Promise<void> {
    // Refresh the list *before* closing the form: `joining = false` unmounts
    // the component this call came from, and a tab only appears once `spaces`
    // holds the space. Closing first leaves a moment with no form and no tab,
    // which looks exactly like nothing happened.
    await joinFrom({ ...link, name: null });
    spaces = client.spaces();
    joining = false;
  }

  /**
   * Reconnect a space that is held but has no peers.
   *
   * A space can be held with nobody to reach: the address it arrived by is
   * remembered but stale, or it was never recorded. Either way a person needs
   * to be able to say where to look — which is what resolution (§5.3) will
   * eventually do for them, at stage 8.
   */
  async function reconnect(): Promise<void> {
    if (active === null) return;
    const remembered = client.lastLocator(active.id);
    const url = prompt('Connect to which peer?', remembered ?? 'ws://127.0.0.1:9944');
    if (url === null || url.trim() === '') return;
    try {
      await client.connectTo(active.id, url.trim());
      spaces = client.spaces();
    } catch (err) {
      say(`Could not reach ${url}: ${describe(err)}`);
    }
  }

  function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function say(text: string): void {
    message = text;
    // eslint-disable-next-line no-console -- the status bar is one line; the
    // console is where a person debugging actually looks.
    console.warn('[thing]', text);
    setTimeout(() => (message = null), 8000);
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
    <button class="tab-new" onclick={newSpace} title="New space" aria-label="New space">
      <Icon name="plus" />
    </button>
    <button
      class="tab-new"
      class:on={joining}
      onclick={() => (joining = !joining)}
      title="Join a space"
      aria-label="Join a space"
      aria-pressed={joining}><Icon name="logIn" /></button
    >
    <span class="tabs-spacer"></span>
    <button
      class="tab-new"
      class:on={debugging}
      onclick={() => (debugging = !debugging)}
      title="What is happening"
      aria-label="What is happening"
      aria-pressed={debugging}><Icon name="activity" /></button
    >
  </div>

  {#if joining}
    <Join onjoin={(link) => void join(link)} oncancel={() => (joining = false)} />
  {/if}

  {#if active === null}
    <div class="empty">
      <p>No spaces yet.</p>
      <span class="empty-actions">
        <button onclick={newSpace}>Create one</button>
        <button onclick={() => (joining = true)}>Join one</button>
      </span>
    </div>
  {:else}
    <div class="panes" class:has-selection={selected !== null || debugging}>
      <div class="pane-tree">
        <div class="pane-head">
          <span class="pane-title">{active.names.display}</span>
          <span class="pane-actions">
            <button
              onclick={addFolder}
              disabled={!active.writable}
              title="New folder"
              aria-label="New folder"><Icon name="folderPlus" /></button
            >
            <button
              onclick={() => fileInput?.click()}
              disabled={!active.writable}
              title="Add files"
              aria-label="Add files"><Icon name="upload" /></button
            >
            <button
              class:on={showDeleted}
              onclick={() => (showDeleted = !showDeleted)}
              title={showDeleted ? 'Hide deleted' : 'Show deleted'}
              aria-label={showDeleted ? 'Hide deleted' : 'Show deleted'}
              aria-pressed={showDeleted}><Icon name={showDeleted ? 'eye' : 'eyeOff'} /></button
            >
            <button
              class:on={sharing}
              onclick={() => (sharing = !sharing)}
              title="Share"
              aria-label="Share"
              aria-pressed={sharing}><Icon name="share" /></button
            >
            <button
              onclick={() => void reconnect()}
              title={active.peers > 0 ? 'Connected' : 'Connect to a peer'}
              aria-label="Connect to a peer"
              disabled={active.peers > 0}><Icon name="link" /></button
            >
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

      {#if debugging}
        <div class="pane-preview">
          <Debug {client} space={active} open={space} {epoch} onclose={() => (debugging = false)} />
        </div>
      {:else if selected !== null && space !== null}
        <div class="pane-preview">
          <Preview {client} spaceId={active.id} {space} id={selected} peerCount={active.peers} />
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
