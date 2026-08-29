<script lang="ts">
  import { buildTree, flatten, wouldCycle } from '../app/tree.js';
  import type { Space } from '../app/space.js';
  import { Spaces } from '../app/spaces.js';
  import type { SpaceMode, SpaceRecord } from '../app/storage.js';
  import { parseShareUrl, shareUrl } from '../app/storage.js';
  import { Replication } from '../app/replication.js';
  import { hex, ROOT, type ObjectState } from '../fold/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import Debug from './Debug.svelte';
  import AskName from './AskName.svelte';
  import NewSpace from './NewSpace.svelte';
  import Preview from './Preview.svelte';
  import Tree from './Tree.svelte';

  let manager = $state<Spaces | null>(null);
  let spaces = $state<readonly SpaceRecord[]>([]);
  let activeId = $state<string | null>(null);
  let version = $state(0); // bumped to re-derive after a mutation
  /** Which tab a cross-space drag is hovering (§8.5). */
  let tabDropTarget = $state<string | null>(null);
  /** Debug view shows the raw log for the active space. Per-space, not global. */
  let showDebug = $state(false);
  let showNewSpace = $state(false);
  /** One name prompt, reused for rename and new-directory. */
  let ask = $state<{
    title: string;
    initial: string;
    confirmLabel: string;
    run: (value: string) => void;
  } | null>(null);

  /** One Replication per mode 2 space, keyed by space id (§8.3: N live). */
  const replication = new Map<string, Replication>();
  let peerIds = $state<Record<string, string>>({});
  let peerCounts = $state<Record<string, number>>({});
  let stalls = $state<string[]>([]);
  /** Blob hashes currently arriving, for the §8.2 `fetching` state. */
  let fetching = $state<Record<string, { got: number; total: number }>>({});
  let unavailable = $state<Record<string, true>>({});

  let expanded = $state(new SvelteSet<string>());
  let selected = $state<string | null>(null);
  let showDeleted = $state(false);
  let dropTarget = $state<string | null>(null);
  let dragging = $state<string | null>(null);
  let blob = $state<{ bytes: Uint8Array; mime: string } | null>(null);
  let loadingBlob = $state(false);
  let blobsHeld = $state(0);
  let message = $state<string | null>(null);

  // All registered spaces are opened at once and stay open (§8.3). Switching
  // tabs switches which one the panes show; it does not open or close anything.
  $effect(() => {
    void Spaces.load().then(async (m) => {
      manager = m;

      // A share URL joins the space it names (§7.2). Idempotent, so reopening
      // the link reuses the local log rather than re-fetching from zero.
      const shared = parseShareUrl(window.location.href);
      let focus = m.list[0]?.id ?? null;
      if (shared !== null) {
        const rec = await m.join(shared);
        focus = rec.id;
      }

      spaces = m.list;
      activeId = focus;
      version += 1;
      void refreshBlobCount();
      for (const rec of m.list) void startReplication(rec);
    });
  });

  /**
   * Bring a mode 2 space online. A writer waits to be dialled; a reader dials
   * the host named in its share URL — the star topology of §3.4.
   */
  async function startReplication(rec: SpaceRecord): Promise<void> {
    if (rec.mode === 'local' || replication.has(rec.id)) return;
    const sp = manager?.get(rec.id);
    if (sp === undefined || sp === null) return;

    const rep = new Replication(sp, {
      onChange: () => {
        version += 1;
        void refreshBlobCount();
      },
      onPeerOpen: () => {
        peerCounts = { ...peerCounts, [rec.id]: rep.peers.length };
        notify(`peer connected in ${rec.name}`);
      },
      onPeerClose: () => {
        peerCounts = { ...peerCounts, [rec.id]: rep.peers.length };
      },
      onError: (e) => notify(e),
      onStall: (w, from, to) => {
        // Loud by design (§3.3): in mode 2 a stall means the whole space stops.
        const line = `${rec.name}: writer ${w.slice(0, 6)}… stalled, missing ${from}–${to}`;
        stalls = [line, ...stalls.filter((s) => s !== line)].slice(0, 5);
      },
      onBlobProgress: (h, got, total) => {
        fetching = { ...fetching, [h]: { got, total } };
      },
      onBlobDone: (h) => {
        const { [h]: _done, ...rest } = fetching;
        fetching = rest;
      },
      onBlobUnavailable: (h) => {
        const { [h]: _gone, ...rest } = fetching;
        fetching = rest;
        unavailable = { ...unavailable, [h]: true };
      },
    });

    replication.set(rec.id, rep);
    try {
      const id = await rep.start();
      peerIds = { ...peerIds, [rec.id]: id };
      if (rec.host != null) await rep.connect(rec.host);
    } catch (err) {
      notify(`${rec.name}: ${String(err)}`);
    }
  }

  let space = $derived.by((): Space | null => {
    version;
    if (manager === null || activeId === null) return null;
    return manager.get(activeId);
  });

  // Selection is per-space; switching tabs clears it rather than pointing at a
  // uuid that means nothing in the newly visible log.
  let shownSpaceId = $state<string | null>(null);
  $effect(() => {
    if (activeId !== shownSpaceId) {
      shownSpaceId = activeId;
      selected = null;
      void refreshBlobCount();
    }
  });

  let tree = $derived.by(() => {
    version;
    return space === null ? [] : buildTree(space.state, showDeleted);
  });

  let selectedObj = $derived.by((): ObjectState | null => {
    version;
    if (space === null || selected === null) return null;
    return space.state.objects.get(selected) ?? null;
  });

  let childCount = $derived.by(() => {
    version;
    if (space === null || selected === null) return 0;
    let n = 0;
    for (const o of space.state.objects.values()) {
      if (hex(o.parent) === selected && !o.deleted) n += 1;
    }
    return n;
  });

  // Load the selected object's blob. This is the fetch trigger the preview pane
  // becomes in mode 2 (§8.2); in mode 1 it only reads the local store.
  $effect(() => {
    const obj = selectedObj;
    if (space === null || obj === null || obj.content === null) {
      blob = null;
      loadingBlob = false;
      return;
    }
    loadingBlob = true;
    const wanted = hex(obj.content);
    const sp = space;
    void sp.content(obj.content).then((got) => {
      if (selectedObj?.content == null || hex(selectedObj.content) !== wanted) return;
      blob = got;
      loadingBlob = false;
      if (got === null) {
        // Not held locally: ask peers for it. This is the fetch §6.1 defers
        // until the user opens something, and the preview pane is the trigger.
        const rep = replication.get(sp.record.id);
        if (rep !== undefined && obj.content !== null) {
          const { [wanted]: _prev, ...rest } = unavailable;
          unavailable = rest;
          rep.want(obj.content);
        }
      }
    });
  });

  /** Live fetch state for the selected blob, driving §8.2's five states. */
  let selectedHash = $derived(selectedObj?.content == null ? null : hex(selectedObj.content));
  let fetchProgress = $derived(selectedHash === null ? null : (fetching[selectedHash] ?? null));
  let isUnavailable = $derived(selectedHash !== null && unavailable[selectedHash] === true);

  async function refreshBlobCount(): Promise<void> {
    const sp = space;
    if (sp !== null) blobsHeld = await sp.blobs();
  }

  function notify(text: string): void {
    message = text;
    setTimeout(() => (message = null), 4000);
  }

  async function mutate(fn: (s: Space) => Promise<void>): Promise<void> {
    if (space === null) return;
    if (!space.writable) {
      notify('This space is read-only.');
      return;
    }
    await fn(space);
    version += 1;
    void refreshBlobCount();
    flushSpaces(space.record.id);
  }

  /**
   * Push anything newly written in these spaces to their peers (§3.4).
   *
   * Takes ids rather than assuming the visible space: a cross-space move (§8.5)
   * writes to *two* logs — fresh events in the destination, a tombstone in the
   * source — and both must reach their own peers. Flushing only the active
   * space left a reader showing stale state until it reloaded.
   */
  function flushSpaces(...ids: string[]): void {
    for (const id of ids) replication.get(id)?.flush();
  }

  /** Where a new object lands: inside the selection if it is a directory. */
  function targetDir(): Uint8Array {
    if (space === null || selected === null) return ROOT;
    const obj = space.state.objects.get(selected);
    if (obj === undefined) return ROOT;
    if (obj.kind === 'dir') return obj.uuid;
    return obj.parent;
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    await mutate(async (s) => {
      const parent = targetDir();
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const bytes = new Uint8Array(await f.arrayBuffer());
        await s.createFile(parent, f.name, bytes, f.type);
      }
      notify(`Added ${files.length} file${files.length === 1 ? '' : 's'}.`);
    });
  }

  /**
   * Paste text as a plaintext file (§8.4). The name comes from the first line,
   * truncated, with a timestamp fallback. Names are not unique (§4.2), so
   * collisions need no resolution.
   */
  async function pasteText(text: string): Promise<void> {
    const firstLine = text.split('\n', 1)[0]!.trim();
    const base = firstLine.slice(0, 40).replace(/[^\w .-]+/g, ' ').trim();
    const name = base.length > 0 ? `${base}.txt` : `pasted-${new Date().toISOString().slice(0, 19)}.txt`;
    await mutate(async (s) => {
      await s.createFile(targetDir(), name, new TextEncoder().encode(text), 'text/plain');
      notify(`Pasted as ${name}`);
    });
  }

  /**
   * Is the user typing into something? Window-level shortcuts and paste must
   * not fire then — a paste into the join field was landing as a new file,
   * because the handler had no notion of focus.
   */
  function isEditing(target: EventTarget | null): boolean {
    const el = target instanceof HTMLElement ? target : null;
    if (el === null) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /** Any dialog open owns the keyboard entirely. */
  function dialogOpen(): boolean {
    return document.querySelector('dialog[open]') !== null;
  }

  function onPaste(e: ClipboardEvent): void {
    if (isEditing(e.target) || dialogOpen()) return;
    if (space === null || !space.writable) return;
    const files = e.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text !== undefined && text.length > 0) {
      e.preventDefault();
      void pasteText(text);
    }
  }

  function onDropFiles(e: DragEvent): void {
    e.preventDefault();
    dropTarget = null;
    // Inert on a reader tab (§8.6): the gesture does nothing rather than
    // producing events that would then be refused.
    if (space === null || !space.writable) return;
    const files = e.dataTransfer?.files;
    if (files !== undefined && files.length > 0) void addFiles(files);
  }

  async function onDropOnRow(key: string): Promise<void> {
    dropTarget = null;
    const src = dragging;
    dragging = null;
    if (space === null || src === null || src === key) return;

    const target = space.state.objects.get(key);
    const moving = space.state.objects.get(src);
    if (target === undefined || moving === undefined) return;

    // Drop onto a file means "into the directory containing it".
    const destination = target.kind === 'dir' ? target.uuid : target.parent;

    // The fold would break a cycle deterministically (§4.1), but silently
    // re-parenting to ROOT is a baffling outcome — refusing is kinder.
    if (wouldCycle(space.state, moving.uuid, destination)) {
      notify('Cannot move a directory into itself.');
      return;
    }
    await mutate((s) => s.move(moving.uuid, destination));
  }

  function renameSelected(): void {
    if (space === null || selectedObj === null) return;
    const target = selectedObj.uuid;
    ask = {
      title: 'Rename',
      initial: selectedObj.name ?? '',
      confirmLabel: 'Rename',
      run: (next) => {
        ask = null;
        void mutate((s) => s.rename(target, next));
      },
    };
  }

  async function deleteSelected(): Promise<void> {
    if (selectedObj === null) return;
    await mutate((s) => s.setDeleted(selectedObj!.uuid, !selectedObj!.deleted));
  }

  function newDir(): void {
    ask = {
      title: 'New directory',
      initial: 'untitled',
      confirmLabel: 'Create',
      run: (name) => {
        ask = null;
        void mutate(async (s) => {
          await s.createDir(targetDir(), name);
        });
      },
    };
  }

  /**
   * Mode is fixed at creation (§8.3). There is no promoting a local space to a
   * shared one in v0, so this is the only place a mode is ever chosen.
   */
  async function createSpace(name: string, mode: SpaceMode): Promise<void> {
    if (manager === null) return;
    showNewSpace = false;
    const rec = await manager.create(name, mode);
    spaces = manager.list;
    activeId = rec.id;
    version += 1;
    void startReplication(rec);
  }

  /** Adopt a space from a share link (§7.2), the same path an opened URL takes. */
  async function joinSpace(url: string): Promise<void> {
    if (manager === null) return;
    const parsed = parseShareUrl(url);
    if (parsed === null) {
      notify('That is not a share link.');
      return;
    }
    showNewSpace = false;
    const rec = await manager.join(parsed);
    spaces = manager.list;
    activeId = rec.id;
    version += 1;
    void startReplication(rec);
  }

  /**
   * Copy the share URL for a mode 2 writer space (§7.2). Readers open it and
   * replicate; the writer must stay connected for new readers to join.
   */
  async function share(): Promise<void> {
    if (space === null) return;
    const rec = space.record;
    if (rec.mode !== 'writer') {
      notify('Only a writer space can be shared.');
      return;
    }
    const peer = peerIds[rec.id];
    if (peer === undefined) {
      notify('Not connected to signalling yet.');
      return;
    }
    await navigator.clipboard.writeText(shareUrl(rec.id, rec.name, peer));
    notify('Share URL copied.');
  }

  /**
   * Drop a row onto another space's tab (§8.5). Not a `:parent` write: the
   * object is recreated in the destination under a new UUID and the source is
   * tombstoned.
   */
  async function onDropOnTab(toId: string): Promise<void> {
    tabDropTarget = null;
    const src = dragging;
    dragging = null;
    if (manager === null || src === null || activeId === null || toId === activeId) return;

    const obj = space?.state.objects.get(src);
    if (obj === undefined) return;

    try {
      await manager.moveAcross(activeId, toId, obj.uuid);
      version += 1;
      selected = null;
      void refreshBlobCount();
      // Both sides were written to (§8.5), so both need flushing.
      flushSpaces(activeId, toId);
      const to = spaces.find((s) => s.id === toId);
      notify(`Moved ${obj.name ?? 'object'} to ${to?.name ?? 'space'}.`);
    } catch (err) {
      notify((err as Error).message);
    }
  }

  /**
   * Keyboard navigation over the *visible* rows. The tool is keyboard-first, so
   * arrow keys move and expand exactly as they would in a TUI file manager.
   */
  function onKey(e: KeyboardEvent): void {
    // Same guard as paste: typing in a field, or any open dialog, wins.
    if (isEditing(e.target) || dialogOpen()) return;

    const rows = flatten(tree, expanded);
    const at = selected === null ? -1 : rows.findIndex((r) => r.key === selected);
    const current = at >= 0 ? rows[at] : undefined;
    const isDir = (n: (typeof rows)[number]) => n.children.length > 0 || n.obj.kind === 'dir';

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = rows[Math.min(at + 1, rows.length - 1)];
        if (next !== undefined) selected = next.key;
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = rows[Math.max(at - 1, 0)];
        if (prev !== undefined) selected = prev.key;
        return;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (current === undefined) return;
        if (isDir(current) && !expanded.has(current.key)) {
          expanded.add(current.key);
        } else {
          const next = rows[at + 1];
          if (next !== undefined) selected = next.key;
        }
        return;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (current === undefined) return;
        if (isDir(current) && expanded.has(current.key)) {
          expanded.delete(current.key);
        } else {
          // Jump to the parent row, which is the nearest shallower row above.
          for (let i = at - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (r.depth < current.depth) {
              selected = r.key;
              break;
            }
          }
        }
        return;
      }
      case '`':
        if (e.ctrlKey) {
          e.preventDefault();
          showDebug = !showDebug;
        }
        return;
      case 'F2':
        e.preventDefault();
        if (space?.writable === true) renameSelected();
        return;
      case 'Delete':
        e.preventDefault();
        if (space?.writable === true) void deleteSelected();
        return;
    }
  }
</script>

<svelte:window onpaste={onPaste} onkeydown={onKey} />

<AskName
  open={ask !== null}
  title={ask?.title ?? ''}
  initial={ask?.initial ?? ''}
  confirmLabel={ask?.confirmLabel ?? 'OK'}
  onCancel={() => (ask = null)}
  onConfirm={(v) => ask?.run(v)}
/>

<NewSpace
  open={showNewSpace}
  onCancel={() => (showNewSpace = false)}
  onCreate={(name, mode) => void createSpace(name, mode)}
  onJoin={(url) => void joinSpace(url)}
/>

<div
  class="app"
  ondragover={(e) => e.preventDefault()}
  ondrop={onDropFiles}
  role="application"
  aria-label="File browser"
>
  <div class="tabs" role="tablist">
    {#each spaces as s (s.id)}
      <button
        class="tab"
        class:is-drop-target={tabDropTarget === s.id}
        role="tab"
        aria-selected={s.id === activeId}
        data-mode={s.mode}
        onclick={() => (activeId = s.id)}
        ondragover={(e) => {
          // A reader tab cannot be a destination (§8.5): the drop would have to
          // write to a log we do not own. Refuse the target rather than fail.
          if (dragging === null || s.id === activeId || s.mode === 'reader') return;
          e.preventDefault();
          tabDropTarget = s.id;
        }}
        ondragleave={() => (tabDropTarget = null)}
        ondrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void onDropOnTab(s.id);
        }}
      >
        {s.name} <span class="tab-mode">{s.mode}</span>
      </button>
    {/each}
    <button class="tab-new" title="New space" onclick={() => (showNewSpace = true)}>+</button>

    <span class="tabs-spacer"></span>

    <!--
      The view switch is space-scoped, like the tabs it sits with — not an
      action on the tree, which is why it does not belong in the status bar.
    -->
    <div class="viewswitch" role="group" aria-label="View">
      <button
        type="button"
        aria-pressed={!showDebug}
        onclick={() => (showDebug = false)}
      >Files</button>
      <button
        type="button"
        aria-pressed={showDebug}
        title="Ctrl+`"
        onclick={() => (showDebug = true)}
      >Log</button>
    </div>
  </div>

  {#if showDebug && space !== null}
    <Debug {space} {version} />
  {:else}
  <div class="panes">
    <div class="pane-tree">
      <div class="pane-head">
        <span>
          {space?.record.name ?? '—'}{#if space !== null && !space.writable} · read-only{/if}
        </span>
        <span class="pane-head-actions">
          {#if space?.writable === true}
            <button type="button" title="New directory" onclick={newDir}>
              New dir
            </button>
          {/if}
          {#if space?.record.mode === 'writer'}
            <button type="button" title="Copy share URL" onclick={() => void share()}>
              Share
            </button>
          {/if}
          <button
            type="button"
            aria-pressed={showDeleted}
            title="Show tombstoned objects"
            onclick={() => (showDeleted = !showDeleted)}
          >Deleted</button>
        </span>
      </div>
      <Tree
        nodes={tree}
        {expanded}
        {selected}
        writable={space?.writable ?? false}
        {dropTarget}
        onSelect={(k) => (selected = k)}
        onToggle={(k) => {
          if (expanded.has(k)) expanded.delete(k);
          else expanded.add(k);
        }}
        onDragStart={(k) => (dragging = k)}
        onDragOver={(k) => (dropTarget = k)}
        onDropOn={(k) => void onDropOnRow(k)}
      />
    </div>

    <Preview
      obj={selectedObj}
      path={space !== null && selectedObj !== null ? space.path(selectedObj.uuid) : ''}
      {blob}
      loading={loadingBlob}
      {childCount}
      progress={fetchProgress}
      unavailable={isUnavailable}
    />
  </div>
  {/if}

  <div class="status">
    <span>{space?.record.mode ?? '—'}</span>
    {#if space?.writerId != null}
      <span>writer {hex(space.writerId).slice(0, 4)}…</span>
      <span>seq {space.writerState?.seq ?? 0}</span>
      <span>lamport {space.writerState?.lamport ?? 0}</span>
    {:else}
      <span>read-only</span>
    {/if}
    <span>{space === null ? 0 : space.state.objects.size - 1} objects</span>
    <span>{space?.eventCount ?? 0} events</span>
    <span>{blobsHeld} blobs</span>
    {#if space !== null && space.record.mode !== 'local'}
      <span>
        {peerCounts[space.record.id] ?? 0} peers
        {#if (peerCounts[space.record.id] ?? 0) === 0}
          <span class="status-stale">· stale</span>
        {/if}
      </span>
    {/if}
    <span class="status-spacer"></span>
    {#if stalls.length > 0}
      <span class="status-stale" title={stalls.join('\n')}>
        {stalls.length} stall{stalls.length === 1 ? '' : 's'}
      </span>
    {/if}
    {#if message !== null}<span>{message}</span>{/if}
  </div>
</div>
