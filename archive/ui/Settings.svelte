<script lang="ts">
  /**
   * Device-local settings. Currently just the TURN relay, which is the one
   * piece of configuration this app cannot ship for the user: there is no
   * server to hold a credential, so it lives here instead (see
   * `app/settings.ts`).
   *
   * The test button is the point of the dialog as much as the form is. POC
   * question 1 is "does a relay actually work", and a config screen that can
   * answer it beats one that only accepts input.
   */
  import { hasRelay, iceServers, resetIceServersCache } from '../net/iceservers.js';
  import { type RelayCheck, runRelayCheck, summarise } from '../net/relaycheck.js';
  import { type Settings, turnCredentialsUrl } from '../app/settings.js';
  import Icon from './Icon.svelte';

  interface Props {
    open: boolean;
    settings: Settings;
    onCancel: () => void;
    onSave: (s: Settings) => void;
  }

  let { open, settings, onCancel, onSave }: Props = $props();

  type Provider = 'none' | 'metered' | 'custom';
  let provider = $state<Provider>('none');
  let subdomain = $state('');
  let apiKey = $state('');
  let url = $state('');

  let dialog = $state<HTMLDialogElement | null>(null);
  let testing = $state(false);
  let result = $state<{ ok: boolean; text: string } | null>(null);
  /** Kept alongside the verdict so the detail is inspectable, not just the answer. */
  let detail = $state<RelayCheck | null>(null);

  $effect(() => {
    const d = dialog;
    if (d === null) return;
    if (open && !d.open) {
      // Load from the saved settings on each opening, so a cancelled edit
      // leaves nothing behind.
      const t = settings.turn;
      provider = t.provider;
      subdomain = t.provider === 'metered' ? t.subdomain : '';
      apiKey = t.provider === 'metered' ? t.apiKey : '';
      url = t.provider === 'custom' ? t.url : '';
      result = null;
      detail = null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  });

  function current(): Settings {
    if (provider === 'metered') return { turn: { provider: 'metered', subdomain, apiKey } };
    if (provider === 'custom') return { turn: { provider: 'custom', url } };
    return { turn: { provider: 'none' } };
  }

  let endpoint = $derived(turnCredentialsUrl(current()));

  /**
   * Fetch credentials, then gather ICE with `iceTransportPolicy: 'relay'`.
   *
   * That policy discards host and server-reflexive candidates outright, so
   * anything that arrives had to come through the relay. Without it a working
   * STUN path masks a broken TURN one — a `srflx` candidate only proves STUN
   * works, which it already did.
   */
  async function test(): Promise<void> {
    testing = true;
    result = null;
    detail = null;
    try {
      resetIceServersCache();
      const servers = await iceServers(endpoint);
      if (!hasRelay(servers)) {
        result = { ok: false, text: 'No relay in the response — STUN only, so phones will still fail.' };
        return;
      }

      const check = await runRelayCheck(servers);
      const verdict = summarise(check);
      detail = check;
      result = { ok: verdict.verdict === 'ok', text: verdict.text };
    } catch (err) {
      result = { ok: false, text: `Could not reach the credential endpoint: ${String(err)}` };
    } finally {
      testing = false;
    }
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    resetIceServersCache();
    onSave(current());
  }
</script>

<dialog class="sheet" bind:this={dialog} onclose={onCancel} oncancel={onCancel}>
  <form onsubmit={submit}>
    <h2>Settings</h2>

    <fieldset class="modes">
      <legend class="field-legend">Relay (TURN)</legend>

      <label class:is-selected={provider === 'none'}>
        <input type="radio" name="provider" value="none" bind:group={provider} />
        <span class="mode-name">None</span>
        <span class="mode-desc">STUN only — same network works, most phones will not</span>
      </label>

      <label class:is-selected={provider === 'metered'}>
        <input type="radio" name="provider" value="metered" bind:group={provider} />
        <span class="mode-name">Metered</span>
        <span class="mode-desc">Managed relay, free tier</span>
      </label>

      <label class:is-selected={provider === 'custom'}>
        <input type="radio" name="provider" value="custom" bind:group={provider} />
        <span class="mode-name">Custom endpoint</span>
        <span class="mode-desc">Anything returning ICE servers, including self-hosted</span>
      </label>
    </fieldset>

    {#if provider === 'metered'}
      <label class="field">
        <span>Subdomain</span>
        <input type="text" bind:value={subdomain} placeholder="waypoint" spellcheck="false" autocapitalize="off" autocomplete="off" />
      </label>
      <label class="field">
        <span>API key</span>
        <input type="password" bind:value={apiKey} spellcheck="false" autocomplete="off" />
      </label>
      <!--
        Metered issues three kinds of key and only one belongs here. The
        account secret key fetches credentials happily but is not itself a
        credential, so the relay then rejects the allocation — which surfaces
        as a 401 in the test detail rather than as anything obvious.
      -->
      <p class="field-hint">
        The credential-scoped key from <em>Add Credential</em>, not the account
        secret key on the Developers page.
      </p>
    {:else if provider === 'custom'}
      <label class="field">
        <span>Credentials URL</span>
        <input type="text" bind:value={url} placeholder="https://turn-auth.example/" spellcheck="false" autocapitalize="off" autocomplete="off" />
      </label>
    {/if}

    {#if provider !== 'none'}
      <p class="field-hint">
        Stored on this device only. It is never written to a space, never replicated,
        and never leaves this browser.
      </p>
    {/if}

    {#if result !== null}
      <p class="field-hint" class:field-error={!result.ok}>{result.text}</p>
    {/if}

    {#if detail !== null}
      <!--
        The detail is the useful half when it fails. Which endpoints were
        offered says whether the account tier matches them; the ICE errors say
        whether the relay refused or was never reached at all.
      -->
      <details class="relay-detail">
        <summary>Detail</summary>
        <p><strong>Servers offered</strong></p>
        <ul>
          {#each detail.servers as u (u)}<li>{u}</li>{/each}
        </ul>
        {#if detail.errors.length > 0}
          <p><strong>ICE errors</strong></p>
          <ul>
            {#each detail.errors as e, i (i)}<li>{e.code} {e.text} — {e.url}</li>{/each}
          </ul>
        {/if}
        <p>
          relay candidates {detail.relayCandidates}
          {#if detail.otherCandidates.length > 0}· without the relay policy: {detail.otherCandidates.join(', ')}{/if}
          · credentials attached: {detail.credentialed ? 'yes' : 'no'}
        </p>
      </details>
    {/if}

    <div class="actions">
      <button type="button" class="quiet" onclick={() => void test()} disabled={endpoint === null || testing}>
        {testing ? 'Testing…' : 'Test relay'}
      </button>
      <span class="actions-spacer"></span>
      <button type="button" class="quiet" onclick={onCancel}>Cancel</button>
      <button type="submit">Save</button>
    </div>
  </form>
</dialog>
