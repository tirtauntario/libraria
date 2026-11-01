<script lang="ts">
  import type { SubmissionDto } from '@libraria/core';
  import { net } from '../../../lib/net.svelte';
  import { href } from '../../../lib/router.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { apiFor } from '../../../lib/server/servers';
  import { refreshServerCatalog } from '../../../lib/server/source';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import Dialog from '../../../lib/ui/Dialog.svelte';
  import Icon from '../../../lib/ui/Icon.svelte';
  import { FORMAT_LABEL, formatBytes, formatRelative } from '../../../lib/ui/format';
  import type { ServerEntry } from '../store.svelte';

  let { entry }: { entry: ServerEntry } = $props();
  const api = $derived(apiFor(entry.source, services().repo));

  let items = $state<SubmissionDto[] | null>(null);
  let error = $state<string | null>(null);
  async function load() {
    if (!net.online) return;
    try {
      items = (await api.listSubmissions({ status: 'pending' })).items;
      error = null;
    } catch (err) {
      error = describeError(err);
    }
  }
  $effect(() => {
    void net.online;
    void load();
  });

  let busy = $state<string | null>(null);
  async function approve(sub: SubmissionDto, note?: string) {
    busy = sub.id;
    try {
      await api.review(sub.id, { action: 'approve', note: note || undefined });
      toasts.show(`Added “${sub.title}” to the library`, { kind: 'success' });
      await load();
      void refreshServerCatalog(entry.source, services()).catch(() => {});
    } catch (err) {
      toasts.error('Could not approve', describeError(err));
    } finally {
      busy = null;
    }
  }

  let rejecting = $state<SubmissionDto | null>(null);
  let rejectOpen = $state(false);
  let note = $state('');
  async function reject(e: SubmitEvent) {
    e.preventDefault();
    const sub = rejecting;
    if (!sub) return;
    busy = sub.id;
    try {
      await api.review(sub.id, { action: 'reject', note: note.trim() || undefined });
      rejectOpen = false;
      toasts.show(`Rejected “${sub.title}”`);
      await load();
    } catch (err) {
      toasts.error('Could not reject', describeError(err));
    } finally {
      busy = null;
    }
  }
</script>

<section class="block">
  <h2>Waiting for review</h2>
  <p class="muted small">Check that the file is what it says and that you may share it. Members see a book only after you approve it.</p>
  {#if !net.online}
    <p class="subtle">Connect to review submissions.</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if items === null}
    <div class="spinner"></div>
  {:else if items.length === 0}
    <div class="card empty"><Icon name="check" size={24} /><p>Nothing to review.</p></div>
  {:else}
    <ul class="queue">
      {#each items as sub (sub.id)}
        <li class="card sub" data-testid="submission">
          <div class="text">
            <p class="title">{sub.title}</p>
            <p class="small muted">{sub.authors.join(', ') || 'Unknown author'}</p>
            <p class="small subtle">
              {FORMAT_LABEL[sub.format]} · {formatBytes(sub.fileSize)} · from <strong>{sub.username}</strong> · {formatRelative(sub.createdAt)}
            </p>
            <p class="small subtle file">{sub.filename}</p>
          </div>
          <div class="actions">
            <a class="btn small" href={href('/server', entry.source.id, 'review', sub.id)}><Icon name="book" size={16} /> Open</a>
            <button class="btn small ghost" type="button" disabled={busy === sub.id} onclick={() => { rejecting = sub; note = ''; rejectOpen = true; }}>Reject…</button>
            <button class="btn small primary" type="button" disabled={busy === sub.id} onclick={() => approve(sub)}>Approve</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Dialog bind:open={rejectOpen} title="Reject “{rejecting?.title}”?">
  <form id="reject-form" class="form" onsubmit={reject}>
    <p class="muted small">The file is deleted from the server. {rejecting?.username} sees your note.</p>
    <label class="field"><span>Note (optional)</span><textarea class="input" rows="3" bind:value={note} maxlength="2000"></textarea></label>
  </form>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (rejectOpen = false)}>Cancel</button>
    <button class="btn danger" type="submit" form="reject-form" disabled={!!busy}>Reject</button>
  {/snippet}
</Dialog>

<style>
  .block {
    max-width: 860px;
  }
  h2 {
    font-size: 17px;
    margin-bottom: 4px;
  }
  .small {
    font-size: 13px;
  }
  .block > .small {
    margin-bottom: 14px;
  }
  .error {
    color: var(--danger);
  }
  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
    padding: 14px 16px;
  }
  .text {
    flex: 1 1 260px;
    min-width: 0;
  }
  .title {
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .file {
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px;
    color: var(--text-2);
  }
  .form {
    display: grid;
    gap: 12px;
  }
</style>
