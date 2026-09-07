<!--
  What this browser is configured to do.

  Three things, and they are not the same kind of thing:

  **Signalling and ICE** are how a peer is *reached* — addresses, not identity,
  and disposable in exactly the way §5.2 says locators are. Getting them wrong
  costs a failed connection.

  **Keys** are the opposite. §5.1.1 calls key loss the largest unresolved risk
  in the design: clearing site data destroys the ability to write to your own
  space, permanently, with no recovery and no way to tell readers. So the key
  section is an export, and it is the reason this panel exists at all.

  Changes take effect on **reload**, and this says so rather than pretending
  otherwise — a `Client` reads both at construction, and reconnecting every
  peer to apply a preference would drop live transfers to no purpose.
-->
<script lang="ts">
  import type { Client, Tab } from '../client.js';
  import type { Settings } from '../local.js';
  import Icon from './Icon.svelte';

  interface Props {
    client: Client;
    tabs: readonly Tab[];
    onclose: () => void;
  }

  const { client, tabs, onclose }: Props = $props();

  // Read once, on open: these are the values being *edited*, so re-reading
  // them on every change would fight the person typing. `hasSaved` tracks what
  // is on disk, for the "reload to apply" line.
  // svelte-ignore state_referenced_locally
  const initial = client.settings();
  let signalling = $state(initial.signallingUrl ?? '');
  let ice = $state((initial.iceServers ?? []).map(urlsOf).join('\n'));
  let iceSet = $state(initial.iceServers !== undefined);
  let hasSaved = $state(
    initial.signallingUrl !== undefined || initial.iceServers !== undefined,
  );
  let dirty = $state(false);
  let shown = $state<string | null>(null);
  let error = $state<string | null>(null);

  function urlsOf(server: RTCIceServer): string {
    return Array.isArray(server.urls) ? server.urls.join(' ') : String(server.urls);
  }

  function save(): void {
    error = null;
    const next: Settings = {
      ...(signalling.trim() === '' ? {} : { signallingUrl: signalling.trim() }),
      // An empty list is a real choice — no STUN, local network only — so it is
      // kept as `[]` rather than folded into "unset", which would silently
      // restore the default.
      ...(iceSet ? { iceServers: parseIce(ice) } : {}),
    };
    client.saveSettings(next);
    hasSaved = next.signallingUrl !== undefined || next.iceServers !== undefined;
    dirty = false;
  }

  function parseIce(text: string): RTCIceServer[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => ({ urls: line.split(/\s+/) }));
  }

  async function copyKey(id: string): Promise<void> {
    const seed = client.exportKey(id);
    if (seed === null) {
      error = 'This browser holds no writing key for that space.';
      return;
    }
    try {
      await navigator.clipboard.writeText(seed);
      shown = id;
    } catch {
      error = 'Could not reach the clipboard.';
    }
  }
</script>

<aside class="settings">
  <header>
    <h2>Settings</h2>
    <button class="shut" onclick={onclose} aria-label="Close settings" title="Close">
      <Icon name="x" />
    </button>
  </header>

  <div class="body">
    <section>
      <h3>Signalling</h3>
      <p class="muted">
        Where to meet a peer by short code. An address, not an identity — a wrong
        one costs a failed connection and nothing else.
      </p>
      <input
        bind:value={signalling}
        oninput={() => (dirty = true)}
        placeholder="wss://… (blank uses the built-in default)"
      />
    </section>

    <section>
      <h3>ICE servers</h3>
      <p class="muted">
        One per line; several URLs on a line are one server. Leave unset for the
        default, or set it empty for local network only.
      </p>
      <label class="check">
        <input
          type="checkbox"
          bind:checked={iceSet}
          onchange={() => (dirty = true)}
        />
        Use my own list
      </label>
      <textarea
        bind:value={ice}
        disabled={!iceSet}
        oninput={() => (dirty = true)}
        rows="3"
        placeholder="stun:stun.l.google.com:19302"
      ></textarea>
    </section>

    <section>
      <h3>Keys</h3>
      <p class="muted">
        <strong>Losing a key cannot be undone.</strong> Clearing this browser's
        site data destroys the ability to write to a space you made, with no
        recovery and no way to tell anyone reading it. Copy the seed somewhere
        safe.
      </p>
      {#if tabs.length === 0}
        <p class="muted">No spaces open.</p>
      {:else}
        <table>
          <tbody>
            {#each tabs as tab (tab.id)}
              <tr>
                <td>{tab.name ?? tab.id.slice(0, 8)}</td>
                <td><code>{tab.id.slice(0, 16)}</code></td>
                <td>{tab.writable ? 'writable' : 'read-only'}</td>
                <td class="right">
                  <button onclick={() => void copyKey(tab.id)}>
                    {shown === tab.id ? 'Copied' : 'Copy key'}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button class="save" onclick={save} disabled={!dirty}>Save</button>
      {#if !dirty && hasSaved}
        <span class="muted">Saved — reload to apply.</span>
      {/if}
    </div>
  </div>
</aside>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--rule);
    font-size: 0.8rem;
    height: 20rem;
    flex: 0 0 auto;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--rule);
  }
  h2 { font-size: 0.85rem; margin: 0; }
  h3 { font-size: 0.78rem; margin: 0 0 var(--space-1); }
  .shut {
    background: none; border: none; color: var(--ink-muted);
    cursor: pointer; display: inline-flex; padding: 0;
  }
  .shut:hover { color: var(--ink); }
  /* Two columns where there is room: the three sections are independent, and
     one narrow column down the left of a wide screen wastes the space the
     panel already occupies. */
  .body {
    overflow-y: auto; padding: var(--space-3);
    display: grid; gap: var(--space-4) var(--space-5);
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    align-content: start;
  }
  .actions, .error { grid-column: 1 / -1; }
  p { margin: 0 0 var(--space-2); }
  .muted { color: var(--ink-muted); }
  input:not([type='checkbox']), textarea {
    width: 100%; background: none; color: var(--ink);
    border: 1px solid var(--rule); padding: var(--space-1) var(--space-2);
    font: inherit; font-size: 0.8rem;
  }
  textarea { font-family: var(--mono); font-size: 0.75rem; resize: vertical; }
  textarea:disabled { opacity: 0.5; }
  .check {
    display: flex; align-items: center; gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  .check input { width: auto; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 2px var(--space-2) 2px 0; }
  .right { text-align: right; }
  code { font-family: var(--mono); font-size: 0.75rem; }
  button {
    background: none; border: 1px solid var(--rule); color: var(--ink-muted);
    cursor: pointer; padding: 1px var(--space-2); font: inherit;
    font-size: 0.75rem; border-radius: 2px;
  }
  button:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  .actions { display: flex; align-items: center; gap: var(--space-2); }
  .save { padding: var(--space-1) var(--space-3); }
  .error { color: var(--ink); }
</style>
