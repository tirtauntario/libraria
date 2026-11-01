<script lang="ts">
  import { canManageBooks, type SubmissionDto } from '@libraria/core';
  import { net } from '../../../lib/net.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { apiFor, roleOf } from '../../../lib/server/servers';
  import { processUploads } from '../../../lib/server/uploads';
  import { catalog } from '../../../lib/stores/catalog.svelte';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import BookCover from '../../../lib/ui/BookCover.svelte';
  import Dialog from '../../../lib/ui/Dialog.svelte';
  import Icon from '../../../lib/ui/Icon.svelte';
  import { formatBytes, formatRelative } from '../../../lib/ui/format';
  import { onServer, sendable, sendBook } from '../actions';
  import { servers, type ServerEntry } from '../store.svelte';
  import UploadList from '../UploadList.svelte';
  import { SUBMISSION_LABEL } from '../util';

  let { entry }: { entry: ServerEntry } = $props();
  const staff = $derived(canManageBooks(roleOf(entry.source)));
  const info = $derived(entry.state.info);
  const canSubmit = $derived(staff || (info?.membersCanSubmit ?? true));

  const jobs = $derived(servers.uploads.filter((j) => j.sourceId === entry.source.id));
  const busyBooks = $derived(new Set(jobs.filter((j) => !['failed', 'rejected'].includes(j.status)).map((j) => j.bookId)));
  const candidates = $derived(
    catalog.books.filter((b) => sendable(b) && !onServer(b.id, entry.source.id) && !busyBooks.has(b.id)),
  );

  let remote = $state<SubmissionDto[] | null>(null);
  let loadError = $state<string | null>(null);
  async function load() {
    if (!net.online) return;
    try {
      remote = (await apiFor(entry.source, services().repo).listSubmissions({ mine: true })).items;
      loadError = null;
    } catch (err) {
      loadError = describeError(err);
    }
  }
  $effect(() => {
    void net.online;
    void load();
    void processUploads(services()).catch(() => {});
  });

  async function cancelRemote(sub: SubmissionDto) {
    try {
      await apiFor(entry.source, services().repo).deleteSubmission(sub.id);
      toasts.show('Submission cancelled');
      await load();
    } catch (err) {
      toasts.error('Could not cancel', describeError(err));
    }
  }

  let pickOpen = $state(false);
  let filter = $state('');
  const shown = $derived(
    candidates.filter((b) => !filter.trim() || b.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).slice(0, 200),
  );
</script>

<section class="block">
  <div class="head">
    <h2>Send books</h2>
    <button class="btn primary small" type="button" disabled={!canSubmit} onclick={() => (pickOpen = true)}>
      <Icon name="upload" size={16} /> Send a book…
    </button>
  </div>
  <p class="muted small">
    {#if !canSubmit}
      This library does not take submissions from members.
    {:else if staff}
      Books you send are added to the library right away.
    {:else}
      The owner or a curator reviews each book before members can see it. The server checks the file and asks for nothing that is
      already there.
    {/if}
    {#if info}&nbsp;Up to {formatBytes(info.maxUploadBytes)} per file; {info.allowedFormats.map((f) => f.toUpperCase()).join(', ')}.{/if}
  </p>
  {#if jobs.length}
    <UploadList {jobs} />
  {:else}
    <p class="subtle small">Nothing sent from this device yet.</p>
  {/if}
</section>

<section class="block">
  <h2>On the server</h2>
  {#if !net.online}
    <p class="subtle small">Connect to see the status of your submissions.</p>
  {:else if loadError}
    <p class="error small">{loadError}</p>
  {:else if remote === null}
    <div class="spinner"></div>
  {:else if remote.length === 0}
    <p class="subtle small">You have not submitted books to this library.</p>
  {:else}
    <ul class="subs">
      {#each remote as sub (sub.id)}
        <li>
          <div class="text">
            <p class="title">{sub.title}</p>
            <p class="small muted">
              <span class="status {sub.status}">{SUBMISSION_LABEL[sub.status]}</span> · {formatBytes(sub.fileSize)} · {formatRelative(sub.createdAt)}
            </p>
            {#if sub.reviewNote}<p class="small note">“{sub.reviewNote}”</p>{/if}
          </div>
          {#if sub.status === 'uploading' || sub.status === 'pending'}
            <button class="btn small ghost" type="button" onclick={() => cancelRemote(sub)}>Cancel</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Dialog bind:open={pickOpen} title="Send a book to {entry.source.name}" size="md">
  {#if candidates.length === 0}
    <p class="muted">No books to send. Books you imported to this device appear here once they are not on this server yet.</p>
  {:else}
    <p class="muted small">Only send books you have the right to share: your own work, public-domain works, or works whose licence allows it. <a href="#/about">Your content, your responsibility</a></p>
    <input class="input" type="search" placeholder="Filter" bind:value={filter} aria-label="Filter books" />
    <ul class="pick">
      {#each shown as book (book.id)}
        <li>
          <div class="thumb"><BookCover cover={book.cover} title={book.title} format={book.format} /></div>
          <div class="text">
            <p class="title">{book.title}</p>
            <p class="small muted">{book.authors.join(', ') || book.format.toUpperCase()} · {formatBytes(book.fileSize)}</p>
          </div>
          <button
            class="btn small"
            type="button"
            onclick={() => {
              void sendBook(entry.source, book);
              pickOpen = false;
            }}>Send</button
          >
        </li>
      {/each}
    </ul>
  {/if}
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (pickOpen = false)}>Close</button>
  {/snippet}
</Dialog>

<style>
  .block {
    margin-bottom: 28px;
    max-width: 760px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  h2 {
    font-size: 17px;
    margin-bottom: 6px;
  }
  .head h2 {
    margin: 0;
  }
  .small {
    font-size: 13px;
  }
  .block > .small {
    margin-bottom: 10px;
  }
  .error {
    color: var(--danger);
  }
  .subs,
  .pick {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .subs li,
  .pick li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    color: var(--text-2);
    font-style: italic;
  }
  .status.approved {
    color: var(--success);
  }
  .status.rejected {
    color: var(--danger);
  }
  .pick {
    margin-top: 10px;
  }
  .thumb {
    width: 36px;
    flex: none;
  }
</style>
