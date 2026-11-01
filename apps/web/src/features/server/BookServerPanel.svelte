<script lang="ts">
  import { canManageBooks, type BookUpdateRequest } from '@libraria/core';
  import type { BookRecord } from '../../lib/db/schema';
  import { net } from '../../lib/net.svelte';
  import { href } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { describeError } from '../../lib/server/api';
  import { apiFor, roleOf, type LibrariaSource } from '../../lib/server/servers';
  import { refreshServerCatalog, serverBookIdFromPath } from '../../lib/server/source';
  import { catalog } from '../../lib/stores/catalog.svelte';
  import { toasts } from '../../lib/stores/toasts.svelte';
  import Dialog from '../../lib/ui/Dialog.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { onServer, sendable, sendBook } from './actions';
  import { servers } from './store.svelte';
  import UploadList from './UploadList.svelte';

  /** Book page panel: which servers have this book, staff edits, and "Send to server…". */
  let { book }: { book: BookRecord } = $props();

  const copies = $derived(
    catalog.files
      .filter((f) => f.bookId === book.id)
      .map((f) => ({ file: f, entry: servers.get(f.sourceId) }))
      .filter((x): x is { file: typeof x.file; entry: NonNullable<typeof x.entry> } => !!x.entry),
  );
  const jobs = $derived(servers.uploads.filter((j) => j.bookId === book.id));
  const busyServers = $derived(new Set(jobs.filter((j) => !['failed', 'rejected'].includes(j.status)).map((j) => j.sourceId)));
  const targets = $derived(
    servers.signedIn.filter((e) => !onServer(book.id, e.source.id) && !busyServers.has(e.source.id) && (canManageBooks(e.source.config.role) || (e.state.info?.membersCanSubmit ?? true))),
  );
  const canSend = $derived(sendable(book) && targets.length > 0);

  let pickOpen = $state(false);
  let target = $state('');
  function openPick() {
    target = targets[0]?.source.id ?? '';
    pickOpen = true;
  }
  async function send(e: SubmitEvent) {
    e.preventDefault();
    const entry = servers.get(target);
    if (!entry) return;
    pickOpen = false;
    await sendBook(entry.source, book);
  }

  // --- staff: edit / delete on a server ---------------------------------------------
  let editOpen = $state(false);
  let editing = $state<{ source: LibrariaSource; id: string; draft: Record<string, string> } | null>(null);
  let saving = $state(false);
  async function startEdit(source: LibrariaSource, path: string) {
    const id = serverBookIdFromPath(path);
    if (!id) return;
    try {
      const dto = await apiFor(source, services().repo).getBook(id);
      editing = {
        source,
        id,
        draft: {
          title: dto.title,
          authors: dto.authors.join(', '),
          series: dto.series ?? '',
          seriesIndex: dto.seriesIndex == null ? '' : String(dto.seriesIndex),
          description: dto.description ?? '',
          language: dto.language ?? '',
          publisher: dto.publisher ?? '',
        },
      };
      editOpen = true;
    } catch (err) {
      toasts.error('Could not load the book', describeError(err));
    }
  }
  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    const ed = editing;
    if (!ed) return;
    saving = true;
    const d = ed.draft;
    const patch: BookUpdateRequest = {
      title: d.title!.trim(),
      authors: d.authors!.split(',').map((a) => a.trim()).filter(Boolean),
      series: d.series!.trim() || null,
      seriesIndex: d.seriesIndex!.trim() ? Number(d.seriesIndex) : null,
      description: d.description!.trim() || null,
      language: d.language!.trim() || null,
      publisher: d.publisher!.trim() || null,
    };
    try {
      await apiFor(ed.source, services().repo).updateBook(ed.id, patch);
      editOpen = false;
      toasts.show(`Saved on ${ed.source.name}`, { kind: 'success' });
      await refreshServerCatalog(ed.source, services());
    } catch (err) {
      toasts.error('Could not save', describeError(err));
    } finally {
      saving = false;
    }
  }

  let deleteOpen = $state(false);
  let deleting = $state<{ source: LibrariaSource; id: string } | null>(null);
  async function confirmDelete() {
    const d = deleting;
    if (!d) return;
    deleteOpen = false;
    try {
      await apiFor(d.source, services().repo).deleteBook(d.id);
      toasts.show(`Removed from ${d.source.name}`);
      await refreshServerCatalog(d.source, services());
    } catch (err) {
      toasts.error('Could not remove', describeError(err));
    }
  }
</script>

{#if copies.length || canSend || jobs.length}
  <section class="panel">
    <h3>Libraria servers</h3>
    {#if copies.length}
      <ul class="copies">
        {#each copies as { file, entry } (file.id)}
          <li>
            <Icon name="library" size={18} />
            <a class="name" href={href('/server', entry.source.id)}>In {entry.source.name}</a>
            {#if canManageBooks(roleOf(entry.source))}
              <button class="btn small ghost" type="button" disabled={!net.online} onclick={() => startEdit(entry.source, file.path)}>Edit on server</button>
              <button
                class="btn small ghost danger-text"
                type="button"
                disabled={!net.online}
                onclick={() => {
                  const id = serverBookIdFromPath(file.path);
                  if (id) {
                    deleting = { source: entry.source, id };
                    deleteOpen = true;
                  }
                }}>Remove from server</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if jobs.length}
      <UploadList {jobs} showServer showTitle={false} />
    {/if}
    {#if canSend}
      <div class="send">
        <button class="btn small" type="button" onclick={openPick}><Icon name="upload" size={16} /> Send to server…</button>
        {#if !net.online}<span class="subtle small">It will go out when you are online.</span>{/if}
      </div>
    {/if}
  </section>
{/if}

<Dialog bind:open={pickOpen} title="Send “{book.title}”">
  <form id="send-form" class="form" onsubmit={send}>
    <fieldset>
      <legend class="label">Server</legend>
      {#each targets as { source } (source.id)}
        <label class="radio">
          <input type="radio" name="target" value={source.id} bind:group={target} />
          <span>
            {source.name}
            <span class="subtle small block">
              {canManageBooks(source.config.role) ? 'Added right away (you manage this library)' : 'Reviewed by the owner or a curator first'}
            </span>
          </span>
        </label>
      {/each}
    </fieldset>
    <p class="muted small">Libraria checks first whether the server already has this exact file; then nothing is uploaded.</p>
  </form>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (pickOpen = false)}>Cancel</button>
    <button class="btn primary" type="submit" form="send-form" disabled={!target}>Send</button>
  {/snippet}
</Dialog>

<Dialog bind:open={editOpen} title="Edit on {editing?.source.name}" size="md">
  {#if editing}
    <form id="server-edit" class="form" onsubmit={saveEdit}>
      <label class="field"><span>Title</span><input class="input" bind:value={editing.draft.title} required maxlength="500" /></label>
      <label class="field"><span>Authors</span><input class="input" bind:value={editing.draft.authors} placeholder="Separate with commas" /></label>
      <div class="two">
        <label class="field"><span>Series</span><input class="input" bind:value={editing.draft.series} /></label>
        <label class="field"><span>Number</span><input class="input" type="number" min="0" step="any" bind:value={editing.draft.seriesIndex} /></label>
      </div>
      <div class="two">
        <label class="field"><span>Language</span><input class="input" bind:value={editing.draft.language} maxlength="35" /></label>
        <label class="field"><span>Publisher</span><input class="input" bind:value={editing.draft.publisher} /></label>
      </div>
      <label class="field"><span>Description</span><textarea class="input" rows="4" bind:value={editing.draft.description}></textarea></label>
    </form>
  {/if}
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (editOpen = false)}>Cancel</button>
    <button class="btn primary" type="submit" form="server-edit" disabled={saving}>Save</button>
  {/snippet}
</Dialog>

<Dialog bind:open={deleteOpen} title="Remove from {deleting?.source.name}?">
  <p class="muted">Members can no longer see or download it. Copies people already downloaded stay on their devices.</p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (deleteOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={confirmDelete}>Remove</button>
  {/snippet}
</Dialog>

<style>
  .panel {
    margin-top: 28px;
  }
  h3 {
    font-size: 15px;
    margin-bottom: 10px;
  }
  .copies {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .copies li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    min-height: 40px;
    color: var(--text-2);
  }
  .name {
    flex: 1 1 160px;
    font-weight: 550;
  }
  .send {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .small {
    font-size: 13px;
  }
  .block {
    display: block;
  }
  .danger-text {
    color: var(--danger);
  }
  .form {
    display: grid;
    gap: 14px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .radio {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .radio input {
    margin-top: 3px;
  }
  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px;
  }
</style>
