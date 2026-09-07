<!--
  What is actually going on: peers, chains, storage, activity.

  **For when something has gone wrong**, which is why it is a panel rather than
  part of the interface. Putting storage forward would suggest that browsing it
  is an ordinary thing to do; it is not, and the cases it exists for are all
  failures (`docs/WEB.md`).

  The storage section is the one that is not merely informational. With
  closing-deletes and no inventory, a space no tab points at is unreachable —
  nothing lists it, nothing opens it, nothing removes it. This is the only
  route back to it, and the only way to see that a cleanup path was wrong.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Client, StoredSpace, Tab } from '../client.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    tabs: readonly Tab[];
    onclose: () => void;
    onrestored: (id: string) => void;
  }

  const { client, tabs, onclose, onrestored }: Props = $props();

  let stored = $state<StoredSpace[]>([]);
  let complete = $state(true);
  let busy = $state<string | null>(null);

  async function refresh(): Promise<void> {
    const s = await client.storage();
    stored = [...s.spaces];
    complete = s.complete;
  }

  onMount(() => {
    void refresh();
    // Peers and activity change without anything here being touched.
    return client.subscribe(() => void refresh());
  });

  const peers = $derived(client.peers());
  const activity = $derived(client.recent());

  /** Chains and their frontiers, per tab — the version vector, made readable. */
  let vectors = $state<Record<string, { chain: string; frontier: number }[]>>({});
  $effect(() => {
    void tabs;
    void (async () => {
      const out: Record<string, { chain: string; frontier: number }[]> = {};
      for (const tab of tabs) {
        const space = client.space(tab.id);
        if (space === null) continue;
        const vv = await space.versionVector();
        out[tab.id] = [...vv].map(([chain, f]) => ({ chain, frontier: f.frontier }));
      }
      vectors = out;
    })();
  });

  async function remove(id: string): Promise<void> {
    // Deleting a space is not recoverable and may be the last copy anywhere,
    // so it is confirmed — the one place in this app that asks.
    if (!confirm(`Delete ${id.slice(0, 8)} from this browser? This cannot be undone.`)) return;
    busy = id;
    try {
      await client.deleteFromStorage(id);
      await refresh();
    } finally {
      busy = null;
    }
  }

  async function restore(id: string): Promise<void> {
    busy = id;
    try {
      const tab = await client.restoreToTab(id);
      if (tab !== null) onrestored(tab.id);
      await refresh();
    } finally {
      busy = null;
    }
  }

  const when = (at: number): string => new Date(at).toISOString().slice(11, 19);
</script>

<aside class="debug">
  <header>
    <h2>Debug</h2>
    <button onclick={onclose} aria-label="Close debug panel" title="Close">
      <Icon name="x" />
    </button>
  </header>

  <section>
    <h3>Peers</h3>
    {#if peers.length === 0}
      <p class="muted">Not connected to anything.</p>
    {:else}
      <ul class="rows">
        {#each peers as peer (peer.id + peer.space)}
          <li>
            <code>{peer.id}</code>
            <span class="muted">{peer.space.slice(0, 8)} · {peer.kind} · {peer.state}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h3>Chains</h3>
    {#each tabs as tab (tab.id)}
      <div class="group">
        <h4>{tab.name ?? tab.id.slice(0, 8)}</h4>
        {#if tab.forks.length > 0}
          <!-- A fork is reported, never silently ignored (§2.3). -->
          <p class="warn">
            {tab.forks.length} chain{tab.forks.length === 1 ? '' : 's'} diverged — this will not
            converge on its own.
          </p>
          <ul class="rows">
            {#each tab.forks as fork (fork.chain + fork.mine)}
              <li><code>{fork.chain.slice(0, 16)}</code> <span class="muted">at {fork.frontier}</span></li>
            {/each}
          </ul>
        {/if}
        <ul class="rows">
          {#each vectors[tab.id] ?? [] as v (v.chain)}
            <li><code>{v.chain.slice(0, 16)}</code> <span class="muted">seq {v.frontier}</span></li>
          {:else}
            <li class="muted">No events.</li>
          {/each}
        </ul>
      </div>
    {/each}
  </section>

  <section>
    <h3>Storage</h3>
    {#if !complete}
      <!-- `databases()` is missing here, so this can only report what happens
           to be open — precisely the case it is least useful in. Better to say
           so than to show a short list that looks authoritative. -->
      <p class="warn">
        This browser cannot list its own databases, so what follows is only the
        spaces currently open — not necessarily everything stored.
      </p>
    {/if}
    <ul class="rows">
      {#each stored as space (space.id)}
        <li class:orphan={!space.inTab}>
          <code>{space.id.slice(0, 16)}</code>
          <span class="muted">
            {space.name ?? 'unnamed'}
            {#if space.events !== null}· {space.events} event{space.events === 1 ? '' : 's'}{/if}
            {#if !space.inTab}· no tab{/if}
          </span>
          <span class="actions">
            {#if !space.inTab}
              <button disabled={busy === space.id} onclick={() => void restore(space.id)}>
                Restore
              </button>
            {/if}
            <button disabled={busy === space.id} onclick={() => void remove(space.id)}>
              Delete
            </button>
          </span>
        </li>
      {:else}
        <li class="muted">Nothing stored.</li>
      {/each}
    </ul>
  </section>

  <section>
    <h3>Activity</h3>
    <ul class="rows log">
      {#each [...activity].reverse() as line (line.at + line.text)}
        <li>
          <span class="muted">{when(line.at)}</span>
          <span class="chan">{line.channel}</span>
          {line.text}
        </li>
      {:else}
        <li class="muted">Nothing yet.</li>
      {/each}
    </ul>
  </section>
</aside>

<style>
  .debug {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-3);
    overflow-y: auto;
    border-top: 1px solid var(--rule);
    font-size: 0.85rem;
    max-height: 22rem;
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  header button {
    background: none; border: none; color: var(--ink-muted);
    cursor: pointer; display: inline-flex; padding: 0;
  }
  header button:hover { color: var(--ink); }
  h2 { font-size: 0.9rem; margin: 0; }
  h3 { font-size: 0.8rem; margin: 0 0 var(--space-1); color: var(--ink-muted); }
  h4 { font-size: 0.8rem; margin: var(--space-2) 0 var(--space-1); font-weight: 500; }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .rows li { display: flex; align-items: center; gap: var(--space-2); }
  .actions { margin-left: auto; display: flex; gap: var(--space-1); }
  .actions button {
    font-size: 0.75rem; padding: 1px var(--space-2);
    background: none; border: 1px solid var(--rule); color: var(--ink-muted);
    cursor: pointer; border-radius: 2px;
  }
  .actions button:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-muted); }
  .actions button:disabled { opacity: 0.5; cursor: default; }
  code { font-family: var(--mono); font-size: 0.78rem; }
  .muted { color: var(--ink-muted); }
  .warn { color: var(--ink); margin: 0 0 var(--space-1); }
  /* A space with no tab is the case this view exists for, so it is marked. */
  .orphan code { color: var(--ink); font-weight: 600; }
  .chan { color: var(--ink-muted); min-width: 5rem; display: inline-block; }
  .log { max-height: 10rem; overflow-y: auto; }
  .group { margin-bottom: var(--space-2); }
</style>
