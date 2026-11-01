<script lang="ts">
  import type { InviteDto } from '@libraria/core';
  import { net } from '../../../lib/net.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { apiFor } from '../../../lib/server/servers';
  import { appBaseUrl, inviteLink } from '../../../lib/server/url';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import Icon from '../../../lib/ui/Icon.svelte';
  import { formatRelative } from '../../../lib/ui/format';
  import type { ServerEntry } from '../store.svelte';

  let { entry }: { entry: ServerEntry } = $props();
  const api = $derived(apiFor(entry.source, services().repo));
  const info = $derived(entry.state.info);

  let items = $state<InviteDto[] | null>(null);
  let error = $state<string | null>(null);
  let fresh = $state<{ invite: InviteDto; link: string } | null>(null);
  let creating = $state(false);

  async function load() {
    if (!net.online) return;
    try {
      items = (await api.listInvites()).items;
      error = null;
    } catch (err) {
      error = describeError(err);
    }
  }
  $effect(() => {
    void net.online;
    void load();
  });

  async function create() {
    creating = true;
    try {
      const invite = await api.createInvite();
      fresh = { invite, link: inviteLink(appBaseUrl(), entry.source.config.url, invite.token!) };
      await load();
    } catch (err) {
      toasts.error('Could not create an invite', describeError(err));
    } finally {
      creating = false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show('Invite link copied', { kind: 'success', timeout: 2500 });
    } catch {
      toasts.error('Could not copy', 'Select the link and copy it by hand.');
    }
  }

  async function share(text: string) {
    try {
      await navigator.share({ title: `Join ${entry.source.name} on Libraria`, url: text });
    } catch {
      // cancelled
    }
  }

  async function revoke(i: InviteDto) {
    try {
      await api.revokeInvite(i.id);
      if (fresh?.invite.id === i.id) fresh = null;
      toasts.show('Invite revoked');
      await load();
    } catch (err) {
      toasts.error('Could not revoke', describeError(err));
    }
  }

  function inviteState(i: InviteDto): 'used' | 'expired' | 'active' {
    if (i.usedBy) return 'used';
    return i.expiresAt <= Date.now() ? 'expired' : 'active';
  }
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
</script>

<section class="block">
  <div class="head">
    <h2>Invite links</h2>
    <button class="btn primary small" type="button" onclick={create} disabled={creating || !net.online}><Icon name="plus" size={16} /> New invite</button>
  </div>
  <p class="muted small">
    Each link works once. It opens Libraria with this server filled in.
    {#if info?.visibility === 'private'}In a private library, people who join with an invite skip the approval queue unless the owner turned that off.{/if}
  </p>

  {#if fresh}
    <div class="card fresh" data-testid="invite-link">
      <p class="label">Share this link. It is shown only now.</p>
      <code class="link">{fresh.link}</code>
      <div class="row">
        <button class="btn small" type="button" onclick={() => copy(fresh!.link)}><Icon name="check" size={16} /> Copy link</button>
        {#if canShare}<button class="btn small" type="button" onclick={() => share(fresh!.link)}><Icon name="external" size={16} /> Share</button>{/if}
        <span class="subtle small">Expires {formatRelative(fresh.invite.expiresAt).toLowerCase()}</span>
      </div>
    </div>
  {/if}

  {#if !net.online}
    <p class="subtle">Connect to manage invites.</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if items === null}
    <div class="spinner"></div>
  {:else if items.length === 0}
    <p class="subtle small">No invites yet.</p>
  {:else}
    <ul class="invites">
      {#each items as i (i.id)}
        {@const st = inviteState(i)}
        <li>
          <span class="chip {st}">{st === 'used' ? 'Used' : st === 'expired' ? 'Expired' : 'Open'}</span>
          <span class="small grow">Created {formatRelative(i.createdAt).toLowerCase()} · {st === 'active' ? `expires ${formatRelative(i.expiresAt).toLowerCase()}` : st === 'used' ? 'someone joined with it' : 'no longer works'}</span>
          {#if st === 'active'}<button class="btn small ghost" type="button" onclick={() => revoke(i)}>Revoke</button>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .block {
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
  .fresh {
    display: grid;
    gap: 10px;
    padding: 14px 16px;
    margin-bottom: 16px;
    border-color: var(--accent);
  }
  .link {
    display: block;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 13px;
    word-break: break-all;
    user-select: all;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .invites {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .invites li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    min-height: 48px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .grow {
    flex: 1 1 200px;
    color: var(--text-2);
  }
  .chip.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
</style>
