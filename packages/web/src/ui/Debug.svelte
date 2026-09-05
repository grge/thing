<script lang="ts">
  /**
   * What is actually happening.
   *
   * Organised around the three channels a connection carries (§10), because
   * that is the structure of the system rather than a convenient grouping:
   *
   * | log       | signed events, permanent, replicated to everyone |
   * | blobs     | content-addressed bytes, pulled by whoever wants them |
   * | ephemeral | availability and presence, expires, never stored |
   *
   * Plus **peers** (who is connected and how) and **sync** (what peers disagree
   * about). Everything has a place here even where this stage does not fill it
   * — an empty panel that says why is more useful than a missing one, because
   * it tells you the thing exists and is quiet rather than leaving you
   * wondering whether it is broken.
   */
  import { hex } from '@thing/engine';
  import type { Space } from '@thing/engine';
  import type { Client, SpaceStatus } from '../client.js';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.js';

  interface Props {
    client: Client;
    space: SpaceStatus | null;
    open: Space | null;
    epoch: number;
    onclose: () => void;
  }

  const { client, space, open, epoch, onclose }: Props = $props();

  type Panel = 'log' | 'peers' | 'sync' | 'ephemeral' | 'events';

  /** One per thing worth looking at, in the order they matter when debugging. */
  const PANELS: { id: Panel; label: string; icon: IconName }[] = [
    { id: 'log', label: 'activity', icon: 'activity' },
    { id: 'peers', label: 'peers', icon: 'users' },
    { id: 'sync', label: 'sync', icon: 'gitFork' },
    { id: 'ephemeral', label: 'ephemeral', icon: 'radio' },
    { id: 'events', label: 'state', icon: 'boxes' },
  ];

  let panel = $state<Panel>('log');

  const activity = $derived.by(() => {
    void epoch;
    return client.recent().filter((a) => space === null || a.space === null || a.space === space.id);
  });

  const peers = $derived.by(() => {
    void epoch;
    return client.peers().filter((p) => space === null || p.space === space.id);
  });

  /** Every event in the space, newest first. The fold made legible. */
  const events = $derived.by(() => {
    void epoch;
    if (open === null) return [];
    const rows: {
      writer: string;
      seq: number;
      target: string;
      attr: string;
      size: number;
    }[] = [];
    // Read from folded state rather than the store: this is what the client
    // actually resolved, which is the thing worth inspecting.
    for (const [key, o] of open.state.objects) {
      for (const [attr, slice] of o.attrs) {
        rows.push({
          writer: '—',
          seq: 0,
          target: key.slice(0, 8),
          attr,
          size: String(slice.value ?? '').length,
        });
      }
      if (o.body !== undefined) {
        rows.push({ writer: '—', seq: 0, target: key.slice(0, 8), attr: ':body', size: 0 });
      }
    }
    return rows;
  });

  const vv = $state<{ writer: string; frontier: number; tip: string }[]>([]);
  $effect(() => {
    void epoch;
    if (open === null) return;
    void open.versionVector().then((map) => {
      vv.length = 0;
      for (const [writer, f] of map) {
        vv.push({ writer: writer.slice(0, 8), frontier: f.frontier, tip: hex(f.tip).slice(0, 8) });
      }
    });
  });

  function clock(at: number): string {
    return new Date(at).toISOString().slice(11, 19);
  }

  function ago(at: number): string {
    const s = Math.round((Date.now() - at) / 1000);
    return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
  }
</script>

<div class="debug">
  <div class="pane-head">
    <span class="viewswitch" role="group" aria-label="Debug view">
      {#each PANELS as p (p.id)}
        <button
          class="switch"
          class:on={panel === p.id}
          onclick={() => (panel = p.id)}
          title={p.label}
          aria-pressed={panel === p.id}
        >
          <Icon name={p.icon} />
          <span class="switch-label">{p.label}</span>
        </button>
      {/each}
    </span>
    <span class="pane-spacer"></span>
    <button onclick={onclose} title="Close" aria-label="Close"><Icon name="x" /></button>
  </div>

  <div class="debug-body">
    {#if panel === 'log'}
      <!-- Everything, across all three channels, newest first. -->
      {#if activity.length === 0}
        <p class="debug-note">Nothing yet. Connect to a peer, or write something.</p>
      {:else}
        <table class="debug-table">
          <tbody>
            {#each activity as a (a.at + a.text)}
              <tr>
                <td class="muted mono">{clock(a.at)}</td>
                <td class="chan chan--{a.channel}">{a.channel}</td>
                <td>{a.text}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if panel === 'peers'}
      {#if peers.length === 0}
        <p class="debug-note">
          No peers. A browser cannot be dialled, so it dials one with an address or is introduced
          to one without.
        </p>
      {:else}
        <table class="debug-table">
          <thead>
            <tr><th>peer</th><th>how</th><th>state</th><th>for</th></tr>
          </thead>
          <tbody>
            {#each peers as p (p.id)}
              <tr>
                <td class="mono">{p.id}</td>
                <td class="muted">{p.kind === 'direct' ? 'dialled' : 'introduced'}</td>
                <td class:has-gap={p.state === 'failed'}>{p.state}</td>
                <td class="num">{ago(p.since)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if panel === 'sync'}
      <!-- What this peer knows, and what any peer disagrees about (§2.3). -->
      <h4 class="debug-head">version vector</h4>
      {#if vv.length === 0}
        <p class="debug-note">Nothing written yet.</p>
      {:else}
        <table class="debug-table">
          <thead>
            <tr><th>writer</th><th>frontier</th><th>tip</th></tr>
          </thead>
          <tbody>
            {#each vv as row (row.writer)}
              <tr>
                <td class="mono">{row.writer}</td>
                <td class="num">{row.frontier}</td>
                <td class="mono muted">{row.tip}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="debug-note">
          The tip is what makes a fork detectable: two peers can agree on a frontier while holding
          different histories.
        </p>
      {/if}

      <h4 class="debug-head">forks</h4>
      {#if space === null || space.forks.length === 0}
        <p class="debug-note">None. A forked chain would be listed here and nowhere else.</p>
      {:else}
        <table class="debug-table">
          <tbody>
            {#each space.forks as f (f.writer + f.frontier)}
              <tr>
                <td class="mono">{f.writer.slice(0, 8)}</td>
                <td class="num">{f.frontier}</td>
                <td class="mono muted">{f.mine.slice(0, 8)} ≠ {f.theirs.slice(0, 8)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="debug-note">
          Detected, not repaired. Fetching the competing branch needs a request the protocol does
          not have yet; the rest of the space syncs normally.
        </p>
      {/if}
    {:else if panel === 'ephemeral'}
      <!-- The third channel. Never stored, so it is invisible without this. -->
      <p class="debug-note">
        Blob availability and presence. Expires, never enters the log, and is not signed — the
        transport already establishes who sent it, and nothing here is a claim you have to believe.
      </p>
      {#if activity.filter((a) => a.channel === 'ephemeral').length === 0}
        <p class="debug-note">Quiet. Nothing has announced anything.</p>
      {:else}
        <table class="debug-table">
          <tbody>
            {#each activity.filter((a) => a.channel === 'ephemeral') as a (a.at + a.text)}
              <tr><td class="muted mono">{clock(a.at)}</td><td>{a.text}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else}
      <!-- Folded state: every object, every slice, and the rule that resolved it. -->
      {#if open === null}
        <p class="debug-note">No space open.</p>
      {:else}
        <table class="debug-table">
          <thead>
            <tr><th>object</th><th>slice</th><th>value</th><th>rule</th></tr>
          </thead>
          <tbody>
            {#each [...open.state.objects] as [key, o] (key)}
              {#each [...o.attrs] as [attr, slice] (attr)}
                <tr>
                  <td class="mono muted">{key.slice(0, 8)}</td>
                  <td>{attr}</td>
                  <td class="value">{String(slice.value ?? '—').slice(0, 40)}</td>
                  <td class="muted">{slice.rule}</td>
                </tr>
              {/each}
              {#if o.bodyRuleMissing !== undefined}
                <tr>
                  <td class="mono muted">{key.slice(0, 8)}</td>
                  <td>:body</td>
                  <td class="has-gap">no rule for {o.bodyRuleMissing}</td>
                  <td class="muted">—</td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
        <p class="debug-note">
          {events.length} slice(s). Attributes always resolve the same way, whatever the bodies turn
          out to be — which is why an unknown rule costs one object rather than a space.
        </p>
      {/if}
    {/if}
  </div>
</div>
