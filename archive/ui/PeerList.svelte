<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    open: boolean;
    /** This peer's own id — the one a reader dials (§3.4). */
    localId: string | null;
    peers: string[];
    onClose: () => void;
  }

  let { open, localId, peers, onClose }: Props = $props();

  let root = $state<HTMLDivElement | null>(null);

  // Dismiss on an outside click, the ordinary popover contract.
  $effect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (root !== null && !root.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // Deferred, or the click that opened it closes it again.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', away);
      document.addEventListener('keydown', esc);
    });
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  });

  function copy(id: string): void {
    void navigator.clipboard.writeText(id);
  }
</script>

{#if open}
  <div class="popover" bind:this={root} role="dialog" aria-label="Connected peers">
    <div class="popover-head">
      <span>Peers</span>
      <button type="button" onclick={onClose} aria-label="Close"><Icon name="x" size={12} /></button>
    </div>

    <dl class="peer-self">
      <dt>this peer</dt>
      <dd>
        <code>{localId ?? '—'}</code>
        {#if localId !== null}
          <button type="button" onclick={() => copy(localId)} aria-label="Copy peer id">
            <Icon name="copy" size={12} />
          </button>
        {/if}
      </dd>
    </dl>

    {#if peers.length === 0}
      <p class="popover-empty">
        No peers connected. A reader shows the last state it holds, marked stale.
      </p>
    {:else}
      <ul class="peer-list">
        {#each peers as p (p)}
          <li>
            <code title={p}>{p}</code>
            <button type="button" onclick={() => copy(p)} aria-label="Copy peer id">
              <Icon name="copy" size={12} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
