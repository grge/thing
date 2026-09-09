<!--
  What an object actually is, above whatever is showing it.

  **The fold's own vocabulary, not a friendly summary.** Every object is the
  same handful of things — a uuid, a parent, a set of attribute slices, and
  maybe a body (§3.1) — and a view that paraphrases them hides exactly what you
  need when something is wrong. So this shows the slices, and names the *rule*
  each one folded by, because that is the thing that decides what a value means.

  Three of these are only ever interesting when something has gone wrong, and
  are shown only then: `bodyRuleMissing` (a `:kind` naming a rule this client
  does not have — §3.4's unreadable body), `cycleBroken` (re-parented to break a
  cycle — §3.4), and a slice's `pending` entries (events held aside because
  their rule could not place them yet).
-->
<script lang="ts">
  import { hex, type State, type Uuid } from '@thing/engine';
  import Icon from './Icon.svelte';

  interface Props {
    /** Named `folded` rather than `state`: the latter collides with `$state`. */
    folded: State;
    spaceId: string;
    id: Uuid;
  }

  const { folded, spaceId, id }: Props = $props();

  let open = $state(false);
  let copied = $state<string | null>(null);

  const object = $derived(folded.objects.get(hex(id)) ?? null);

  /** A slice's value as something readable, without pretending to know it. */
  function show(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (value instanceof Uint8Array) return hex(value);
    // The sequence rule renders a list of runs; anything else is shown as
    // whatever it is rather than guessed at.
    if (Array.isArray(value)) return `${value.length} element(s)`;
    return typeof value;
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => (copied = null), 1200);
    } catch {
      copied = null;
    }
  }

  const attrs = $derived([...(object?.attrs ?? new Map())].sort(([a], [b]) => (a < b ? -1 : 1)));
</script>

{#if object !== null}
  <div class="head">
    <button class="toggle" onclick={() => (open = !open)} title="What this object is">
      <Icon name="activity" />
      <code>{hex(id).slice(0, 12)}</code>
    </button>

    {#if object.bodyRuleMissing !== undefined}
      <!-- §3.4: the structure folded, the body did not. Worth saying loudly,
           because the object looks ordinary otherwise. -->
      <span class="warn" title="No rule for this :kind on this client">
        unreadable body: {object.bodyRuleMissing}
      </span>
    {/if}
    {#if object.cycleBroken}
      <span class="warn" title="Re-parented to break a cycle (§3.4)">re-parented</span>
    {/if}
    {#if copied !== null}<span class="muted">copied {copied}</span>{/if}
  </div>

  {#if open}
    <table class="detail">
      <tbody>
        <tr>
          <th>object</th>
          <td>
            <code>{hex(id)}</code>
            <button class="tiny" onclick={() => void copy(hex(id), 'id')}>copy</button>
          </td>
        </tr>
        <tr>
          <th>space</th>
          <td>
            <code>{spaceId}</code>
            <button class="tiny" onclick={() => void copy(spaceId, 'space')}>copy</button>
          </td>
        </tr>
        <tr>
          <th>parent</th>
          <td><code>{hex(object.parent)}</code></td>
        </tr>
        <tr>
          <th>body</th>
          <td>
            {#if object.body !== undefined}
              <code>{object.body.rule}</code>
              <span class="muted">{show(object.body.value)}</span>
              {#if object.body.pending !== undefined && object.body.pending.length > 0}
                <span class="warn">{object.body.pending.length} held</span>
              {/if}
            {:else if object.bodyRuleMissing !== undefined}
              <span class="warn">rule <code>{object.bodyRuleMissing}</code> not held here</span>
            {:else}
              <span class="muted">none — a folder (§4.2)</span>
            {/if}
          </td>
        </tr>
        {#each attrs as [attrName, slice] (attrName)}
          <tr>
            <th><code>{attrName}</code></th>
            <td>
              <span>{show(slice.value)}</span>
              <span class="muted">{slice.rule}</span>
              {#if slice.pending !== undefined && slice.pending.length > 0}
                <span class="warn">{slice.pending.length} held</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<style>
  .head {
    display: flex; align-items: center; gap: var(--space-2);
    font-size: 0.75rem; padding-bottom: var(--space-1);
  }
  .toggle {
    display: inline-flex; align-items: center; gap: var(--space-1);
    background: none; border: none; color: var(--ink-muted);
    cursor: pointer; padding: 0; font: inherit;
  }
  .toggle:hover { color: var(--ink); }
  .detail {
    border-collapse: collapse; width: 100%;
    font-size: 0.75rem; margin-bottom: var(--space-2);
  }
  .detail th {
    text-align: left; font-weight: 500; color: var(--ink-muted);
    padding: 1px var(--space-2) 1px 0; white-space: nowrap; vertical-align: top;
  }
  /* A long hex id and its button on one line: the id wraps, the button does
     not get pushed onto a line of its own. */
  .detail td {
    padding: 1px 0;
    display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1);
  }
  .detail code { word-break: break-all; }
  .detail td > span { margin-right: var(--space-2); }
  code { font-family: var(--mono); font-size: 0.72rem; }
  .muted { color: var(--ink-muted); }
  .warn { color: var(--ink); font-weight: 600; }
  .tiny {
    background: none; border: 1px solid var(--rule); color: var(--ink-muted);
    cursor: pointer; padding: 0 var(--space-1); font: inherit; font-size: 0.68rem;
    border-radius: 2px; margin-left: var(--space-1);
  }
  .tiny:hover { color: var(--ink); }
</style>
