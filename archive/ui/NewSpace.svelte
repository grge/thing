<script lang="ts">
  import type { SpaceMode } from '../app/storage.js';
  import { parseShareInput } from '../app/address.js';

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

  function safeParse(u: string): { name: string; id: string; kind: 'key' | 'code' } | null {
    try {
      const p = parseShareInput(u);
      if (p === null) return null;
      // A link previews the name it suggests and the key it names; a typed code
      // can only preview itself, since the identity is not known until a peer
      // answers (DESIGN.md §4.4).
      return p.kind === 'key'
        ? { name: p.name === '' ? 'shared' : p.name, id: p.id.slice(0, 12), kind: 'key' }
        : { name: 'shared', id: p.code, kind: 'code' };
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

      <label class:is-selected={choice === 'local'}>
        <input type="radio" name="mode" value="local" bind:group={choice} bind:this={firstField} />
        <span class="mode-name">Local</span>
        <span class="mode-desc">This device only</span>
      </label>

      <label class:is-selected={choice === 'writer'}>
        <input type="radio" name="mode" value="writer" bind:group={choice} />
        <span class="mode-name">Shared</span>
        <span class="mode-desc">You write, others read</span>
      </label>

      <label class:is-selected={choice === 'join'}>
        <input type="radio" name="mode" value="join" bind:group={choice} />
        <span class="mode-name">Join</span>
        <span class="mode-desc">Open someone's shared space</span>
      </label>
    </fieldset>

    {#if choice === 'join'}
      <label class="field">
        <span>Link or code</span>
        <input
          type="text"
          bind:value={url}
          placeholder="k7mfq2xw"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
      </label>
      {#if url.trim() !== '' && parsed === null}
        <p class="field-error">Not a link or code.</p>
      {:else if parsed !== null}
        <!--
          A link and a typed code carry different guarantees, so they preview
          differently rather than both claiming to know what will be joined
          (DESIGN.md §4.4). A link names a key and can be verified on contact; a
          code names a rendezvous slot and cannot be checked until a peer
          answers.
        -->
        <p class="field-hint">
          Joins <strong>{parsed.name}</strong>, read-only.
          {#if parsed.kind === 'key'}
            <br />Verified by key <code>{parsed.id}…</code>
          {:else}
            <br />Code <code>{parsed.id}</code> — identity confirmed on first contact.
          {/if}
        </p>
      {/if}
    {:else}
      <label class="field">
        <span>Name</span>
        <input type="text" bind:value={name} placeholder="scratch" autocomplete="off" />
      </label>
      {#if choice === 'writer'}
        <p class="field-hint">Readers need you online to join.</p>
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
