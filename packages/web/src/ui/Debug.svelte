<!--
  What is actually going on: peers, chains, storage, blobs, ephemeral, log.

  **Tabbed rather than one long page.** These are six unrelated questions, and
  stacking them meant every one was found by scrolling past the others. Only
  one is ever being asked at a time.

  **For when something has gone wrong**, which is why it is a panel rather than
  part of the interface — the footer carries what matters continuously. Putting
  storage forward would suggest that browsing it is an ordinary thing to do; it
  is not, and the cases it exists for are all failures (`docs/WEB.md`).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { hex } from '@thing/engine';
  import type { BlobRow, Client, StoredSpace, Tab } from '../client.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    tabs: readonly Tab[];
    active: Tab | null;
    onclose: () => void;
    onrestored: (id: string) => void;
  }

  const { client, tabs, active, onclose, onrestored }: Props = $props();

  type View = 'peers' | 'chains' | 'storage' | 'blobs' | 'ephemeral' | 'log';
  let view = $state<View>('peers');

  let stored = $state<StoredSpace[]>([]);
  let complete = $state(true);
  let blobs = $state<BlobRow[]>([]);
  let busy = $state<string | null>(null);
  let filter = $state('');

  /**
   * Re-read what this panel shows.
   *
   * **Guarded against overlap, and coalesced.** It is driven by
   * `client.subscribe`, which fires on every fold — a sync of a few hundred
   * events fires it a few hundred times, each starting an async read of
   * storage and every blob hash. Without the guard those pile up faster than
   * they finish and the tab stops responding; without the trailing pass the
   * last change could be missed.
   */
  let reading = false;
  let again = false;
  async function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const s = await client.storage();
        stored = [...s.spaces];
        complete = s.complete;
        blobs = active === null ? [] : await client.blobs(active.id);
      } while (again);
    } finally {
      reading = false;
    }
  }

  onMount(() => {
    void refresh();
    return client.subscribe(() => void refresh());
  });

  // Re-read when the tab changes, since blobs are per space.
  //
  // **Tracks the id and nothing else.** `refresh` *writes* `stored`, `blobs`
  // and `complete`, so calling it directly inside an effect makes the effect
  // depend on what it sets and re-run forever — which froze the renderer hard
  // enough that the page stopped responding. Reading the id into a local first
  // keeps the write out of the tracked scope.
  // Plain `let`, not `$state`: this is a latch the effect writes on every run,
  // and a reactive one would make the effect depend on its own write.
  let lastSpace: string | null = null;
  $effect(() => {
    const id = active?.id ?? null;
    if (id === lastSpace) return;
    lastSpace = id;
    void refresh();
  });

  const peers = $derived(client.peers());
  const activity = $derived(client.recent());

  const log = $derived(
    [...activity]
      .reverse()
      .filter((a) => filter === '' || a.text.toLowerCase().includes(filter.toLowerCase())),
  );
  const ephemeral = $derived(activity.filter((a) => a.channel === 'ephemeral').reverse());

  /** Chains and their frontiers, per tab — the version vector, made readable. */
  let vectors = $state<Record<string, { chain: string; frontier: number; tip: string }[]>>({});
  // Same trap: the async body assigns `vectors`, so the read of `tabs` must be
  // the only tracked dependency and the write must happen off the tracked turn.
  $effect(() => {
    const current = tabs;
    void (async () => {
      const out: Record<string, { chain: string; frontier: number; tip: string }[]> = {};
      for (const tab of current) {
        const space = client.space(tab.id);
        if (space === null) continue;
        const vv = await space.versionVector();
        out[tab.id] = [...vv].map(([chain, f]) => ({
          chain,
          frontier: f.frontier,
          // `tip` is bytes on the wire type and a `Hash` here; hex is what a
          // person can compare against another peer's report.
          tip: hex(f.tip),
        }));
      }
      vectors = out;
    })();
  });

  async function remove(id: string): Promise<void> {
    // Not recoverable, and this may be the last copy anywhere.
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
  const VIEWS: View[] = ['peers', 'chains', 'storage', 'blobs', 'ephemeral', 'log'];
</script>

<aside class="debug">
  <header>
    <nav>
      {#each VIEWS as v (v)}
        <button class:on={view === v} onclick={() => (view = v)}>{v}</button>
      {/each}
    </nav>
    <button class="shut" onclick={onclose} aria-label="Close debug panel" title="Close">
      <Icon name="x" />
    </button>
  </header>

  <div class="body">
    {#if view === 'peers'}
      {#if peers.length === 0}
        <p class="muted">Not connected to anything.</p>
      {:else}
        <table>
          <thead><tr><th>peer</th><th>space</th><th>how</th><th>state</th></tr></thead>
          <tbody>
            {#each peers as peer (peer.id + peer.space)}
              <tr>
                <td><code>{peer.id}</code></td>
                <td><code>{peer.space.slice(0, 8)}</code></td>
                <td>{peer.kind}</td>
                <td>{peer.state}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

    {:else if view === 'chains'}
      {#each tabs as tab (tab.id)}
        <h4>{tab.name ?? tab.id.slice(0, 8)}</h4>
        {#if tab.forks.length > 0}
          <p class="warn">
            {tab.forks.length} chain{tab.forks.length === 1 ? '' : 's'} diverged — this will not
            converge on its own (§2.3).
          </p>
        {/if}
        <table>
          <thead><tr><th>chain</th><th>seq</th><th>tip</th></tr></thead>
          <tbody>
            {#each vectors[tab.id] ?? [] as v (v.chain)}
              <tr class:warn={tab.forks.some((f) => f.chain === v.chain)}>
                <td><code>{v.chain.slice(0, 24)}</code></td>
                <td>{v.frontier}</td>
                <td><code>{v.tip.slice(0, 12)}</code></td>
              </tr>
            {:else}
              <tr><td colspan="3" class="muted">No events.</td></tr>
            {/each}
          </tbody>
        </table>
      {/each}

    {:else if view === 'storage'}
      {#if !complete}
        <!-- `databases()` is missing here, so this can only report what happens
             to be open — precisely the case it is least useful in. -->
        <p class="warn">
          This browser cannot list its own databases, so what follows is only the
          spaces currently open — not necessarily everything stored.
        </p>
      {/if}
      <table>
        <thead><tr><th>space</th><th>name</th><th>events</th><th>tab</th><th></th></tr></thead>
        <tbody>
          {#each stored as space (space.id)}
            <tr class:orphan={!space.inTab}>
              <td><code>{space.id.slice(0, 24)}</code></td>
              <td>{space.name ?? '—'}</td>
              <td class="num">{space.events ?? '—'}</td>
              <td>{space.inTab ? 'open' : 'no tab'}</td>
              <td class="actions">
                {#if !space.inTab}
                  <button disabled={busy === space.id} onclick={() => void restore(space.id)}>
                    Restore
                  </button>
                {/if}
                <button disabled={busy === space.id} onclick={() => void remove(space.id)}>
                  Delete
                </button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">Nothing stored.</td></tr>
          {/each}
        </tbody>
      </table>

    {:else if view === 'blobs'}
      <p class="muted">
        {active === null ? 'No space open.' : `Content of ${active.name ?? active.id.slice(0, 8)}.`}
        Referenced but absent is a file whose bytes have not arrived; held but
        unreferenced is content whose object was deleted.
      </p>
      <table>
        <thead><tr><th>hash</th><th>referenced</th><th>held</th></tr></thead>
        <tbody>
          {#each blobs as blob (blob.hash)}
            <tr class:warn={blob.referenced && !blob.held}>
              <td><code>{blob.hash.slice(0, 32)}</code></td>
              <td>{blob.referenced ? 'yes' : 'no'}</td>
              <td>{blob.held ? 'yes' : 'missing'}</td>
            </tr>
          {:else}
            <tr><td colspan="3" class="muted">No blobs.</td></tr>
          {/each}
        </tbody>
      </table>

    {:else if view === 'ephemeral'}
      <p class="muted">
        Traffic that expires and is never stored (§10): availability and presence.
      </p>
      <table>
        <thead><tr><th>at</th><th>space</th><th>what</th></tr></thead>
        <tbody>
          {#each ephemeral as line (line.at + line.text)}
            <tr>
              <td class="mono">{when(line.at)}</td>
              <td><code>{line.space?.slice(0, 8) ?? '—'}</code></td>
              <td>{line.text}</td>
            </tr>
          {:else}
            <tr><td colspan="3" class="muted">No ephemeral traffic yet.</td></tr>
          {/each}
        </tbody>
      </table>

    {:else}
      <input class="filter" bind:value={filter} placeholder="Filter the log" />
      <table>
        <thead><tr><th>at</th><th>channel</th><th>space</th><th>what</th></tr></thead>
        <tbody>
          {#each log as line (line.at + line.text)}
            <tr>
              <td class="mono">{when(line.at)}</td>
              <td class="chan">{line.channel}</td>
              <td><code>{line.space?.slice(0, 8) ?? '—'}</code></td>
              <td>{line.text}</td>
            </tr>
          {:else}
            <tr><td colspan="4" class="muted">Nothing yet.</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</aside>

<style>
  .debug {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--rule);
    font-size: 0.8rem;
    height: 20rem;
    flex: 0 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--rule);
  }
  nav { display: flex; gap: var(--space-1); }
  nav button {
    background: none; border: none; color: var(--ink-muted);
    cursor: pointer; padding: 2px var(--space-2); font: inherit;
    border-radius: 2px;
  }
  nav button:hover { color: var(--ink); }
  nav button.on { color: var(--ink); background: var(--raised, rgba(255,255,255,0.06)); }
  .shut {
    margin-left: auto; background: none; border: none;
    color: var(--ink-muted); cursor: pointer; display: inline-flex; padding: 0;
  }
  .shut:hover { color: var(--ink); }
  .body { overflow: auto; padding: var(--space-2); }
  table { border-collapse: collapse; width: 100%; }
  th {
    text-align: left; font-weight: 500; color: var(--ink-muted);
    padding: 2px var(--space-2) 2px 0; border-bottom: 1px solid var(--rule);
    position: sticky; top: 0; background: var(--canvas);
    font-size: 0.75rem;
  }
  td { padding: 2px var(--space-2) 2px 0; vertical-align: top; }
  .num { text-align: right; }
  .actions { text-align: right; white-space: nowrap; }
  .actions button {
    font-size: 0.72rem; padding: 1px var(--space-2); margin-left: var(--space-1);
    background: none; border: 1px solid var(--rule); color: var(--ink-muted);
    cursor: pointer; border-radius: 2px;
  }
  .actions button:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-muted); }
  .actions button:disabled { opacity: 0.5; cursor: default; }
  code, .mono { font-family: var(--mono); font-size: 0.75rem; }
  .muted { color: var(--ink-muted); }
  .warn { color: var(--ink); }
  tr.warn code { font-weight: 600; }
  .orphan code { color: var(--ink); font-weight: 600; }
  .chan { color: var(--ink-muted); }
  h4 { font-size: 0.78rem; margin: var(--space-2) 0 var(--space-1); font-weight: 500; }
  .filter {
    width: 100%; margin-bottom: var(--space-2);
    background: none; border: 1px solid var(--rule); color: var(--ink);
    padding: 2px var(--space-2); font: inherit; font-size: 0.78rem;
  }
</style>
