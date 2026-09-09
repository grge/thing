<!--
  Sharing a space (§5.4).

  **Two things with honestly different guarantees**, and the panel says so
  rather than presenting them as alternatives:

  - A **link** carries the key, so whatever answers it either verifies against
    that key or does not. Nothing about it can be spoofed into showing you the
    wrong space.
  - A **code** is a rendezvous hint, short enough to be guessable — which is
    exactly why nothing depends on it. Someone who claims your code can answer
    your call and still cannot produce events that verify.

  The key goes in the URL fragment, so it never reaches a server.
-->
<script lang="ts">
  import { codeFor } from '@thing/engine';
  import type { Client, Tab } from '../client.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    tab: Tab;
    onclose: () => void;
  }

  const { client, tab, onclose }: Props = $props();

  /**
   * Where this space can be reached, if anywhere.
   *
   * Optional and typed by hand: a browser cannot be dialled (§5.6), so a link
   * from one has no address to offer unless the person knows a peer that serves
   * the space. Empty is the ordinary case, and the link still works — the two
   * sides meet at the rendezvous token instead.
   */
  let locator = $state('');
  let copied = $state<'link' | 'key' | 'seed' | null>(null);
  /**
   * Whether to hand over the space itself.
   *
   * **Not "write access"** (`docs/design/CAPABILITIES.md`): the seed is the
   * space's authority, so whoever holds it decides who may write — including
   * removing you — and nothing can undo that. It exists because moving a space
   * between your own devices is a real need, and it is deliberately awkward.
   */
  let handOver = $state(false);

  const link = $derived.by(() => {
    try {
      return client.shareLink(tab.id, {
        ...(locator === '' ? {} : { locator }),
        ...(handOver ? { grant: 'administer' as const } : {}),
      });
    } catch {
      return '';
    }
  });

  const code = $derived(codeFor(tab.key));

  async function copy(what: 'link' | 'key', text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => (copied = null), 2000);
    } catch {
      // Clipboard access can be refused. The text is on screen and selectable,
      // so this is a convenience failing rather than the panel failing.
    }
  }
</script>

<aside class="share">
  <header>
    <h2>Share {tab.name ?? tab.id.slice(0, 8)}</h2>
    <button onclick={onclose} aria-label="Close" title="Close"><Icon name="x" /></button>
  </header>

  <label>
    <span>Link</span>
    <div class="row">
      <input readonly value={link} onclick={(e) => e.currentTarget.select()} />
      <button onclick={() => void copy('link', link)}>
        <Icon name="copy" />
        {copied === 'link' ? 'copied' : 'copy'}
      </button>
    </div>
    <p class="note">
      {#if handOver}
        <strong>This hands over the space.</strong> Whoever opens it can write
        anything and decide who else may — including removing you. There is no
        way to take it back. Use it to move a space to your own other device.
      {:else}
        Carries the key, so what answers it is verified. Whoever opens it can
        read and replicate, and cannot write.
      {/if}
    </p>
  </label>

  <label class="check">
    <input type="checkbox" bind:checked={handOver} disabled={!tab.writable} />
    <span>
      Hand over the space
      {#if !tab.writable}<span class="note">— this browser holds no key for it</span>{/if}
    </span>
  </label>

  <label>
    <span>Reachable at</span>
    <input bind:value={locator} placeholder="ws://host:9944 — optional" />
    <p class="note">
      Added to the link as a hint. A browser cannot be dialled, so leave this
      empty unless you know a peer that serves this space.
    </p>
  </label>

  <label>
    <span>Key</span>
    <div class="row">
      <input readonly value={tab.id} onclick={(e) => e.currentTarget.select()} />
      <button onclick={() => void copy('key', tab.id)}>
        <Icon name="copy" />
        {copied === 'key' ? 'copied' : 'copy'}
      </button>
    </div>
    <p class="note">The space's identity. Someone can paste this to open or link it.</p>
  </label>

  <section>
    <span>Code</span>
    <p class="code">{code}</p>
    <p class="note">
      Short enough to read aloud, and short enough to guess — a hint about where
      to meet, never proof of what you get.
    </p>
  </section>
</aside>

<style>
  .share {
    border: 1px solid var(--rule);
    background: var(--canvas-raised);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  header { display: flex; align-items: baseline; justify-content: space-between; }
  h2 { font-size: var(--text-0); font-weight: normal; margin: 0; }
  header button {
    background: none; border: none; color: var(--ink-faint);
    cursor: pointer; display: inline-flex;
  }
  label, section { display: flex; flex-direction: column; gap: var(--space-1); }
  label > span, section > span { font-size: var(--text--1); color: var(--ink-muted); }
  .row { display: flex; gap: var(--space-2); }
  input {
    flex: 1;
    font-family: var(--font-data);
    font-size: var(--text--1);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--rule);
    background: var(--canvas);
    color: inherit;
  }
  .row button {
    display: inline-flex; align-items: center; gap: var(--space-1);
    font: inherit; font-size: var(--text--1);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--rule);
    background: none; color: var(--ink-muted); cursor: pointer;
  }
  .row button:hover { color: var(--ink); border-color: var(--rule-strong); }
  .code {
    font-family: var(--font-data);
    font-size: var(--text-1);
    letter-spacing: 0.1em;
    margin: 0;
  }
  .note { font-size: var(--text--2); color: var(--ink-faint); margin: 0; }
</style>
