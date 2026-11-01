<script lang="ts">
  import type { UploadJobRecord } from '../../lib/db/schema';
  import { href } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { describeError } from '../../lib/server/api';
  import { cancelUpload, dismissUpload, processUploads, retryUpload } from '../../lib/server/uploads';
  import { toasts } from '../../lib/stores/toasts.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { formatBytes } from '../../lib/ui/format';
  import { servers } from './store.svelte';

  let { jobs, showServer = false, showTitle = true }: { jobs: UploadJobRecord[]; showServer?: boolean; showTitle?: boolean } = $props();

  const LABEL: Record<UploadJobRecord['status'], string> = {
    queued: 'Waiting to upload',
    uploading: 'Uploading',
    pending: 'Waiting for review',
    approved: 'Added to the library',
    exists: 'Already in the library',
    rejected: 'Rejected',
    failed: 'Failed',
  };

  function fraction(job: UploadJobRecord): number {
    const p = servers.progress[job.id];
    const loaded = p ? p.loaded : job.offset;
    return job.fileSize ? Math.min(1, loaded / job.fileSize) : 0;
  }

  async function act(fn: () => Promise<void>, failMsg: string) {
    try {
      await fn();
    } catch (err) {
      toasts.error(failMsg, describeError(err));
    }
  }

  const retry = (j: UploadJobRecord) =>
    act(async () => {
      await retryUpload(services(), j.id);
      await processUploads(services());
    }, 'Could not retry');
  const cancel = (j: UploadJobRecord) => act(() => cancelUpload(services(), j.id), 'Could not cancel');
  const dismiss = (j: UploadJobRecord) => act(() => dismissUpload(services(), j.id), 'Could not remove');
</script>

<ul class="uploads">
  {#each jobs as job (job.id)}
    {@const active = job.status === 'queued' || job.status === 'uploading'}
    <li class="job" data-status={job.status}>
      <div class="head">
        <span class="icon {job.status}"><Icon name={job.status === 'approved' || job.status === 'exists' ? 'check' : job.status === 'failed' || job.status === 'rejected' ? 'alert' : 'upload'} size={18} /></span>
        <div class="text">
          {#if showTitle}<a class="title" href={href('/book', job.bookId)}>{job.title}</a>{/if}
          <p class="small">
            <span class="status">{LABEL[job.status]}</span>
            {#if showServer}· {servers.get(job.sourceId)?.source.name ?? 'Removed server'}{/if}
            · {formatBytes(job.fileSize)}
          </p>
          {#if job.error}<p class="small note" class:bad={job.status === 'failed'}>{job.status === 'rejected' ? `Note: ${job.error}` : job.error}</p>{/if}
        </div>
        <div class="actions">
          {#if job.status === 'failed' || job.status === 'rejected'}
            <button class="btn small" type="button" onclick={() => retry(job)}>Retry</button>
          {/if}
          {#if active || job.status === 'pending' || job.status === 'failed'}
            <button class="btn small ghost" type="button" onclick={() => cancel(job)}>Cancel</button>
          {:else}
            <button class="icon-btn" type="button" aria-label="Remove from list" onclick={() => dismiss(job)}><Icon name="close" size={16} /></button>
          {/if}
        </div>
      </div>
      {#if active}
        <div class="bar" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(fraction(job) * 100)}>
          <div style:width="{fraction(job) * 100}%"></div>
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .uploads {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .job {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .job:last-child {
    border-bottom: 0;
  }
  .head {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .icon.approved,
  .icon.exists {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .icon.failed,
  .icon.rejected {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title {
    display: block;
    color: var(--text);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 13px;
    color: var(--text-2);
  }
  .status {
    font-weight: 550;
  }
  .note {
    color: var(--text-3);
    overflow-wrap: anywhere;
  }
  .note.bad {
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .bar {
    height: 4px;
    margin: 8px 0 0 46px;
    border-radius: 2px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: var(--accent);
    transition: width 200ms var(--ease);
  }
</style>
