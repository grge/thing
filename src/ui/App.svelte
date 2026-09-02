<script lang="ts">
  import { buildTree, flatten, wouldCycle } from '../app/tree.js';
  import type { Space } from '../app/space.js';
  import { Spaces } from '../app/spaces.js';
  import type { SpaceMode, SpaceRecord } from '../app/storage.js';
  import { codeForSpace, defaultLocator, parseShareInput, shareUrl } from '../app/address.js';
  import { Replication } from '../app/replication.js';
  import { loadSettings, saveSettings, type Settings as AppSettings } from '../app/settings.js';
  import { fromHex, hex, ROOT, type Link, type ObjectState } from '../fold/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import Debug from './Debug.svelte';
  import AskName from './AskName.svelte';
  import ConfirmDelete from './ConfirmDelete.svelte';
  import Icon from './Icon.svelte';
  import PeerList from './PeerList.svelte';
  import NewSpace from './NewSpace.svelte';
  import Settings from './Settings.svelte';
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
  let confirmDelete = $state<SpaceRecord | null>(null);
  let showPeers = $state(false);
  let showSettings = $state(false);
  let settings = $state<AppSettings>(loadSettings());
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
  /**
   * Bumped when a blob arrives, so the loading effect re-reads the store for
   * the object already on screen. Without it the effect only re-runs when the
   * selection changes, leaving a completed fetch showing "Fetching…" until the
   * user clicked away and back.
   */
  let blobEpoch = $state(0);

  let expanded = $state(new SvelteSet<string>());
  let selected = $state<string | null>(null);
  let showDeleted = $state(false);
  let dropTarget = $state<string | null>(null);
  let dragging = $state<string | null>(null);
  let blob = $state<Uint8Array | null>(null);
  let loadingBlob = $state(false);
  let blobsHeld = $state(0);
  let message = $state<string | null>(null);
  /** Hidden, clicked from the upload button (§8.4 has no touch drag). */
  let fileInput = $state<HTMLInputElement | null>(null);

  // All registered spaces are opened at once and stay open (§8.3). Switching
  // tabs switches which one the panes show; it does not open or close anything.
  $effect(() => {
    void Spaces.load().then(async (m) => {
      manager = m;

      // A share URL joins the space it names (§7.2). Idempotent, so reopening
      // the link reuses the local log rather than re-fetching from zero.
      const shared = parseShareInput(window.location.href);
      let focus = m.list[0]?.id ?? null;
      if (shared !== null) {
        const resolved = await m.resolve(shared);
        if (resolved !== null) {
          const rec = await m.join(resolved);
          focus = rec.id;
        }
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
        // A peer that connected and then left without the space gaining any
        // events is the shape of a rejected handshake, which is otherwise
        // invisible: the reassuring "peer connected" has already been shown and
        // the count quietly returns to zero. Say so, rather than let a failed
        // join look like an idle one.
        if (rep.peers.length === 0 && (manager?.get(rec.id)?.log.length ?? 0) === 0) {
          notify(`${rec.name}: peer disconnected before sending anything.`);
        }
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
        // Tell the preview to re-read: the bytes it was waiting for are here.
        blobEpoch += 1;
      },
      onBlobUnavailable: (h) => {
        const { [h]: _gone, ...rest } = fetching;
        fetching = rest;
        unavailable = { ...unavailable, [h]: true };
      },
      onIdentityMismatch: (expected, got) => {
        // Loud and blocking, per ADDRESSING.md §5.5 — a substitution is the one
        // thing a typed code cannot rule out in advance, so it must never pass
        // silently. The events have already been refused; this says why.
        notify(
          `${rec.name}: this code now answers to a different space ` +
            `(${got.slice(0, 8)}…, expected ${expected.slice(0, 8)}…). Nothing was accepted.`,
        );
      },
    });

    replication.set(rec.id, rep);
    try {
      // A writer claims the locator its own key derives to, so anyone holding
      // the key can work out where to look (DESIGN.md §4.2, §4.3).
      const wanted = rec.mode === 'writer' ? (await defaultLocator(rec.id)).address : undefined;
      const id = await rep.start(wanted);
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

  /**
   * The rendezvous code for the visible writer space.
   *
   * Derived from the key rather than stored, so it cannot drift from the
   * identity it points at (DESIGN.md §4.3). Async because the derivation
   * hashes, hence an effect rather than `$derived`.
   */
  let shareCode = $state<string | null>(null);
  $effect(() => {
    const rec = space?.record ?? null;
    if (rec === null || rec.mode !== 'writer') {
      shareCode = null;
      return;
    }
    let stale = false;
    void codeForSpace(rec.id).then((c) => {
      if (!stale) shareCode = c;
    });
    return () => {
      stale = true;
    };
  });

  /**
   * Objects, excluding ROOT — which the fold materialises only once some event
   * names it, so an untouched space has none rather than one.
   */
  let objectCount = $derived.by(() => {
    version;
    if (space === null) return 0;
    return Math.max(0, space.state.objects.size - 1);
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
    blobEpoch; // re-read when a blob lands, not only when the selection changes
    const obj = selectedObj;
    if (space === null || obj === null || obj.content === null) {
      blob = null;
      loadingBlob = false;
      return;
    }
    const wanted = hex(obj.content);
    const sp = space;
    const rep = replication.get(sp.record.id);
    loadingBlob = true;

    void sp.content(obj.content).then((got) => {
      // The selection may have moved while the read was in flight.
      if (selectedObj?.content == null || hex(selectedObj.content) !== wanted) return;
      loadingBlob = false;
      if (got !== null) {
        blob = got;
        return;
      }

      blob = null;
      // Not held locally: ask peers for it. This is the fetch §6.1 defers until
      // the user opens something, and the preview pane is the trigger.
      if (rep === undefined) {
        // No replication for this space, so nobody will ever answer.
        unavailable = { ...unavailable, [wanted]: true };
        return;
      }
      if (fetching[wanted] === undefined && unavailable[wanted] !== true) {
        rep.want(obj.content!);
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

  /** The `<input type="file">` behind the upload button, once a choice is made. */
  async function onFileInputChange(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (files !== null && files.length > 0) await addFiles(files);
    // Reset so choosing the same file again still fires a change event.
    input.value = '';
  }

  /**
   * The tap equivalent of Ctrl+V (§8.4): reads the clipboard behind a user
   * gesture rather than a keyboard event, which is what a touch device has.
   * Text only, same as the keyboard path — clipboard *files* still need drag
   * or the upload button above.
   */
  async function pasteFromClipboard(): Promise<void> {
    if (space === null || !space.writable) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Permission refused, or no async Clipboard API (docs/MOBILE.md notes
      // this gap is unverified across mobile browsers).
      notify('Clipboard access was refused.');
      return;
    }
    if (text.length === 0) {
      notify('Clipboard is empty.');
      return;
    }
    await pasteText(text);
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

  /**
   * Follow a link: join the space it names, as a reader.
   *
   * A link carries identity, so this is the verified path — the same one an
   * opened share link takes, with the key known before contact (DESIGN.md
   * §4.4). Idempotent: following a link to a space already open just switches
   * to it rather than joining twice.
   */
  async function followLink(link: Link, name?: string): Promise<void> {
    if (manager === null) return;
    const id = hex(link.space);
    const existing = manager.list.find((r) => r.id === id);
    if (existing !== undefined) {
      activeId = existing.id;
      // A deep link names an object; select it if this space holds it. It may
      // not — the target may have been moved across spaces, which mints a fresh
      // uuid and leaves the link dangling (I12).
      selected = link.object === undefined ? null : hex(link.object);
      return;
    }
    // The linking object's own name is the linker's petname for the target
    // (DESIGN.md §2.1) — a better handle than "shared", and the only name this
    // device has for a space it has never met.
    const resolved = await manager.resolve({ kind: 'key', id, name: '' }, name);
    if (resolved === null) return;
    const rec = await manager.join(resolved);
    spaces = manager.list;
    activeId = rec.id;
    selected = link.object === undefined ? null : hex(link.object);
    version += 1;
    void startReplication(rec);
  }

  /**
   * Link to another space. The input is a share link or a typed code, the same
   * two forms the join dialog takes — but only a link can be turned into a
   * `:link`, because a code names a rendezvous slot rather than an identity and
   * there is nothing verifiable to record (DESIGN.md §4.4).
   */
  function newLink(): void {
    ask = {
      title: 'Link to a space',
      initial: '',
      confirmLabel: 'Link',
      run: (input) => {
        ask = null;
        const parsed = parseShareInput(input);
        if (parsed === null) {
          notify('That is not a share link.');
          return;
        }
        if (parsed.kind !== 'key') {
          notify('A typed code names where to look, not what to link to. Paste the full link.');
          return;
        }
        void mutate(async (sp) => {
          const name = parsed.name === '' ? 'a space' : parsed.name;
          await sp.createLink(targetDir(), name, { space: fromHex(parsed.id) });
        });
      },
    };
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
   * Apply new settings and reconnect.
   *
   * PeerJS takes its ICE configuration at construction and never re-reads it,
   * so a relay added in settings would otherwise not apply until reload.
   * Tearing the connections down and redialling is disruptive, but it is what
   * the user just asked for by pressing Save.
   */
  function applySettings(next: AppSettings): void {
    settings = next;
    saveSettings(next);
    showSettings = false;

    for (const rep of replication.values()) rep.stop();
    replication.clear();
    peerIds = {};
    peerCounts = {};
    for (const rec of spaces) void startReplication(rec);
    notify('Settings saved — reconnecting.');
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
    const parsed = parseShareInput(url);
    if (parsed === null) {
      notify('That is not a share link or code.');
      return;
    }
    const resolved = await manager.resolve(parsed);
    if (resolved === null) {
      notify('That code now points somewhere else. Not joining.');
      return;
    }
    showNewSpace = false;
    const rec = await manager.join(resolved);
    spaces = manager.list;
    activeId = rec.id;
    version += 1;
    void startReplication(rec);
  }

  /**
   * Delete a space and everything local to it. Destructive and irreversible on
   * this device, so it is confirmed first.
   */
  async function deleteSpace(rec: SpaceRecord): Promise<void> {
    if (manager === null) return;
    confirmDelete = null;

    // Drop the connection before the log it replicates.
    replication.get(rec.id)?.stop();
    replication.delete(rec.id);

    const { blobsFreed } = await manager.forget(rec.id);
    spaces = manager.list;
    if (activeId === rec.id) activeId = manager.list[0]?.id ?? null;
    selected = null;
    version += 1;
    void refreshBlobCount();
    notify(
      blobsFreed === 0
        ? `Deleted ${rec.name}.`
        : `Deleted ${rec.name} — freed ${blobsFreed} blob${blobsFreed === 1 ? '' : 's'}.`,
    );
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
    if (peerIds[rec.id] === undefined) {
      notify('Not connected to signalling yet.');
      return;
    }
    await navigator.clipboard.writeText(shareUrl(rec.id, rec.name));
    notify(`Share link copied — code ${await codeForSpace(rec.id)}`);
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

<ConfirmDelete
  open={confirmDelete !== null}
  name={confirmDelete?.name ?? ''}
  objectCount={confirmDelete === null
    ? 0
    : Math.max(0, (manager?.get(confirmDelete.id)?.state.objects.size ?? 1) - 1)}
  onCancel={() => (confirmDelete = null)}
  onConfirm={() => confirmDelete !== null && void deleteSpace(confirmDelete)}
/>

<Settings
  open={showSettings}
  {settings}
  onCancel={() => (showSettings = false)}
  onSave={applySettings}
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
  <input
    type="file"
    multiple
    hidden
    bind:this={fileInput}
    onchange={(e) => void onFileInputChange(e)}
  />
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
        <span
          class="tab-close"
          role="button"
          tabindex="-1"
          aria-label="Delete {s.name}"
          title="Delete space"
          onclick={(e) => {
            e.stopPropagation();
            confirmDelete = s;
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              confirmDelete = s;
            }
          }}
        ><Icon name="x" size={11} /></span>
      </button>
    {/each}
    <button class="tab-new" title="New space" aria-label="New space" onclick={() => (showNewSpace = true)}>
      <Icon name="plus" />
    </button>

    <span class="tabs-spacer"></span>

    <!--
      The view switch is space-scoped, like the tabs it sits with — not an
      action on the tree, which is why it does not belong in the status bar.
    -->
    <div class="viewswitch" role="group" aria-label="View">
      <button
        type="button"
        aria-pressed={!showDebug}
        title="Files (Ctrl+`)"
        onclick={() => (showDebug = false)}
      ><Icon name="files" size={12} /> Files</button>
      <button
        type="button"
        aria-pressed={showDebug}
        title="Event log (Ctrl+`)"
        onclick={() => (showDebug = true)}
      ><Icon name="log" size={12} /> Log</button>
    </div>

    <button
      class="tab-settings"
      type="button"
      title="Settings"
      aria-label="Settings"
      onclick={() => (showSettings = true)}
    ><Icon name="settings" size={13} /></button>
  </div>

  {#if showDebug && space !== null}
    <Debug {space} {version} />
  {:else}
  <div class="panes" class:has-selection={selected !== null}>
    <div class="pane-tree">
      <div class="pane-head">
        <span class="pane-title">
          {space?.record.name ?? '—'}{#if space !== null && !space.writable}
            <span class="pane-badge">read-only</span>
          {/if}
        </span>
        <span class="pane-head-actions">
          {#if space?.writable === true}
            <button type="button" title="New directory" aria-label="New directory" onclick={newDir}>
              <Icon name="folderPlus" />
            </button>
            <button type="button" title="Link to a space" aria-label="Link to a space" onclick={newLink}>
              <Icon name="link" />
            </button>
            <!--
              Drag-in (§8.4) has no touch equivalent (docs/MOBILE.md, stage
              C). These two reach the same addFiles/pasteText paths a drop
              or Ctrl+V would, from a tap.
            -->
            <button type="button" title="Add files" aria-label="Add files" onclick={() => fileInput?.click()}>
              <Icon name="upload" />
            </button>
            <button
              type="button"
              title="Paste from clipboard as a file"
              aria-label="Paste from clipboard as a file"
              onclick={() => void pasteFromClipboard()}
            >
              <Icon name="clipboard" />
            </button>
          {/if}
          <button
            type="button"
            aria-pressed={showDeleted}
            title={showDeleted ? 'Hide deleted objects' : 'Show deleted objects'}
            aria-label="Show deleted"
            onclick={() => (showDeleted = !showDeleted)}
          ><Icon name={showDeleted ? 'eye' : 'eyeOff'} /></button>
        </span>
      </div>

      {#if space?.record.mode === 'writer'}
        <!--
          The share code gets its own row rather than competing with the pane
          actions: it is read off this screen and typed into another, so it wants
          room and a legible size, not a slot in a button cluster.
        -->
        <div class="share-bar">
          <Icon name="link" size={12} />
          <!--
            The *code*, not the key. The key is this space's identity and is 64
            hex characters — unreadable and untypeable. The code is derived from
            it (DESIGN.md §4.3) and is the only part meant for human transcription;
            it carries no authority, so showing it grants nothing.
          -->
          <code class="share-code" title="Type this on another device">{shareCode ?? '········'}</code>
          <button type="button" onclick={() => void share()}>
            <Icon name="copy" size={12} /> Copy link
          </button>
        </div>
      {/if}
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
      onBack={() => (selected = null)}
      onFollow={(link) => void followLink(link, selectedObj?.name ?? undefined)}
    />
  </div>
  {/if}

  <div class="status">
    <!--
      Status only, and grouped: identity, then size, then connection. Previously
      seven equal-weight spans read as a wall of numbers. The writer's seq and
      lamport moved to the log view, where they belong beside the events they
      describe.
    -->
    <span class="status-group">
      <span class="status-mode" data-mode={space?.record.mode ?? 'local'}>
        {space?.record.mode ?? '—'}
      </span>
      {#if space !== null && !space.writable}<span>read-only</span>{/if}
    </span>

    <span class="status-group">
      <span>{objectCount} objects</span>
      <span>{space?.eventCount ?? 0} events</span>
      <span>{blobsHeld} blobs</span>
    </span>

    {#if space !== null && space.record.mode !== 'local'}
      <span class="status-group peers-anchor">
        <button
          type="button"
          class="status-button"
          aria-expanded={showPeers}
          title="Connected peers"
          onclick={() => (showPeers = !showPeers)}
        >
          <Icon name="users" size={12} />
          {peerCounts[space.record.id] ?? 0} peers
        </button>
        {#if (peerCounts[space.record.id] ?? 0) === 0}
          <span class="status-stale">stale</span>
        {/if}
        <PeerList
          open={showPeers}
          localId={peerIds[space.record.id] ?? null}
          peers={replication.get(space.record.id)?.peers ?? []}
          onClose={() => (showPeers = false)}
        />
      </span>
    {/if}

    <span class="status-spacer"></span>

    {#if stalls.length > 0}
      <span class="status-stale" title={stalls.join('\n')}>
        {stalls.length} stall{stalls.length === 1 ? '' : 's'}
      </span>
    {/if}
    {#if message !== null}<span class="status-message">{message}</span>{/if}
  </div>
</div>
