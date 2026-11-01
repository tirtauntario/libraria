<script lang="ts">
  import type { UserDto, UserUpdateRequest } from '@libraria/core';
  import { net } from '../../../lib/net.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { apiFor, roleOf } from '../../../lib/server/servers';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import Icon from '../../../lib/ui/Icon.svelte';
  import { formatRelative } from '../../../lib/ui/format';
  import type { ServerEntry } from '../store.svelte';
  import { ROLE_LABEL } from '../util';

  let { entry }: { entry: ServerEntry } = $props();
  const api = $derived(apiFor(entry.source, services().repo));
  const isOwner = $derived(roleOf(entry.source) === 'owner');
  const meId = $derived(entry.state.user?.id);

  let users = $state<UserDto[] | null>(null);
  let error = $state<string | null>(null);
  async function load() {
    if (!net.online) return;
    try {
      users = (await api.listUsers()).items;
      error = null;
    } catch (err) {
      error = describeError(err);
    }
  }
  $effect(() => {
    void net.online;
    void load();
  });

  const pending = $derived((users ?? []).filter((u) => u.status === 'pending'));
  const others = $derived((users ?? []).filter((u) => u.status !== 'pending'));

  let busy = $state<string | null>(null);
  async function update(u: UserDto, patch: UserUpdateRequest, done: string) {
    busy = u.id;
    try {
      await api.updateUser(u.id, patch);
      toasts.show(done, { kind: 'success', timeout: 2500 });
      await load();
    } catch (err) {
      toasts.error('Could not update the account', describeError(err));
    } finally {
      busy = null;
    }
  }

  /** Curators manage members; only the owner manages curators. Nobody changes the owner. */
  function canManage(u: UserDto): boolean {
    if (u.role === 'owner' || u.id === meId) return false;
    return isOwner || u.role === 'member';
  }

  const STATUS: Record<UserDto['status'], string> = { pending: 'Waiting', active: 'Active', rejected: 'Rejected', disabled: 'Disabled' };
</script>

{#if !net.online}
  <p class="subtle">Connect to manage members.</p>
{:else if error}
  <p class="error">{error}</p>
{:else if users === null}
  <div class="spinner"></div>
{:else}
  <section class="block">
    <h2>Signups waiting {#if pending.length}<span class="chip">{pending.length}</span>{/if}</h2>
    {#if pending.length === 0}
      <p class="subtle small">No one is waiting. In a private library, new accounts wait here unless they came with an invite.</p>
    {:else}
      <ul class="users">
        {#each pending as u (u.id)}
          <li class="card user" data-testid="pending-user">
            <span class="avatar">{u.username.slice(0, 1).toUpperCase()}</span>
            <div class="text"><p class="name">{u.username}</p><p class="small subtle">Signed up {formatRelative(u.createdAt).toLowerCase()}</p></div>
            <div class="actions">
              <button class="btn small ghost" type="button" disabled={busy === u.id} onclick={() => update(u, { status: 'rejected' }, `Rejected ${u.username}`)}>Reject</button>
              <button class="btn small primary" type="button" disabled={busy === u.id} onclick={() => update(u, { status: 'active' }, `${u.username} can now sign in`)}>Approve</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="block">
    <h2>Members</h2>
    <ul class="users">
      {#each others as u (u.id)}
        <li class="card user">
          <span class="avatar">{u.username.slice(0, 1).toUpperCase()}</span>
          <div class="text">
            <p class="name">{u.username} {#if u.id === meId}<span class="subtle small">(you)</span>{/if}</p>
            <p class="small subtle">
              <span class="status {u.status}">{STATUS[u.status]}</span> · joined {formatRelative(u.createdAt).toLowerCase()}
            </p>
          </div>
          <div class="actions">
            {#if isOwner && u.role !== 'owner'}
              <select
                class="input role"
                aria-label="Role of {u.username}"
                value={u.role}
                disabled={busy === u.id}
                onchange={(e) => update(u, { role: e.currentTarget.value as 'curator' | 'member' }, `${u.username} is now a ${e.currentTarget.value}`)}
              >
                <option value="member">Member</option>
                <option value="curator">Curator</option>
              </select>
            {:else}
              <span class="chip">{ROLE_LABEL[u.role]}</span>
            {/if}
            {#if canManage(u)}
              {#if u.status === 'active'}
                <button class="btn small ghost" type="button" disabled={busy === u.id} onclick={() => update(u, { status: 'disabled' }, `Disabled ${u.username}`)}>Disable</button>
              {:else}
                <button class="btn small" type="button" disabled={busy === u.id} onclick={() => update(u, { status: 'active' }, `Enabled ${u.username}`)}>Enable</button>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <p class="subtle small hint"><Icon name="info" size={14} /> Curators add, edit and remove books and accept signups. Only the owner changes roles and server settings.</p>
  </section>
{/if}

<style>
  .block {
    max-width: 860px;
    margin-bottom: 28px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 17px;
    margin-bottom: 10px;
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .users {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .user {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 12px;
    padding: 10px 14px;
  }
  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 650;
  }
  .text {
    flex: 1 1 160px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .role {
    width: auto;
    min-height: 32px;
    padding: 4px 8px;
    font-size: 13px;
  }
  .status.disabled,
  .status.rejected {
    color: var(--danger);
  }
  .hint {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 12px;
  }
</style>
