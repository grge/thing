<script lang="ts">
  /**
   * A one-field name prompt. Replaces `window.prompt`, which cannot be styled,
   * blocks the page, and on some browsers is suppressed entirely.
   */
  interface Props {
    open: boolean;
    title: string;
    initial: string;
    confirmLabel: string;
    onCancel: () => void;
    onConfirm: (value: string) => void;
  }

  let { open, title, initial, confirmLabel, onCancel, onConfirm }: Props = $props();

  let value = $state('');
  let dialog = $state<HTMLDialogElement | null>(null);
  let field = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const d = dialog;
    if (d === null) return;
    if (open && !d.open) {
      value = initial;
      d.showModal();
      queueMicrotask(() => {
        field?.focus();
        // Select the stem, not the extension — renaming rarely changes it.
        const dot = value.lastIndexOf('.');
        field?.setSelectionRange(0, dot > 0 ? dot : value.length);
      });
    } else if (!open && d.open) {
      d.close();
    }
  });

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const v = value.trim();
    if (v === '') return;
    onConfirm(v);
  }
</script>

<dialog class="sheet" bind:this={dialog} onclose={onCancel} oncancel={onCancel}>
  <form onsubmit={submit}>
    <h2>{title}</h2>
    <label class="field">
      <span>Name</span>
      <input type="text" bind:value bind:this={field} autocomplete="off" />
    </label>
    <div class="actions">
      <button type="button" class="quiet" onclick={onCancel}>Cancel</button>
      <button type="submit" disabled={value.trim() === ''}>{confirmLabel}</button>
    </div>
  </form>
</dialog>
