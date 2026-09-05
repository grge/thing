<script lang="ts">
  /**
   * Sharing a space (§5.4).
   *
   * Two routes with **honestly different guarantees**. A link carries the key,
   * so what answers either verifies against it or does not. A typed code is a
   * rendezvous hint only — short enough to be guessable, which is precisely why
   * nothing depends on it.
   *
   * The key goes in the URL fragment, so it never reaches a server.
   */
  import type { Client, SpaceStatus } from '../client.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    space: SpaceStatus;
    onclose: () => void;
  }

  const { client, space, onclose }: Props = $props();

  let locator = $state('');
  let copied = $state(false);

  const link = $derived.by(() => {
    try {
      return client.shareLink(space.id, locator === '' ? {} : { locator });
    } catch {
      return '';
    }
  });

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(link);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="share">
  <div class="share-row">
    <span class="share-label">code</span>
    <code class="share-code" title="Type this on another device">{space.names.code}</code>
    <span class="share-note">a hint, not proof</span>
  </div>

  <div class="share-row">
    <span class="share-label">link</span>
    <input class="share-link" readonly value={link} />
    <button onclick={copy} title={copied ? 'Copied' : 'Copy link'} aria-label="Copy link">
      <Icon name="copy" />
      {copied ? 'copied' : ''}
    </button>
  </div>

  <div class="share-row">
    <span class="share-label">peer</span>
    <input
      class="share-locator"
      placeholder="ws://a-peer-with-an-address:9944"
      bind:value={locator}
    />
    <span class="share-note">optional; makes the link work without signalling</span>
  </div>

  <button class="share-close" onclick={onclose}>done</button>
</div>
