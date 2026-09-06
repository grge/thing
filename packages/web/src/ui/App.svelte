<!--
  The browser client: tabs over spaces.

  Deliberately small. It exercises the model — open a space, see its tree,
  follow a link into another tab, keep one if you want it — and nothing more.
  The previous version merged a space list, a tree, a preview and a debug panel
  into one component; this is the part that had to be rebuilt for the tab model,
  and the rest is worth adding back deliberately rather than carrying over.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { hex, isLink, links, list, ROOT, type FileEntry, type Uuid } from '@thing/engine';
  import { Client, parseShareLink, type Tab } from '../client.js';

  const client = new Client({
    signallingUrl: import.meta.env['VITE_SIGNALLING'] ?? undefined,
  });

  let tabs = $state<Tab[]>([]);
  let activeId = $state<string | null>(null);
  let path = $state<Uuid[]>([]);
  let error = $state<string | null>(null);

  const active = $derived(tabs.find((t) => t.id === activeId) ?? null);
  const here = $derived<Uuid>(path.length === 0 ? ROOT : path[path.length - 1]!);
  const entries = $derived<FileEntry[]>(active === null ? [] : list(active.state, here));

  function refresh(): void {
    tabs = client.view();
    if (activeId === null && tabs.length > 0) activeId = tabs[0]!.id;
  }

  onMount(() => {
    const off = client.subscribe(refresh);

    // A share link is the one locator source that works before you know
    // anybody (docs/LOCATORS.md) — so it is how a browser gets started.
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

  async function open(id: string): Promise<void> {
    activeId = id;
    path = [];
  }

  /** Following a link opens a tab. It writes nothing (docs/MAIN-SPACE.md). */
  async function follow(name: string): Promise<void> {
    if (activeId === null) return;
    const tab = await client.follow(activeId, name);
    if (tab !== null) {
      activeId = tab.id;
      path = [];
    }
  }

  async function closeTab(id: string): Promise<void> {
    await client.closeTab(id);
    if (activeId === id) activeId = null;
    path = [];
    refresh();
  }

  async function create(): Promise<void> {
    const tab = await client.create('untitled');
    activeId = tab.id;
    path = [];
  }

  function enter(e: FileEntry): void {
    if (isLink(e)) void follow(e.name);
    else if (e.isFolder) path = [...path, e.id];
  }

  function up(): void {
    path = path.slice(0, -1);
  }

  function fromHex(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
</script>

<main>
  <nav class="tabs">
    {#each tabs as tab (tab.id)}
      <button class="tab" class:active={tab.id === activeId} onclick={() => open(tab.id)}>
        {tab.name ?? tab.id.slice(0, 8)}
        {#if tab.peers > 0}<span class="dot" title="{tab.peers} connected"></span>{/if}
      </button>
      <button class="shut" onclick={() => closeTab(tab.id)} title="close">×</button>
    {/each}
    <button class="tab new" onclick={create}>+ new space</button>
  </nav>

  {#if error !== null}
    <p class="error">{error}</p>
  {/if}

  {#if active === null}
    <p class="empty">
      No space open. A share link opens one; <button class="inline" onclick={create}>make one</button>
      to start your own.
    </p>
  {:else}
    <header>
      <span class="id">{active.id.slice(0, 8)}</span>
      {#if !active.writable}<span class="ro">read-only</span>{/if}
      {#if active.forks.length > 0}<span class="fork">{active.forks.length} fork(s)</span>{/if}
    </header>

    {#if path.length > 0}
      <button class="up" onclick={up}>← up</button>
    {/if}

    <ul class="tree">
      {#each entries as e (hex(e.id))}
        <li>
          <button class="entry" onclick={() => enter(e)}>
            <span class="glyph">{isLink(e) ? '→' : e.isFolder ? '/' : ' '}</span>
            {e.name}
          </button>
        </li>
      {:else}
        <li class="empty">nothing here</li>
      {/each}
    </ul>

    {#if links(active.state).length > 0}
      <p class="note">
        {links(active.state).length} link(s) — following one opens a tab and changes nothing.
      </p>
    {/if}
  {/if}
</main>

<style>
  main { padding: var(--space-4, 1rem); font-family: var(--font-mono, monospace); }
  .tabs { display: flex; gap: 0.25rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .tab { background: none; border: 1px solid var(--line, #444); color: inherit;
         padding: 0.2rem 0.6rem; cursor: pointer; font: inherit; }
  .tab.active { background: var(--raised, #222); }
  .tab.new { border-style: dashed; opacity: 0.7; }
  .shut { background: none; border: none; color: inherit; opacity: 0.5; cursor: pointer; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%;
         background: var(--ok, #6a6); margin-left: 0.4rem; }
  header { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.5rem; opacity: 0.8; }
  .id { opacity: 0.6; }
  .ro, .fork { font-size: 0.85em; opacity: 0.7; }
  .tree { list-style: none; padding: 0; margin: 0; }
  .entry { background: none; border: none; color: inherit; font: inherit;
           cursor: pointer; padding: 0.15rem 0; text-align: left; width: 100%; }
  .entry:hover { background: var(--raised, #222); }
  .glyph { display: inline-block; width: 1.2em; opacity: 0.6; }
  .empty, .note { opacity: 0.6; font-size: 0.9em; }
  .error { color: var(--bad, #c66); }
  .inline { background: none; border: none; color: inherit; text-decoration: underline;
            cursor: pointer; font: inherit; padding: 0; }
  .up { background: none; border: none; color: inherit; cursor: pointer; font: inherit;
        opacity: 0.7; padding: 0 0 0.5rem 0; }
</style>
