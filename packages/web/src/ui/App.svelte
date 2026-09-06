<!--
  The browser client (`docs/WEB.md`).

  Sidebar tree, preview pane. Below 40rem it becomes one pane and selecting a
  file pushes the preview over the tree — the breakpoint and the mechanism both
  come from `docs/v0/MOBILE.md`, which settled them by building it once.

  Tabs are open spaces (`docs/MAIN-SPACE.md`): opening writes nothing, and
  following a link opens another rather than descending in place.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    hex,
    isLink,
    links,
    list,
    makeFile,
    makeFolder,
    ROOT,
    type FileEntry,
    type Uuid,
  } from '@thing/engine';
  import { Client, parseShareLink, type Tab } from '../client.js';
  import Preview from './Preview.svelte';

  const client = new Client({
    signallingUrl: import.meta.env['VITE_SIGNALLING'] ?? undefined,
  });

  let tabs = $state<Tab[]>([]);
  let activeId = $state<string | null>(null);
  let path = $state<Uuid[]>([]);
  let selected = $state<Uuid | null>(null);
  let error = $state<string | null>(null);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const active = $derived(tabs.find((t) => t.id === activeId) ?? null);
  const here = $derived<Uuid>(path.length === 0 ? ROOT : path[path.length - 1]!);
  const entries = $derived<FileEntry[]>(active === null ? [] : list(active.state, here));
  const writable = $derived(active?.writable === true);

  function refresh(): void {
    tabs = client.view();
    if (activeId === null && tabs.length > 0) activeId = tabs[0]!.id;
  }

  onMount(() => {
    const off = client.subscribe(refresh);

    // A share link is the one locator source that works before you know
    // anybody (`docs/LOCATORS.md`), so it is how a browser gets started.
    const link = parseShareLink(location.hash);
    if (link !== null) {
      void (async () => {
        try {
          const tab = await client.open(fromHex(link.key), link.name);
          activeId = tab.id;
          if (link.locator !== null) await client.connect(tab.id, link.locator);
          else if (link.token !== null) await client.meetAt(tab.id, link.token);
        } catch (err) {
          error = err instanceof Error ? err.message : 'could not open that space';
        }
        refresh();
      })();
    }
    return off;
  });

  function show(id: string): void {
    activeId = id;
    path = [];
    selected = null;
  }

  /** Following a link opens a tab. It writes nothing (`docs/MAIN-SPACE.md`). */
  async function follow(name: string): Promise<void> {
    if (activeId === null) return;
    const tab = await client.follow(activeId, name);
    if (tab !== null) show(tab.id);
  }

  async function closeTab(id: string): Promise<void> {
    await client.closeTab(id);
    if (activeId === id) {
      activeId = null;
      path = [];
      selected = null;
    }
    refresh();
  }

  async function create(): Promise<void> {
    show((await client.create('untitled')).id);
  }

  function enter(e: FileEntry): void {
    if (isLink(e)) void follow(e.name);
    else if (e.isFolder) {
      path = [...path, e.id];
      selected = null;
    } else selected = e.id;
  }

  function up(): void {
    path = path.slice(0, -1);
    selected = null;
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
    event.preventDefault();
    dragging = false;
    void addFiles(event.dataTransfer?.files ?? null);
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

  function fromHex(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
</script>

<div
  class="app"
  ondragover={(e) => {
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
      <span class="tab" class:active={tab.id === activeId}>
        <button class="label" onclick={() => show(tab.id)}>
          {tab.name ?? tab.id.slice(0, 8)}
          {#if tab.peers > 0}<span class="dot" title="{tab.peers} connected"></span>{/if}
        </button>
        <button class="shut" onclick={() => closeTab(tab.id)} title="close">×</button>
      </span>
    {/each}
    <button class="tab new" onclick={create}>+ space</button>
  </nav>

  {#if error !== null}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if active === null}
    <div class="empty">
      <p>Nothing open.</p>
      <p class="muted">
        Open a space with a share link, or
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
            <span class="tag warn">{active.forks.length} fork(s)</span>
          {/if}
        </header>

        <div class="bar">
          {#if path.length > 0}
            <button onclick={up}>← up</button>
          {/if}
          {#if writable}
            <button onclick={() => fileInput?.click()}>+ file</button>
            <button onclick={newFolder}>+ folder</button>
          {/if}
        </div>
        <input
          type="file"
          multiple
          bind:this={fileInput}
          onchange={(e) => void addFiles((e.currentTarget as HTMLInputElement).files)}
          hidden
        />

        <ul class="tree">
          {#each entries as e (hex(e.id))}
            <li>
              <button
                class="entry"
                class:selected={selected !== null && hex(selected) === hex(e.id)}
                onclick={() => enter(e)}
              >
                <span class="glyph">{isLink(e) ? '→' : e.isFolder ? '▸' : ''}</span>
                <span class="name">{e.name}</span>
              </button>
            </li>
          {:else}
            <li class="muted pad">
              {writable ? 'Empty — drop a file in.' : 'Empty.'}
            </li>
          {/each}
        </ul>

        {#if links(active.state).length > 0}
          <p class="muted pad small">
            {links(active.state).length} link(s) — following one opens a tab.
          </p>
        {/if}
      </section>

      <section class="pane-preview">
        {#if selected !== null}
          <button class="back" onclick={() => (selected = null)}>← files</button>
          <Preview
            {client}
            space={client.space(active.id)!}
            spaceId={active.id}
            id={selected}
            peers={active.peers}
          />
        {:else}
          <p class="muted pad">Select a file.</p>
        {/if}
      </section>
    </div>
  {/if}
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
  .pane-preview {
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    padding: var(--space-3);
  }

  header { display: flex; gap: var(--space-2); align-items: baseline; }
  .id { font-family: var(--font-data); font-size: var(--text--1); color: var(--ink-faint); }
  .tag { font-size: var(--text--2); color: var(--ink-muted); }
  .tag.warn { color: var(--danger); }

  .bar { display: flex; gap: var(--space-2); padding: var(--space-2) 0; }
  .bar button {
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-muted);
    font: inherit;
    font-size: var(--text--1);
    padding: var(--space-1) var(--space-2);
    cursor: pointer;
  }
  .bar button:hover { color: var(--ink); border-color: var(--rule-strong); }

  .tree { list-style: none; padding: 0; margin: 0; }
  .entry {
    display: flex;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    padding: var(--space-1) var(--space-2);
    cursor: pointer;
  }
  .entry:hover { background: var(--canvas-raised); }
  .entry.selected { background: var(--canvas-sunken); }
  .glyph { width: 1em; color: var(--ink-faint); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .empty { padding: var(--space-6); }
  .muted { color: var(--ink-muted); }
  .pad { padding: var(--space-2); }
  .small { font-size: var(--text--1); }
  .error { color: var(--danger); padding: var(--space-2) var(--space-3); margin: 0; }
  .inline {
    background: none; border: none; color: var(--link);
    text-decoration: underline; cursor: pointer; font: inherit; padding: 0;
  }
  .back { display: none; }

  /*
   * One pane below 40rem, and selecting pushes the preview over the tree
   * (`docs/v0/MOBILE.md`). Everything else stays as it is — including the
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
