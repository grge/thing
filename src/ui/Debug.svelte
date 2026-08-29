<script lang="ts">
  import type { Space } from '../app/space.js';
  import { summarise, toRows } from '../app/inspect.js';
  import { hex } from '../fold/index.js';

  interface Props {
    space: Space;
    /** Bumped by the parent after a mutation, so rows re-derive. */
    version: number;
  }

  let { space, version }: Props = $props();

  let filter = $state('');
  let newestFirst = $state(true);

  let rows = $derived.by(() => {
    version;
    const all = toRows(space.log, space.state);
    const q = filter.trim().toLowerCase();
    const matched =
      q === ''
        ? all
        : all.filter(
            (r) =>
              r.attr.includes(q) ||
              r.value.toLowerCase().includes(q) ||
              r.targetLabel.toLowerCase().includes(q) ||
              r.target.startsWith(q) ||
              r.writer.startsWith(q),
          );
    return newestFirst ? [...matched].reverse() : matched;
  });

  let writers = $derived.by(() => {
    version;
    return summarise(space.log);
  });

  function copyLog(): void {
    void navigator.clipboard.writeText(JSON.stringify(toRows(space.log, space.state), null, 2));
  }
</script>

<div class="debug">
  <div class="pane-head">
    <span>log · {space.record.name}</span>
    <span>{space.eventCount} events</span>
  </div>

  <div class="debug-summary">
    <table>
      <thead>
        <tr>
          <th>writer</th>
          <th>events</th>
          <th>contiguous</th>
          <th>highest</th>
          <th>past gap</th>
        </tr>
      </thead>
      <tbody>
        {#each writers as w (w.full)}
          <tr>
            <td>{w.writer}</td>
            <td class="num">{w.count}</td>
            <td class="num">{w.contiguous}</td>
            <td class="num">{w.highest}</td>
            <td class="num" class:has-gap={w.gaps.length > 0}>
              {w.gaps.length === 0 ? '—' : w.gaps.join(' ')}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="debug-note">
      A version vector reports the highest <em>contiguous</em> seq (§3.1). Anything
      under “past gap” is held but unapplied until the missing event arrives (§3.3).
    </p>
  </div>

  <div class="debug-controls">
    <input
      type="search"
      placeholder="filter by attr, value, name, uuid, writer"
      bind:value={filter}
    />
    <button type="button" onclick={() => (newestFirst = !newestFirst)}>
      {newestFirst ? 'newest first' : 'oldest first'}
    </button>
    <button type="button" onclick={copyLog}>Copy JSON</button>
  </div>

  <div class="debug-log">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>writer</th>
          <th>seq</th>
          <th>lam</th>
          <th>prev</th>
          <th>target</th>
          <th>attr</th>
          <th>value</th>
          <th>wall</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.index)}
          <tr>
            <td class="num">{r.index}</td>
            <td>{r.writer}</td>
            <td class="num">{r.seq}</td>
            <td class="num">{r.lamport}</td>
            <td>{r.prev ?? '—'}</td>
            <td title={r.target}>{r.targetLabel}</td>
            <td>{r.attr}</td>
            <td class="value">{r.value}</td>
            <td class="muted">{r.wall}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}
      <p class="debug-note">
        {space.eventCount === 0 ? 'The log is empty.' : 'No events match that filter.'}
      </p>
    {/if}
  </div>
</div>
