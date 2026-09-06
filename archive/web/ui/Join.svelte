<script lang="ts">
  /**
   * Joining a space this browser has never met (§5.4).
   *
   * Two routes with **honestly different guarantees**, and the difference is
   * shown rather than smoothed over:
   *
   * - **A link carries the key**, so what answers either verifies against it or
   *   does not. Full verification, before any contact.
   * - **A typed code is a rendezvous hint only.** It is short enough to be
   *   guessable, which is precisely why nothing depends on it: an impostor who
   *   claims a code can answer, but what they serve will not verify against the
   *   key you actually wanted — and a code alone does not name a key.
   *
   * A code therefore needs somewhere to look. Without a peer address there is
   * nothing for it to point at, which is a limit of this stage rather than of
   * the design: asking connected peers "where is space K" is resolution, and it
   * is stage 8.
   */
  import { parseShareLink } from '../client.js';

  interface Props {
    onjoin: (link: { key: string; token: string | null; locator: string | null }) => void;
    oncancel: () => void;
  }

  const { onjoin, oncancel }: Props = $props();

  let input = $state('');
  let locator = $state('');
  let error = $state<string | null>(null);

  /** What was pasted: a link, a bare key, or something else. */
  const parsed = $derived.by(() => {
    const text = input.trim();
    if (text === '') return null;

    const hash = text.includes('#') ? text.slice(text.indexOf('#')) : `#k=${text}`;
    const link = parseShareLink(hash);
    if (link !== null) return { kind: 'link' as const, link };

    if (/^[0-9a-f]{64}$/i.test(text)) {
      return {
        kind: 'key' as const,
        link: { key: text.toLowerCase(), name: null, token: null, locator: null },
      };
    }
    return null;
  });

  function submit(): void {
    if (parsed === null) {
      error = 'That is not a share link or a space key.';
      return;
    }
    const where = locator.trim() === '' ? parsed.link.locator : locator.trim();
    onjoin({
      key: parsed.link.key,
      token: parsed.link.token,
      locator: where,
    });
  }
</script>

<div class="join">
  <div class="join-row">
    <span class="join-label">link</span>
    <input
      class="join-input"
      placeholder="Paste a share link, or a space key"
      bind:value={input}
      onkeydown={(e) => {
        if (e.key === 'Enter') submit();
      }}
    />
  </div>

  <div class="join-row">
    <span class="join-label">peer</span>
    <input
      class="join-input"
      placeholder="ws://a-peer-with-an-address:9944 (optional)"
      bind:value={locator}
    />
  </div>

  {#if parsed !== null}
    <p class="join-note">
      {#if parsed.kind === 'link'}
        A link names the key, so what answers either verifies against it or does not.
      {:else}
        A bare key verifies too — but nothing here says where to find it, so add a peer address.
      {/if}
    </p>
  {:else if error !== null}
    <p class="join-note join-note--bad">{error}</p>
  {:else}
    <p class="join-note">
      A share link carries the key in its fragment, so it never reached a server.
    </p>
  {/if}

  <div class="join-actions">
    <button onclick={submit} disabled={parsed === null}>Join</button>
    <button onclick={oncancel}>Cancel</button>
  </div>
</div>
