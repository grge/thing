<script lang="ts">
  import type { SpaceMode } from '../app/storage.js';
  import { parseShareUrl } from '../app/storage.js';

  interface Props {
    open: boolean;
    onCancel: () => void;
    onCreate: (name: string, mode: SpaceMode) => void;
    onJoin: (url: string) => void;
  }

  let { open, onCancel, onCreate, onJoin }: Props = $props();

  /**
   * Mode is chosen first, because the three cases do not take the same input:
   * local and writer need a name, joining needs a URL and takes its name from
   * it. Selecting the mode first means the form below always matches the
   * choice, rather than offering fields that do not apply.
   *
   * Mode is fixed at creation (§8.3) — there is no promoting a local space
   * later — so this is the only moment it is ever chosen.
   */
  type Choice = 'local' | 'writer' | 'join';
  let choice = $state<Choice>('local');
  let name = $state('');
  let url = $state('');

  let dialog = $state<HTMLDialogElement | null>(null);
  let firstField = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const d = dialog;
    if (d === null) return;
    if (open && !d.open) {
      d.showModal();
      // Reset per opening, so a cancelled attempt does not leak into the next.
      choice = 'local';
      name = '';
      url = '';
      queueMicrotask(() => firstField?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  });

  /** Parsed only to validate and to preview what will be joined. */
  let parsed = $derived(url.trim() === '' ? null : safeParse(url.trim()));

  function safeParse(u: string): { name: string; id: string } | null {
    try {
      const rec = parseShareUrl(u);
      return rec === null ? null : { name: rec.name, id: rec.id };
    } catch {
      return null;
    }
  }

  let valid = $derived(choice === 'join' ? parsed !== null : name.trim() !== '');

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (!valid) return;
    if (choice === 'join') onJoin(url.trim());
    else onCreate(name.trim(), choice);
  }
</script>

<dialog
  class="sheet"
  bind:this={dialog}
  onclose={onCancel}
  oncancel={onCancel}
>
  <form onsubmit={submit}>
    <h2>New space</h2>

    <fieldset class="modes">
      <legend>Kind</legend>

      <label class:is-selected={choice === 'local'}>
        <input type="radio" name="mode" value="local" bind:group={choice} bind:this={firstField} />
        <span class="mode-name">Local</span>
        <span class="mode-desc">Only on this device. No peers, no sharing.</span>
      </label>

      <label class:is-selected={choice === 'writer'}>
        <input type="radio" name="mode" value="writer" bind:group={choice} />
        <span class="mode-name">Shared — you write</span>
        <span class="mode-desc">You own it. Others open your link and read along.</span>
      </label>

      <label class:is-selected={choice === 'join'}>
        <input type="radio" name="mode" value="join" bind:group={choice} />
        <span class="mode-name">Join someone's space</span>
        <span class="mode-desc">Paste a link you were sent. Read-only.</span>
      </label>
    </fieldset>

    {#if choice === 'join'}
      <label class="field">
        <span>Share link</span>
        <input
          type="url"
          bind:value={url}
          placeholder="http://…#space=…&host=…"
          spellcheck="false"
          autocomplete="off"
        />
      </label>
      {#if url.trim() !== '' && parsed === null}
        <p class="field-error">
          That is not a share link. It should contain <code>space</code> and
          <code>host</code>.
        </p>
      {:else if parsed !== null}
        <p class="field-hint">Joins <strong>{parsed.name}</strong> as a reader.</p>
      {/if}
    {:else}
      <label class="field">
        <span>Name</span>
        <input type="text" bind:value={name} placeholder="scratch" autocomplete="off" />
      </label>
      {#if choice === 'writer'}
        <p class="field-hint">
          Shareable once created — the tree header gets a <strong>Share</strong>
          button. Readers need you online to join.
        </p>
      {/if}
    {/if}

    <div class="actions">
      <button type="button" class="quiet" onclick={onCancel}>Cancel</button>
      <button type="submit" disabled={!valid}>
        {choice === 'join' ? 'Join' : 'Create'}
      </button>
    </div>
  </form>
</dialog>
