<script lang="ts">
  import { BOOK_FORMATS, type AnonymousAccess, type BookFormat, type LibrarySettings, type Visibility } from '@libraria/core';
  import { net } from '../../../lib/net.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { apiFor, refreshAccount } from '../../../lib/server/servers';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import Segmented from '../../../lib/ui/Segmented.svelte';
  import { FORMAT_LABEL } from '../../../lib/ui/format';
  import type { ServerEntry } from '../store.svelte';

  let { entry }: { entry: ServerEntry } = $props();
  const api = $derived(apiFor(entry.source, services().repo));

  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  interface Draft {
    name: string;
    description: string;
    visibility: Visibility;
    anonymousAccess: AnonymousAccess;
    maxUploadMB: number;
    quotaGB: number;
    maxPendingPerMember: number;
    membersCanSubmit: boolean;
    formats: Record<BookFormat, boolean>;
    inviteExpiryDays: number;
    invitesSkipApproval: boolean;
  }
  let draft = $state<Draft | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);

  function toDraft(s: LibrarySettings): Draft {
    return {
      name: s.name,
      description: s.description,
      visibility: s.visibility,
      anonymousAccess: s.anonymousAccess,
      maxUploadMB: Math.round(s.maxUploadBytes / MB),
      quotaGB: Math.round((s.memberQuotaBytes / GB) * 10) / 10,
      maxPendingPerMember: s.maxPendingPerMember,
      membersCanSubmit: s.membersCanSubmit,
      formats: Object.fromEntries(BOOK_FORMATS.map((f) => [f, s.allowedFormats.includes(f)])) as Record<BookFormat, boolean>,
      inviteExpiryDays: s.inviteExpiryDays,
      invitesSkipApproval: s.invitesSkipApproval,
    };
  }

  async function load() {
    if (!net.online) return;
    try {
      draft = toDraft(await api.getSettings());
      error = null;
    } catch (err) {
      error = describeError(err);
    }
  }
  $effect(() => {
    void net.online;
    void load();
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!draft) return;
    const formats = BOOK_FORMATS.filter((f) => draft!.formats[f]);
    if (formats.length === 0) {
      toasts.error('Allow at least one format');
      return;
    }
    saving = true;
    try {
      const next = await api.updateSettings({
        name: draft.name.trim(),
        description: draft.description,
        visibility: draft.visibility,
        anonymousAccess: draft.anonymousAccess,
        maxUploadBytes: Math.max(1, Math.round(draft.maxUploadMB * MB)),
        memberQuotaBytes: Math.max(0, Math.round(draft.quotaGB * GB)),
        maxPendingPerMember: Math.max(0, Math.round(draft.maxPendingPerMember)),
        membersCanSubmit: draft.membersCanSubmit,
        allowedFormats: [...formats],
        inviteExpiryDays: Math.max(1, Math.round(draft.inviteExpiryDays)),
        invitesSkipApproval: draft.invitesSkipApproval,
      });
      draft = toDraft(next);
      toasts.show('Library settings saved', { kind: 'success' });
      void refreshAccount(services().repo, entry.source).catch(() => {});
    } catch (err) {
      toasts.error('Could not save', describeError(err));
    } finally {
      saving = false;
    }
  }
</script>

{#if !net.online}
  <p class="subtle">Connect to change the library settings.</p>
{:else if error}
  <p class="error">{error}</p>
{:else if !draft}
  <div class="spinner"></div>
{:else}
  <form class="settings" onsubmit={save}>
    <section class="card group">
      <h2>Library</h2>
      <label class="field"><span>Name</span><input class="input" bind:value={draft.name} maxlength="100" required /></label>
      <label class="field">
        <span>Description</span>
        <textarea class="input" rows="3" bind:value={draft.description} maxlength="2000" placeholder="What this library is about, who runs it"></textarea>
      </label>
    </section>

    <section class="card group">
      <h2>Access</h2>
      <div class="row">
        <div class="row-text"><p>Visibility</p><p class="subtle">Private: you or a curator accept each signup. Public: anyone can join.</p></div>
        <Segmented
          label="Visibility"
          bind:value={draft.visibility}
          options={[
            { value: 'private', label: 'Private' },
            { value: 'public', label: 'Public' },
          ]}
        />
      </div>
      <div class="row">
        <label class="row-text" for="anon"><span>Visitors without an account</span><span class="subtle">Public libraries only. Anonymous requests are rate-limited.</span></label>
        <select id="anon" class="input select" bind:value={draft.anonymousAccess} disabled={draft.visibility !== 'public'}>
          <option value="none">No access</option>
          <option value="browse">Browse the catalog</option>
          <option value="read">Browse and read</option>
        </select>
      </div>
      <label class="row">
        <span class="row-text"><span>Invite links skip approval</span><span class="subtle">People joining a private library with an invite can sign in at once</span></span>
        <input type="checkbox" bind:checked={draft.invitesSkipApproval} />
      </label>
      <div class="row">
        <label class="row-text" for="expiry"><span>Invite links expire after</span></label>
        <span class="unit"><input id="expiry" class="input num" type="number" min="1" max="3650" bind:value={draft.inviteExpiryDays} required /> days</span>
      </div>
    </section>

    <section class="card group">
      <h2>Contributions</h2>
      <label class="row">
        <span class="row-text"><span>Members may send books</span><span class="subtle">Each one waits for review. Your and curators’ uploads skip review.</span></span>
        <input type="checkbox" bind:checked={draft.membersCanSubmit} />
      </label>
      <div class="row">
        <label class="row-text" for="maxup"><span>Largest file</span></label>
        <span class="unit"><input id="maxup" class="input num" type="number" min="1" step="1" bind:value={draft.maxUploadMB} required /> MB</span>
      </div>
      <div class="row">
        <label class="row-text" for="quota"><span>Storage per member</span><span class="subtle">Pending and approved submissions together</span></label>
        <span class="unit"><input id="quota" class="input num" type="number" min="0" step="0.1" bind:value={draft.quotaGB} required /> GB</span>
      </div>
      <div class="row">
        <label class="row-text" for="pending"><span>Pending submissions per member</span></label>
        <input id="pending" class="input num" type="number" min="0" max="100000" bind:value={draft.maxPendingPerMember} required />
      </div>
      <fieldset class="row">
        <legend class="row-text">Accepted formats</legend>
        <span class="formats">
          {#each BOOK_FORMATS as f (f)}
            <label class="fmt"><input type="checkbox" bind:checked={draft.formats[f]} /> {FORMAT_LABEL[f]}</label>
          {/each}
        </span>
      </fieldset>
    </section>

    <div class="save">
      <button class="btn" type="button" onclick={load}>Discard changes</button>
      <button class="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
    </div>
  </form>
{/if}

<style>
  .settings {
    max-width: 760px;
    display: grid;
    gap: 16px;
  }
  .group {
    padding: 18px 20px;
    display: grid;
    gap: 12px;
  }
  h2 {
    font-size: 17px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px 16px;
    padding: 10px 0 0;
    margin: 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .row-text {
    display: grid;
    gap: 2px;
    flex: 1 1 220px;
    min-width: 0;
    padding: 0;
  }
  .row-text .subtle {
    font-size: 13px;
  }
  .select {
    width: auto;
    min-width: 180px;
  }
  .num {
    width: 110px;
  }
  .unit {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    color: var(--text-2);
  }
  .formats {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .fmt {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-weight: 550;
  }
  .save {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .error {
    color: var(--danger);
  }
</style>
