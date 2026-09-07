<!--
  The footer: what is true right now, in one line.

  **Always visible**, unlike the debug panel. Connectedness is not a debugging
  concern — it decides whether anything you do will reach anyone — and a client
  that only reveals it when you go looking is one where "nothing is syncing"
  looks identical to "everything is fine".

  Only the current tab's peers are counted. A total across every held space
  would be a number about the client rather than about the space in front of
  you, and the question being answered is "will this reach anybody".
-->
<script lang="ts">
  import type { Client, Tab } from '../client.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    tab: Tab | null;
    debugging: boolean;
    ondebug: () => void;
  }

  const { client, tab, debugging, ondebug }: Props = $props();

  let showPeers = $state(false);

  const peers = $derived(
    tab === null ? [] : client.peers().filter((p) => p.space === tab.id),
  );
</script>

<footer class="status">
  <button
    class="peers"
    class:none={peers.length === 0}
    onclick={() => (showPeers = !showPeers)}
    disabled={tab === null}
    title={peers.length === 0 ? 'Not connected' : 'Connected peers'}
  >
    <span class="dot" class:live={peers.length > 0}></span>
    {peers.length}
    {peers.length === 1 ? 'peer' : 'peers'}
  </button>

  {#if tab !== null}
    <span class="muted">{tab.name ?? tab.id.slice(0, 8)}</span>
    {#if tab.forks.length > 0}
      <!-- A fork will not converge on its own, so it is said here rather than
           only in the panel (§2.3). -->
      <span class="warn">{tab.forks.length} forked</span>
    {/if}
    {#if tab.mirrors}
      <span class="muted" title="Keeping a copy of this space's content">copying</span>
    {/if}
  {/if}

  <button class="debug" class:on={debugging} onclick={ondebug} title="Debug">
    <Icon name="activity" />
  </button>

  {#if showPeers}
    <!-- A popout rather than a section: the list is short, and wanting it does
         not mean wanting the whole panel. -->
    <div class="popout">
      {#if peers.length === 0}
        <p class="muted">No peers for this space.</p>
      {:else}
        <ul>
          {#each peers as peer (peer.id)}
            <li>
              <code>{peer.id}</code>
              <span class="muted">{peer.kind} · {peer.state}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1) var(--space-3);
    border-top: 1px solid var(--rule);
    font-size: 0.78rem;
    color: var(--ink-muted);
    position: relative;
    flex: 0 0 auto;
  }
  button {
    background: none; border: none; color: inherit; cursor: pointer;
    display: inline-flex; align-items: center; gap: var(--space-1);
    padding: 0; font: inherit;
  }
  button:hover:not(:disabled) { color: var(--ink); }
  button:disabled { opacity: 0.5; cursor: default; }
  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--ink-muted); opacity: 0.4;
  }
  .dot.live { background: var(--ink); opacity: 1; }
  .debug { margin-left: auto; }
  .debug.on { color: var(--ink); }
  .warn { color: var(--ink); }
  .muted { color: var(--ink-muted); }
  .popout {
    position: absolute;
    bottom: 100%;
    left: var(--space-2);
    margin-bottom: var(--space-1);
    background: var(--canvas);
    border: 1px solid var(--rule);
    padding: var(--space-2);
    min-width: 18rem;
    max-height: 14rem;
    overflow-y: auto;
    z-index: 10;
  }
  .popout ul { list-style: none; margin: 0; padding: 0; }
  .popout li { display: flex; gap: var(--space-2); align-items: baseline; }
  .popout p { margin: 0; }
  code { font-family: var(--mono); font-size: 0.75rem; }
</style>
