<!--
  The browser client (`docs/design/WEB-CLIENT.md`).

  Sidebar tree, preview pane. Below 40rem it becomes one pane and selecting a
  file pushes the preview over the tree — the breakpoint and the mechanism both
  come from `docs/archive/v0/MOBILE.md`, which settled them by building it once.

  Tabs are open spaces (`docs/design/MAIN-SPACE.md`): opening writes nothing, and
  following a link opens another rather than descending in place.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    entry,
    hex,
    isLink,
    links,
    makeFile,
    makeFolder,
    makeLink,
    move,
    read,
    remove,
    rename,
    ROOT,
    type FileEntry,
    type PublicKey,
    type State,
    type Uuid,
  } from '@thing/engine';
  import { Client, parsePasted, parseShareLink, type Tab } from '../client.js';
  import { readSettings } from '../local.js';
  import Icon from './Icon.svelte';
  import Preview from './Preview.svelte';
  import Debug from './Debug.svelte';
  import Share from './Share.svelte';
  import Status from './Status.svelte';
  import Settings from './Settings.svelte';
  import Tree from './Tree.svelte';

  // Settings are read here, once, because a `Client` takes them at
  // construction — which is why changing them asks for a reload rather than
  // pretending to apply live (`client.saveSettings`).
  const saved = readSettings();
  const client = new Client({
    signallingUrl: saved.signallingUrl ?? import.meta.env['VITE_SIGNALLING'] ?? undefined,
    ...(saved.iceServers === undefined ? {} : { iceServers: saved.iceServers }),
  });

  let tabs = $state<Tab[]>([]);
  let activeId = $state<string | null>(null);
  /**
   * Which rows are open, by **path** rather than id.
   *
   * A link can be reached twice — a hub linking back, two hubs linking each
   * other — and those are two rows showing the same space. Keying by id would
   * make them one, so expanding at one depth would toggle the other and a cycle
   * could not be walked. Paths make each occurrence its own row, which is what
   * lets a cycle be expanded indefinitely and by hand.
   */
  let expanded = $state<Set<string>>(new Set());
  let selected = $state<Uuid | null>(null);
  /** Which row is selected, and which space it came from. */
  let selectedPath = $state<string | null>(null);
  let selectedIn = $state<string | null>(null);
  let error = $state<string | null>(null);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  /** The object being dragged within a tree, and the row it is over. */
  let moving = $state<Uuid | null>(null);
  let dropTarget = $state<string | null>(null);
  /** The tab being dragged, and the tab it is over. */
  let movingTab = $state<string | null>(null);
  let tabTarget = $state<string | null>(null);
  /** The tab being renamed, and the text so far. */
  let renaming = $state<string | null>(null);
  let draft = $state('');
  /** A pasted key or share link, and what to do with it. */
  let pasting = $state<'open' | 'link' | null>(null);
  let pasted = $state('');
  /** Whether the share panel is showing, for the active tab. */
  let sharing = $state(false);
  /**
   * The debug panel.
   *
   * Off by default and reachable from the tab bar: it is for when something has
   * gone wrong, and the storage view in particular should not read as an
   * ordinary way to browse (`docs/design/WEB-CLIENT.md`).
   */
  let debugging = $state(false);
  /** Settings, alongside the debug panel and shown the same way. */
  let settingsOpen = $state(false);

  const active = $derived(tabs.find((t) => t.id === activeId) ?? null);
  const writable = $derived(active?.writable === true);
  /**
   * The space the selection lives in.
   *
   * Not the tab's space once a link has been expanded: a file inside a linked
   * space belongs to *that* space, and previewing it against the tab's would
   * find no such object — which is what it did, reporting "no content" for
   * every file reached through a link.
   */
  const selectedSpace = $derived(selectedIn === null ? null : client.space(selectedIn));
  const chosen = $derived<FileEntry | null>(
    selectedSpace === null || selected === null ? null : entry(selectedSpace.state, selected),
  );

  /**
   * Where a new file lands: inside the selected folder, else beside the
   * selection, else the root. Dropping onto a tree should put things where you
   * are looking, and "where you are looking" is the selection now that folders
   * expand in place rather than being navigated into.
   */
  const here = $derived<Uuid>(
    chosen === null ? ROOT : chosen.isFolder ? chosen.id : (parentOf(chosen) ?? ROOT),
  );

  function parentOf(e: FileEntry): Uuid | null {
    const p = e.object.attrs.get(':parent')?.value;
    return p instanceof Uint8Array ? p : null;
  }

  /**
   * A counter bumped on every client change.
   *
   * `tabs` is not enough on its own: a linked space being fetched changes what
   * the tree can show without changing the tab list, so anything reading the
   * client outside `tabs` needs something reactive to depend on. Without this,
   * expanding a link the client did not already hold showed "Fetching…" until
   * some unrelated interaction forced a redraw.
   */
  let epoch = $state(0);

  function refresh(): void {
    tabs = client.view();
    epoch += 1;
    if (activeId === null && tabs.length > 0) activeId = tabs[0]!.id;
  }

  onMount(() => {
    const off = client.subscribe(refresh);

    // A share link is the one locator source that works before you know
    // anybody (`docs/design/LOCATORS.md`), so it is how a browser gets started.
    const link = parseShareLink(location.hash);
    void (async () => {
      // **Always restore first.** A share link says which space to *focus*, not
      // which spaces to have — arriving by one should not hide everything else
      // that was open. An earlier version skipped restoring when a link was
      // present, so following a link looked like losing your other spaces.
      await client.restore();

      if (link !== null) {
        try {
          // `open` is idempotent: a space already restored keeps its tab and
          // its name rather than getting a second one.
          const tab = await client.open(fromHex(link.key), link.name);
          activeId = tab.id;
          // Dial regardless of whether the tab is new: a restored tab has no
          // connection, and the link's hint may be the only address anyone has
          // for that space (`docs/design/LOCATORS.md`).
          if (link.locator !== null) await client.connect(tab.id, link.locator);
          else if (link.token !== null) await client.meetAt(tab.id, link.token);
        } catch (err) {
          error = err instanceof Error ? err.message : 'could not open that space';
        }
      }
      refresh();
    })();
    return off;
  });

  function show(id: string): void {
    sharing = false;
    activeId = id;
    expanded = new Set();
    selected = null;
  }

  /**
   * Following a link opens a tab. It writes nothing (`docs/design/MAIN-SPACE.md`).
   *
   * **By the link's object id, not its name.** Nothing stops a space holding
   * two links called `untitled`, and looking one up by name always found the
   * first — so clicking either went to the same space, which looked like a
   * link pointing at someone else's content.
   */
  async function follow(link: Uuid): Promise<void> {
    if (activeId === null) return;
    const tab = await client.follow(activeId, link);
    if (tab !== null) show(tab.id);
  }

  /**
   * Closing deletes the space, so it asks first.
   *
   * A person cannot know whether their copy is the last one, so this is not a
   * confirmation that can be reasoned away by the client — it is the one point
   * where the cost is visible.
   */
  async function closeTab(id: string): Promise<void> {
    const tab = tabs.find((t) => t.id === id);
    const label = tab?.name ?? id.slice(0, 8);
    if (!confirm(`Close ${label}?\n\nThis deletes your copy. If nobody else has it, it is gone.`)) {
      return;
    }
    await client.closeTab(id);
    if (activeId === id) {
      activeId = null;
      expanded = new Set();
      selected = null;
    }
    refresh();
  }

  async function create(): Promise<void> {
    show((await client.create('untitled')).id);
  }

  /**
   * Open or link a space from a pasted key.
   *
   * The fallback for a space nobody has open, where the drag gesture cannot
   * reach. `open` puts it in a tab; `link` keeps it in the current space —
   * the same distinction the drag makes, since pasting should not quietly do
   * something the gesture would not.
   */
  async function commitPaste(): Promise<void> {
    const intent = pasting;
    const text = pasted;
    pasting = null;
    pasted = '';
    if (intent === null) return;

    const link = parsePasted(text);
    if (link === null) {
      error = 'That is not a space key or a share link.';
      return;
    }
    error = null;
    const key = fromHex(link.key);

    try {
      if (intent === 'open') {
        const tab = await client.open(key, link.name);
        show(tab.id);
        if (link.locator !== null) await client.connect(tab.id, link.locator);
        else if (link.token !== null) await client.meetAt(tab.id, link.token);
      } else {
        const space = activeId === null ? null : client.space(activeId);
        if (space === null || !space.writable) {
          error = 'this space is read-only here';
          return;
        }
        if (links(space.state).some((l) => hex(l.target) === link.key)) {
          error = 'that space is already linked here';
          return;
        }
        await makeLink(space, link.name ?? link.key.slice(0, 8), key);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'could not open that space';
    }
  }

  /** Rename a tab: a petname, local to this client and never replicated (§5.5). */
  function startRename(tab: Tab): void {
    renaming = tab.id;
    draft = tab.name ?? '';
  }

  async function commitRename(): Promise<void> {
    const id = renaming;
    renaming = null;
    if (id === null) return;
    const name = draft.trim();
    if (name === '') return;
    await client.rename(id, name);
    refresh();
  }

  /**
   * Selecting is just selecting, including for a link.
   *
   * A link expands in the tree like a folder, so selecting one should not
   * yank the view into another tab. Opening a linked space in its own tab is
   * a separate action, offered in the bar when a link is selected.
   */
  function choose(e: FileEntry, fromSpace: string, path: string): void {
    selected = e.id;
    selectedPath = path;
    selectedIn = fromSpace;
  }

  /**
   * Hold a linked space so its contents can be shown in place.
   *
   * Opening it as a tab would be the wrong effect — expanding a link is
   * looking inside, not switching to it — so this holds without adding to the
   * tab list.
   */
  async function expandLink(_e: FileEntry, target: PublicKey): Promise<void> {
    const id = hex(target);
    try {
      // Hold it first, so the tree can show *something* immediately — an empty
      // space with a spinner beats nothing while resolution runs.
      await client.hold(target);
      refresh();
      // Then go and find it (§5.3). A link names a space and carries no
      // address, deliberately, so expanding one means asking the peers already
      // connected where it is. Without this the space stays empty forever and
      // the tree says "Empty, or not yet synced" with no way forward.
      const reached = await client.reach(id);
      if (!reached) error = 'nobody connected knows where that space is';
      refresh();
    } catch {
      error = 'could not open that space';
    }
  }

  /**
   * The fold of a linked space, if this client holds it.
   *
   * Reading `epoch` is what matters: `client.space()` is not reactive, so
   * without it Svelte has no reason to call this again and a link expanded
   * before its space arrived stayed on "Fetching…" until something unrelated
   * forced a redraw.
   */
  const lookup = $derived.by(() => {
    void epoch;
    return (target: PublicKey): State | null => client.space(hex(target))?.state ?? null;
  });

  function toggle(path: string): void {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded = next;
  }

  /**
   * Add files to the space, in the folder currently open.
   *
   * `kind` comes from the browser when it has one, since it knows more than a
   * filename does; `makeFile` guesses from the name otherwise (§4.2).
   */
  async function addFiles(files: FileList | null): Promise<void> {
    if (files === null || activeId === null) return;
    const space = client.space(activeId);
    if (space === null || !space.writable) {
      error = 'this space is read-only here';
      return;
    }
    error = null;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await makeFile(space, file.name, bytes, {
        parent: here,
        ...(file.type === '' ? {} : { kind: file.type }),
      });
    }
  }

  function onDrop(event: DragEvent): void {
    dragging = false;
    if (event.dataTransfer?.types.includes('Files') !== true) return;
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  }

  async function newFolder(): Promise<void> {
    if (activeId === null) return;
    const space = client.space(activeId);
    if (space === null || !space.writable) {
      error = 'this space is read-only here';
      return;
    }
    await makeFolder(space, 'untitled', here);
  }

  /**
   * Re-parent within a tree.
   *
   * Dropping onto a **file** means *into the folder containing it*, which is
   * what a person means by dropping something next to something else.
   */
  async function dropOnRow(targetId: Uuid): Promise<void> {
    const src = moving;
    moving = null;
    dropTarget = null;
    const space = activeId === null ? null : client.space(activeId);
    if (space === null || src === null || hex(src) === hex(targetId)) return;

    const target = entry(space.state, targetId);
    if (target === null) return;
    const destination = target.isFolder ? target.id : (parentOf(target) ?? ROOT);

    // §3.4's cycle-breaking would resolve this deterministically by re-parenting
    // to the root — correct, and a baffling thing to watch happen. Refusing is
    // kinder than a silent surprise.
    if (wouldCycle(space.state, src, destination)) {
      error = 'A folder cannot be moved inside itself.';
      return;
    }
    error = null;
    await move(space, src, destination);
  }

  /** Would moving `id` under `destination` put it inside itself? */
  function wouldCycle(state: State, id: Uuid, destination: Uuid): boolean {
    let at: Uuid | null = destination;
    const seen = new Set<string>();
    while (at !== null) {
      if (hex(at) === hex(id)) return true;
      if (seen.has(hex(at))) return false; // already-broken cycle; not ours
      seen.add(hex(at));
      const e = entry(state, at);
      at = e === null ? null : parentOf(e);
    }
    return false;
  }

  /**
   * Dropping a tab into a space keeps it: a link, named as the tab is.
   *
   * The gesture is the same as dragging a file in — content arriving from
   * outside — and it is the moment *looking at* becomes *kept*
   * (`docs/design/MAIN-SPACE.md`).
   */
  async function dropTabOn(intoId: string): Promise<void> {
    const src = movingTab;
    movingTab = null;
    tabTarget = null;
    if (src === null || src === intoId) return;

    const space = client.space(intoId);
    if (space === null || !space.writable) {
      error = 'that space is read-only here';
      return;
    }
    const source = tabs.find((t) => t.id === src);
    if (source === undefined) return;
    if (links(space.state).some((l) => hex(l.target) === src)) {
      error = 'that space is already linked here';
      return;
    }
    error = null;
    await makeLink(space, source.name ?? src.slice(0, 8), source.key);
  }

  async function renameChosen(): Promise<void> {
    // The selection's own space: a file reached through a link belongs to the
    // linked space, not the tab's.
    const space = selectedSpace;
    if (space === null || chosen === null) return;
    const next = prompt('New name', chosen.name);
    if (next === null || next === '' || next === chosen.name) return;
    await rename(space, chosen.id, next);
  }

  /**
   * Delete: `:deleted`, which hides rather than unwrites (§7.2.3's shape).
   * The events stay in the log and a peer that already has them keeps them.
   */
  async function deleteChosen(): Promise<void> {
    // The selection's own space: a file reached through a link belongs to the
    // linked space, not the tab's.
    const space = selectedSpace;
    if (space === null || chosen === null) return;
    if (!confirm(`Delete ${chosen.name}?`)) return;
    await remove(space, chosen.id);
    selected = null;
  }

  /**
   * Download, which is the honest fallback for anything nothing can render —
   * and the only way to get bytes back out of a space.
   */
  async function downloadChosen(): Promise<void> {
    // The selection's own space: a file reached through a link belongs to the
    // linked space, not the tab's.
    const space = selectedSpace;
    if (space === null || chosen === null) return;
    const bytes = await read(space, chosen.id);
    if (bytes === null) {
      error = 'those bytes are not held here yet';
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const a = document.createElement('a');
    a.href = url;
    a.download = chosen.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function fromHex(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
</script>

<div
  class="app"
  ondragover={(e) => {
    // Only files from outside. An internal drag — a row being re-parented, a
    // tab being kept — is handled by whatever it is over, and showing the
    // whole-window "drop files" outline for one would be a lie about what is
    // about to happen.
    if (e.dataTransfer?.types.includes('Files') !== true) return;
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
  class:dragging
  role="application"
>
  <nav class="tabs">
    {#each tabs as tab (tab.id)}
      <span
        class="tab"
        class:active={tab.id === activeId}
        class:drop={tabTarget === tab.id}
        draggable="true"
        role="tab"
        tabindex="-1"
        aria-selected={tab.id === activeId}
        ondragstart={(event) => {
          event.dataTransfer?.setData('text/plain', tab.id);
          movingTab = tab.id;
        }}
        ondragend={() => {
          movingTab = null;
          tabTarget = null;
        }}
        ondragover={(event) => {
          if (movingTab === null || movingTab === tab.id) return;
          event.preventDefault();
          event.stopPropagation();
          tabTarget = tab.id;
        }}
        ondragleave={() => (tabTarget = null)}
        ondrop={(event) => {
          if (movingTab === null) return;
          event.preventDefault();
          event.stopPropagation();
          void dropTabOn(tab.id);
        }}
      >
        {#if renaming === tab.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            bind:value={draft}
            autofocus
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') renaming = null;
            }}
          />
        {:else}
          <button
            class="label"
            onclick={() => show(tab.id)}
            ondblclick={() => startRename(tab)}
            title="Double-click to rename"
          >
            {tab.name ?? tab.id.slice(0, 8)}
            {#if tab.peers > 0}<span class="dot" title="{tab.peers} connected"></span>{/if}
          </button>
        {/if}
        <button class="shut" onclick={() => closeTab(tab.id)} aria-label="Close tab" title="Close">
          <Icon name="x" />
        </button>
      </span>
    {/each}
    <button class="tab new" onclick={create} title="New space">
      <Icon name="plus" /> space
    </button>
    <button
      class="tab new"
      onclick={() => {
        pasting = 'open';
        pasted = '';
      }}
      title="Open a space from a key or share link"
    >
      <Icon name="clipboard" /> open
    </button>
  </nav>

  {#if pasting !== null}
    <form
      class="paste"
      onsubmit={(e) => {
        e.preventDefault();
        void commitPaste();
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={pasted}
        autofocus
        placeholder="Paste a space key or share link"
        onkeydown={(e) => {
          if (e.key === 'Escape') pasting = null;
        }}
      />
      <button type="submit">{pasting === 'open' ? 'Open' : 'Link here'}</button>
      <button type="button" onclick={() => (pasting = null)}>Cancel</button>
    </form>
  {/if}

  {#if error !== null}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if active === null}
    <div class="empty">
      <p>Nothing open.</p>
      <p class="muted">
        Open one with a share link, or
        <button class="inline" onclick={create}>make one of your own</button>.
      </p>
    </div>
  {:else}
    <div class="panes" class:has-selection={selected !== null}>
      <section class="pane-tree">
        <header>
          <span class="id" title={active.id}>{active.id.slice(0, 8)}</span>
          {#if !writable}<span class="tag">read-only</span>{/if}
          {#if active.forks.length > 0}
            <span class="tag warn" title="Two versions of this history disagree">
              conflict
            </span>
          {/if}
          <button
            class="share-toggle"
            class:on={active.mirrors}
            onclick={() => void client.setMirror(active.id, !active.mirrors)}
            aria-label={active.mirrors ? 'Stop keeping a copy' : 'Keep a copy'}
            title={active.mirrors
              ? 'Keeping a copy: content is fetched as it arrives'
              : 'Keep a copy: fetch content as it arrives, so this browser can serve it'}
          >
            <Icon name="database" />
          </button>
          <button
            class="share-toggle"
            onclick={() => (sharing = !sharing)}
            aria-label="Share this space"
            title="Share this space"
          >
            <Icon name="share" />
          </button>
        </header>

        {#if sharing}
          <Share {client} tab={active} onclose={() => (sharing = false)} />
        {/if}

        <div class="bar">
          {#if writable}
            <button onclick={() => fileInput?.click()} aria-label="Add files" title="Add files">
              <Icon name="upload" />
            </button>
            <button onclick={newFolder} aria-label="New folder" title="New folder">
              <Icon name="folderPlus" />
            </button>
            <button
              onclick={() => {
                pasting = 'link';
                pasted = '';
              }}
              aria-label="Link a space by key"
              title="Link a space by key"
            >
              <Icon name="link" />
            </button>
          {/if}
          {#if chosen !== null}
            {#if isLink(chosen)}
              <button
                onclick={() => void follow(chosen.id)}
                aria-label="Open in a tab"
                title="Open in a tab"
              >
                <Icon name="link" />
              </button>
            {:else if !chosen.isFolder}
              <button onclick={downloadChosen} aria-label="Download" title="Download">
                <Icon name="download" />
              </button>
            {/if}
            {#if writable}
              <button onclick={renameChosen} aria-label="Rename" title="Rename">
                <Icon name="clipboard" />
              </button>
              <button onclick={deleteChosen} aria-label="Delete" title="Delete">
                <Icon name="trash" />
              </button>
            {/if}
          {/if}
        </div>
        <input
          type="file"
          multiple
          bind:this={fileInput}
          onchange={(e) => void addFiles((e.currentTarget as HTMLInputElement).files)}
          hidden
        />

        <Tree
          state={active.state}
          spaceId={active.id}
          linked={lookup}
          {expanded}
          {selectedPath}
          {writable}
          {dropTarget}
          onSelect={choose}
          onToggle={toggle}
          onExpandLink={(e, target) => void expandLink(e, target)}
          onDragStart={(id) => (moving = id)}
          onDragOver={(path) => (dropTarget = path)}
          onDropOn={(id) => void dropOnRow(id)}
        />

      </section>

      <section class="pane-preview">
        {#if selected !== null}
          <button class="back" onclick={() => (selected = null)}>
            <Icon name="arrowLeft" /> files
          </button>
          <Preview
            {client}
            space={selectedSpace!}
            spaceId={selectedIn!}
            id={selected}
            peers={active.peers}
            mirrors={active.mirrors}
          />
        {:else}
          <p class="muted pad">Select a file.</p>
        {/if}
      </section>
    </div>
  {/if}

  <!-- Outside the `{#if}` above: the storage view is most useful exactly when
       no space will open, which is when that branch renders nothing. -->
  {#if debugging}
    <Debug
      {client}
      tabs={tabs}
      active={active ?? null}
      onclose={() => (debugging = false)}
      onrestored={(id) => show(id)}
    />
  {/if}

  <!-- Always visible. Connectedness is not a debugging concern: it decides
       whether anything you do reaches anyone, and revealing it only on demand
       makes "nothing is syncing" look identical to "everything is fine". -->
  {#if settingsOpen}
    <Settings {client} tabs={tabs} onclose={() => (settingsOpen = false)} />
  {/if}

  <Status
    {client}
    tab={active ?? null}
    {debugging}
    ondebug={() => {
      debugging = !debugging;
      if (debugging) settingsOpen = false;
    }}
    {settingsOpen}
    onsettings={() => {
      settingsOpen = !settingsOpen;
      if (settingsOpen) debugging = false;
    }}
  />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--font-interface);
    font-size: var(--text-0);
    color: var(--ink);
    background: var(--canvas);
  }
  .app.dragging { outline: 2px dashed var(--action); outline-offset: -4px; }

  .tabs {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    flex-wrap: wrap;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--rule);
    background: var(--canvas-raised);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--rule);
    background: var(--canvas);
  }
  .tab.active { border-color: var(--rule-strong); background: var(--canvas-sunken); }
  .tab.drop { outline: 2px solid var(--action); outline-offset: 1px; }
  .tab .label, .tab .shut, .tab.new {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: var(--space-1) var(--space-2);
  }
  .tab.new { border: 1px dashed var(--rule); color: var(--ink-muted); }
  .shut { color: var(--ink-faint); }
  .rename {
    font: inherit;
    color: inherit;
    background: var(--canvas);
    border: 1px solid var(--action);
    padding: var(--space-1) var(--space-2);
    width: 8rem;
  }
  .dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--mode-writer);
    margin-left: var(--space-1);
  }

  .panes {
    display: grid;
    grid-template-columns: minmax(14rem, 22rem) 1fr;
    flex: 1;
    min-height: 0;
  }
  .pane-tree {
    border-right: 1px solid var(--rule);
    overflow: auto;
    min-height: 0;
    padding: var(--space-3);
  }
  /*
   * No `overflow: auto` here: a renderer that fills the pane — a PDF viewer —
   * needs a height to resolve `100%` against, and a scrolling parent with no
   * fixed height gives it zero. Scrolling belongs to the renderer's own
   * container in Preview, which knows whether the renderer wants it.
   */
  .pane-preview {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: var(--space-3);
  }

  header { display: flex; gap: var(--space-2); align-items: baseline; }
  .id { font-family: var(--font-data); font-size: var(--text--1); color: var(--ink-faint); }
  .tag { font-size: var(--text--2); color: var(--ink-muted); }
  .tag.warn { color: var(--danger); }
  /* The first of the trailing controls pushes the group right; the rest sit
     beside it, so adding another does not split them across the header. */
  .share-toggle {
    background: none; border: none; color: var(--ink-muted);
    cursor: pointer; display: inline-flex; padding: 0;
    margin-left: var(--space-2);
  }
  .share-toggle:first-of-type { margin-left: auto; }
  .share-toggle:hover { color: var(--ink); }
  /* On, rather than merely hovered: this one is a state, not an action. */
  .share-toggle.on { color: var(--ink); }

  .bar { display: flex; gap: var(--space-2); padding: var(--space-2) 0; }
  .bar button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-muted);
    font: inherit;
    padding: var(--space-1);
    cursor: pointer;
  }
  .bar button:hover { color: var(--ink); border-color: var(--rule-strong); }
  .tab .label, .tab.new, .back { display: inline-flex; align-items: center; gap: var(--space-1); }
  .shut { display: inline-flex; align-items: center; }

  .empty { padding: var(--space-6); }
  .muted { color: var(--ink-muted); }
  .pad { padding: var(--space-2); }
  .error { color: var(--danger); padding: var(--space-2) var(--space-3); margin: 0; }
  .paste {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--rule);
  }
  .paste input {
    flex: 1;
    font: inherit;
    font-family: var(--font-data);
    font-size: var(--text--1);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--rule);
    background: var(--canvas);
    color: inherit;
  }
  .paste button {
    font: inherit;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--rule);
    background: none;
    color: var(--ink-muted);
    cursor: pointer;
  }
  .paste button:hover { color: var(--ink); border-color: var(--rule-strong); }
  .inline {
    background: none; border: none; color: var(--link);
    text-decoration: underline; cursor: pointer; font: inherit; padding: 0;
  }
  .back { display: none; }

  /*
   * One pane below 40rem, and selecting pushes the preview over the tree
   * (`docs/archive/v0/MOBILE.md`). Everything else stays as it is — including the
   * gestures a touch device cannot reach, which are tracked separately rather
   * than made to work here.
   */
  @media (max-width: 40rem) {
    .panes { grid-template-columns: 1fr; grid-template-rows: 1fr; }
    .panes:not(.has-selection) .pane-preview { display: none; }
    .panes.has-selection .pane-tree { display: none; }
    .pane-tree { border-right: none; }
    .back {
      display: block;
      background: none; border: none; color: var(--link);
      font: inherit; cursor: pointer;
      padding: 0 0 var(--space-2) 0; text-align: left;
    }
  }
</style>
