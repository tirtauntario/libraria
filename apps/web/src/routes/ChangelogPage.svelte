<script lang="ts">
  import { UNRELEASED } from '@libraria/core';
  import { router } from '../lib/router.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import { APP_BUILD, APP_VERSION, buildLabel, releaseNotes } from '../lib/version';

  let { params: _params }: { params: Record<string, string> } = $props();

  const entries = releaseNotes();

  /** CHANGELOG items are Markdown; show them as plain text. */
  const plain = (s: string) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  const formatDate = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
</script>

<div class="page narrow">
  <header class="page-header">
    <button class="icon-btn" type="button" aria-label="Back" onclick={() => router.back('/settings')}><Icon name="arrow-left" /></button>
    <h1>What's new</h1>
  </header>

  <section class="card current">
    <p class="version">Libraria {APP_VERSION}</p>
    <p class="subtle">{buildLabel()}{#if APP_BUILD.full !== APP_VERSION} · <code>{APP_BUILD.full}</code>{/if}</p>
  </section>

  {#each entries as entry (entry.version)}
    <section class="card entry">
      <h2>
        {#if entry.version === UNRELEASED}
          Coming in the next version
        {:else}
          {entry.version}
          {#if entry.version === APP_VERSION}<span class="chip">This version</span>{/if}
        {/if}
      </h2>
      {#if entry.date}<p class="subtle date">{formatDate(entry.date)}</p>{/if}
      {#if entry.version === UNRELEASED}<p class="subtle date">Already in this build, not yet released.</p>{/if}
      {#each entry.sections as section, i (i)}
        {#if section.title}<h3>{section.title}</h3>{/if}
        <ul>
          {#each section.items as item, j (j)}<li>{plain(item)}</li>{/each}
        </ul>
      {/each}
    </section>
  {:else}
    <p class="muted">No release notes yet.</p>
  {/each}
</div>

<style>
  .narrow {
    max-width: 760px;
  }
  .current,
  .entry {
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .version {
    margin: 0 0 2px;
    font-size: 17px;
    font-weight: 600;
  }
  .current .subtle {
    margin: 0;
    font-size: 13px;
  }
  code {
    font-size: 12px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 17px;
    margin: 0;
  }
  .date {
    margin: 2px 0 8px;
    font-size: 13px;
  }
  h3 {
    margin: 12px 0 4px;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  ul {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: 6px;
    line-height: 1.5;
  }
</style>
