<script lang="ts">
  interface Props {
    open: boolean;
    name: string;
    objectCount: number;
    onCancel: () => void;
    onConfirm: () => void;
  }

  let { open, name, objectCount, onCancel, onConfirm }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    const d = dialog;
    if (d === null) return;
    if (open && !d.open) {
      d.showModal();
      // Focus Cancel, not the destructive action.
      queueMicrotask(() => cancelButton?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  });
</script>

<dialog class="sheet" bind:this={dialog} onclose={onCancel} oncancel={onCancel}>
  <div class="confirm">
    <h2>Delete “{name}”?</h2>
    <p>
      Its event log and {objectCount} object{objectCount === 1 ? '' : 's'} are removed
      from this device. Files whose content no other space uses are deleted too.
    </p>
    <p class="field-hint">
      This cannot be undone here. A peer that still holds the space keeps its own
      copy — deleting is local, not a request to anyone else.
    </p>
    <div class="actions">
      <button type="button" class="quiet" bind:this={cancelButton} onclick={onCancel}>
        Cancel
      </button>
      <button type="button" class="danger" onclick={onConfirm}>Delete</button>
    </div>
  </div>
</dialog>
