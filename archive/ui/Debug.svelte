<script lang="ts">
  import type { Space } from '../app/space.js';
  import { summarise, toRows } from '../app/inspect.js';
  import { hex } from '../fold/index.js';
  import { metrics } from '../net/metrics.js';

  interface Props {
    space: Space;
    /** Bumped by the parent after a mutation, so rows re-derive. */
    version: number;
  }

  let { space, version }: Props = $props();

  let filter = $state('');
  let newestFirst = $state(true);

  /**
   * Two things are worth seeing when a space misbehaves, and they answer
   * different questions: the log says what the *model* did, the network view
   * says whether the bytes ever arrived. Before this, a reader stuck on an
   * empty tree looked identical whether the fold was wrong or the connection
   * never negotiated.
   */
  let view = $state<'events' | 'network'>('events');

  /**
   * `metrics` is a plain module singleton with no reactivity — deliberately,
   * since the transport should not depend on a UI framework. Polling while the
   * network view is open is the cheap way to read it, and this is a debug
   * screen: a second of staleness costs nothing.
   */
  let tick = $state(0);
  $effect(() => {
    if (view !== 'network') return;
    const id = setInterval(() => (tick += 1), 1000);
    return () => clearInterval(id);
  });

  let connections = $derived.by(() => {
    tick;
    return [...metrics.connections].reverse();
  });

  let netSummary = $derived.by(() => {
    tick;
    return metrics.summary();
  });

  let signalling = $derived.by(() => {
    tick;
    return [...metrics.signalling].reverse();
  });

  function clock(at: number): string {
    return new Date(at).toISOString().slice(11, 23);
  }

  function bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * The negotiation result in one cell: which candidate types won, over what.
   * `relay` on either end means TURN carried it — the number question 1 asks
   * for, read from stats rather than inferred from what was configured.
   */
  function pairText(c: (typeof connections)[number]): string {
    if (c.pair === null) return c.connectedAt === null ? '—' : 'pending';
    const { local, remote, protocol, relayProtocol } = c.pair;
    const via = relayProtocol === null ? (protocol ?? '?') : `${protocol ?? '?'}/${relayProtocol}`;
    return `${local ?? '?'} → ${remote ?? '?'} · ${via}`;
  }

  function linkState(c: (typeof connections)[number]): string {
    if (c.failedAt !== null) return 'failed';
    if (c.iceStates.length > 0) return c.iceStates[c.iceStates.length - 1]!;
    return c.connectedAt === null ? 'connecting' : 'open';
  }

  function copyMetrics(): void {
    void navigator.clipboard.writeText(metrics.toJSON());
  }

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
    <span class="pane-head-left">
      <span class="viewswitch viewswitch--inline" role="group" aria-label="Log view">
        <button type="button" aria-pressed={view === 'events'} onclick={() => (view = 'events')}>Events</button>
        <button type="button" aria-pressed={view === 'network'} onclick={() => (view = 'network')}>Network</button>
      </span>
      <span>{space.record.name}</span>
    </span>
    <span>
      {#if space.writerState !== null}
        writer {space.writerId === null ? '—' : hex(space.writerId).slice(0, 6)}…
        · seq {space.writerState.seq} · lamport {space.writerState.lamport}
      {:else}
        read-only
      {/if}
    </span>
  </div>

  {#if view === 'network'}
    <div class="debug-summary">
      <table>
        <thead>
          <tr>
            <th>attempts</th>
            <th>connected</th>
            <th>failed</th>
            <th>relayed</th>
            <th>direct</th>
            <th>median connect</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="num">{netSummary.attempts}</td>
            <td class="num">{netSummary.connected}</td>
            <td class="num" class:has-gap={netSummary.failed > 0}>{netSummary.failed}</td>
            <td class="num">{netSummary.relayed}</td>
            <td class="num">{netSummary.direct}</td>
            <td class="num">{netSummary.medianConnectMs === null ? '—' : `${netSummary.medianConnectMs} ms`}</td>
          </tr>
        </tbody>
      </table>
      <p class="debug-note">
        <em>relayed</em> means a TURN relay carried the connection — the headline
        number for POC question 1, read from live ICE stats rather than from what
        was configured. <em>direct</em> means the peers reached each other without
        one. Counts are for this tab since it loaded, across every space.
      </p>
    </div>

    <div class="debug-controls">
      <span class="debug-note debug-note--inline">
        {connections.length === 0 ? 'No connection attempts yet.' : `${connections.length} attempts, newest first`}
      </span>
      <button type="button" onclick={copyMetrics}>Copy JSON</button>
    </div>

    <div class="debug-log">
      <table>
        <thead>
          <tr>
            <th>peer</th>
            <th>dir</th>
            <th>state</th>
            <th>negotiated</th>
            <th>relay</th>
            <th>connect</th>
            <th>sent</th>
            <th>recv</th>
            <th>ice</th>
          </tr>
        </thead>
        <tbody>
          {#each connections as c (c.peer + c.startedAt)}
            <tr>
              <td title={c.peer}>{c.peer.slice(0, 18)}{c.peer.length > 18 ? '…' : ''}</td>
              <td class="muted">{c.direction === 'dialled' ? 'out' : 'in'}</td>
              <td class:has-gap={c.failedAt !== null}>{linkState(c)}</td>
              <td>{pairText(c)}</td>
              <td class:has-gap={c.usedRelay === true}>
                {c.usedRelay === null ? '—' : c.usedRelay ? 'TURN' : 'direct'}
              </td>
              <td class="num">
                {c.connectedAt === null ? '—' : `${c.connectedAt - c.startedAt} ms`}
              </td>
              <td class="num">{bytes(c.bytesSent)}</td>
              <td class="num">{bytes(c.bytesReceived)}</td>
              <td class="muted" title={c.iceStates.join(' → ')}>{c.iceStates.join(' → ') || '—'}</td>
            </tr>
            {#if c.error !== null}
              <tr>
                <td></td>
                <td colspan="8" class="has-gap">{c.error}</td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
      {#if connections.length === 0}
        <p class="debug-note">
          Nothing has tried to connect. A local space never will; a mode 2 space
          records an attempt as soon as it dials or is dialled — so if this is
          empty and the signalling trail below shows an error, the broker was
          never reached and no connection was ever possible.
        </p>
      {/if}

      <div class="pane-head"><span>signalling</span></div>
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>kind</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {#each signalling as e, i (e.at + ':' + i)}
            <tr>
              <td class="muted">{clock(e.at)}</td>
              <td class:has-gap={e.kind === 'error'}>{e.kind}</td>
              <td class="value">{e.detail}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if signalling.length === 0}
        <p class="debug-note">Nothing from the signalling layer yet.</p>
      {/if}
    </div>
  {:else}
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
  {/if}
</div>
