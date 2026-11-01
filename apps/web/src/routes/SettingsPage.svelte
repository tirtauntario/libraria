<script lang="ts">
  import { settingsSections } from '../lib/extensions';
  import { removeOfflineCopy, runEviction } from '../lib/library/offline';
  import { href } from '../lib/router.svelte';
  import { services } from '../lib/services';
  import { catalog } from '../lib/stores/catalog.svelte';
  import { INSTALL_HELP, pwa } from '../lib/stores/pwa.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { isPersisted, requestPersistence, storageEstimate, type StorageEstimate } from '../lib/storage/opfs';
  import Dialog from '../lib/ui/Dialog.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import Segmented from '../lib/ui/Segmented.svelte';
  import { formatBytes, plural } from '../lib/ui/format';

  let { params: _params }: { params: Record<string, string> } = $props();

  const GB = 1024 * 1024 * 1024;
  const LIMITS = [0, 1, 2, 5, 10, 20, 50].map((g) => g * GB);
  const DAYS = [0, 7, 14, 30, 60, 90];

  let estimate = $state<StorageEstimate | null>(null);
  let persisted = $state<boolean | null>(null);

  async function refreshStorage() {
    [estimate, persisted] = await Promise.all([storageEstimate(), isPersisted()]);
  }
  $effect(() => {
    void catalog.offline;
    void catalog.files;
    void refreshStorage();
  });

  const deviceBytes = $derived(
    catalog.files.filter((f) => f.sourceId === catalog.localSourceId).reduce((n, f) => n + (f.size ?? 0), 0),
  );
  const offlineList = $derived(
    [...catalog.offline.values()]
      .map((o) => ({ o, book: catalog.book(o.bookId) }))
      .sort((a, b) => b.o.size - a.o.size),
  );
  const offlineBytes = $derived(offlineList.reduce((n, x) => n + x.o.size, 0));

  async function askPersist() {
    const ok = await requestPersistence();
    persisted = ok;
    toasts.show(ok ? 'Storage is now persistent.' : 'The browser declined. Installing the app usually helps.', { kind: ok ? 'success' : 'info' });
  }

  async function cleanup() {
    const removed = await runEviction(services());
    toasts.show(removed.length ? `Removed ${plural(removed.length, 'offline copy', 'offline copies')}` : 'Nothing to remove');
  }

  let updateState = $state<'idle' | 'checking' | 'updated' | 'current' | 'failed'>('idle');
  async function checkUpdate() {
    updateState = 'checking';
    updateState = await pwa.checkForUpdate();
  }

  let clearOpen = $state(false);
  let clearText = $state('');
  async function clearAll() {
    const s = services();
    await s.files.clear();
    await s.repo.clearAll();
    await s.repo.init();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    clearOpen = false;
    location.hash = '#/';
    location.reload();
  }

</script>

<div class="page narrow">
  <header class="page-header"><h1>Settings</h1></header>

  <section class="card group">
    <h2>Appearance</h2>
    <div class="row">
      <div class="row-text"><p>Theme</p><p class="subtle">Applies to this device.</p></div>
      <Segmented
        label="Theme"
        value={settings.theme}
        onchange={(v) => settings.setTheme(v)}
        options={[
          { value: 'system', label: 'Auto', icon: 'monitor' },
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
        ]}
      />
    </div>
  </section>

  <section class="card group">
    <h2>Reading <span class="chip"><Icon name="refresh" size={12} /> Synced</span></h2>
    <p class="subtle intro">Defaults for every book. They follow you to your other devices once sync is set up. Change them while reading, too.</p>
    <h3>Comics</h3>
    <div class="row">
      <p class="row-text">Layout</p>
      <Segmented label="Comic layout" value={settings.synced.comic.mode} onchange={(v) => settings.updateSynced((s) => (s.comic.mode = v))}
        options={[{ value: 'paged', label: 'Pages' }, { value: 'continuous', label: 'Scroll' }]} />
    </div>
    <div class="row">
      <p class="row-text">Direction</p>
      <Segmented label="Reading direction" value={settings.synced.comic.direction} onchange={(v) => settings.updateSynced((s) => (s.comic.direction = v))}
        options={[{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]} />
    </div>
    <div class="row">
      <p class="row-text">Fit</p>
      <select class="input select" value={settings.synced.comic.fit} aria-label="Comic fit"
        onchange={(e) => settings.updateSynced((s) => (s.comic.fit = e.currentTarget.value as typeof s.comic.fit))}>
        <option value="contain">Whole page</option>
        <option value="width">Fit width</option>
        <option value="height">Fit height</option>
        <option value="original">Original size</option>
      </select>
    </div>
    <label class="row">
      <span class="row-text"><span>Two-page spreads</span><span class="subtle">On wide screens</span></span>
      <input type="checkbox" checked={settings.synced.comic.spread} onchange={(e) => settings.updateSynced((s) => (s.comic.spread = e.currentTarget.checked))} />
    </label>
    <h3>Books</h3>
    <div class="row">
      <p class="row-text">Layout</p>
      <Segmented label="Book layout" value={settings.synced.book.flow} onchange={(v) => settings.updateSynced((s) => (s.book.flow = v))}
        options={[{ value: 'paginated', label: 'Pages' }, { value: 'scrolled', label: 'Scroll' }]} />
    </div>
    <div class="row">
      <p class="row-text">Page colour</p>
      <Segmented label="Book theme" value={settings.synced.book.theme} onchange={(v) => settings.updateSynced((s) => (s.book.theme = v))}
        options={[{ value: 'light', label: 'Light' }, { value: 'sepia', label: 'Sepia' }, { value: 'dark', label: 'Dark' }]} />
    </div>
  </section>

  <section class="card group">
    <h2>This device <span class="chip"><Icon name="device" size={12} /> Not synced</span></h2>
    <label class="row">
      <span class="row-text"><span>Download books when opened</span><span class="subtle">Keeps a copy so they open offline next time</span></span>
      <input type="checkbox" checked={settings.device.autoDownloadOnOpen} onchange={(e) => settings.updateDevice((d) => (d.autoDownloadOnOpen = e.currentTarget.checked))} />
    </label>
    <label class="row">
      <span class="row-text"><span>Download on mobile data</span><span class="subtle">Detected in Chrome and Edge only</span></span>
      <input type="checkbox" checked={settings.device.downloadOnMetered} onchange={(e) => settings.updateDevice((d) => (d.downloadOnMetered = e.currentTarget.checked))} />
    </label>
    <div class="row">
      <label class="row-text" for="limit"><span>Offline storage limit</span><span class="subtle">Oldest unpinned copies go first</span></label>
      <select id="limit" class="input select" value={settings.device.offlineLimitBytes}
        onchange={(e) => settings.updateDevice((d) => (d.offlineLimitBytes = Number(e.currentTarget.value)))}>
        {#each LIMITS as l (l)}<option value={l}>{l ? formatBytes(l) : 'No limit'}</option>{/each}
      </select>
    </div>
    <div class="row">
      <label class="row-text" for="days"><span>Remove unopened copies</span><span class="subtle">Unpinned offline copies only</span></label>
      <select id="days" class="input select" value={settings.device.autoRemoveDays}
        onchange={(e) => settings.updateDevice((d) => (d.autoRemoveDays = Number(e.currentTarget.value)))}>
        {#each DAYS as d (d)}<option value={d}>{d ? `After ${d} days` : 'Never'}</option>{/each}
      </select>
    </div>
    <label class="row">
      <span class="row-text"><span>Sync automatically</span><span class="subtle">When a sync server is set up</span></span>
      <input type="checkbox" checked={settings.device.autoSync} onchange={(e) => settings.updateDevice((d) => (d.autoSync = e.currentTarget.checked))} />
    </label>
    <label class="row">
      <span class="row-text"><span>Device name</span><span class="subtle">Shown on your other devices</span></span>
      <input class="input name" value={settings.device.deviceName} placeholder="e.g. Kitchen iPad"
        onchange={(e) => settings.updateDevice((d) => (d.deviceName = e.currentTarget.value.trim()))} />
    </label>
  </section>

  <section class="card group">
    <h2>Storage</h2>
    {#if estimate && estimate.quota > 0}
      <div class="meter" aria-label="Storage used">
        <div class="meter-bar"><div style:width="{Math.min(100, (estimate.usage / estimate.quota) * 100)}%"></div></div>
        <p class="subtle">{formatBytes(estimate.usage)} used of {formatBytes(estimate.quota)} available to Libraria</p>
      </div>
    {/if}
    <dl class="stats">
      <div><dt>Books</dt><dd>{catalog.books.length}</dd></div>
      <div><dt>Imported files</dt><dd>{formatBytes(deviceBytes)}</dd></div>
      <div><dt>Offline copies</dt><dd>{formatBytes(offlineBytes)}</dd></div>
      <div><dt>Stored in</dt><dd>{services().files.kind === 'opfs' ? 'File system' : 'Database'}</dd></div>
    </dl>
    <div class="row">
      <div class="row-text">
        <p>Persistent storage</p>
        <p class="subtle">{persisted ? 'Granted. The browser will not clear your books to free space.' : 'Not granted. The browser may clear data when space runs low.'}</p>
      </div>
      {#if persisted === false}<button class="btn small" type="button" onclick={askPersist}>Request</button>{/if}
      {#if persisted}<Icon name="check" />{/if}
    </div>

    {#if offlineList.length}
      <h3>Offline copies</h3>
      <ul class="offline">
        {#each offlineList as { o, book } (o.id)}
          <li>
            <a href={book ? href('/book', book.id) : undefined}>{book?.title ?? 'Unknown book'}</a>
            {#if o.pinned}<span class="chip">Kept</span>{/if}
            <span class="subtle size">{formatBytes(o.size)}</span>
            <button class="icon-btn" type="button" aria-label="Remove offline copy" onclick={() => removeOfflineCopy(o.bookId, services())}><Icon name="trash" size={16} /></button>
          </li>
        {/each}
      </ul>
      <button class="btn small" type="button" onclick={cleanup}>Clean up now</button>
    {/if}
  </section>

  <section class="card group">
    <h2>App</h2>
    {#if pwa.installed}
      <div class="row">
        <div class="row-text"><p>Installed</p><p class="subtle">Libraria runs as an app on this device.</p></div>
        <button class="btn small" type="button" onclick={checkUpdate} disabled={updateState === 'checking'}>
          {updateState === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {#if updateState === 'current'}<p class="subtle">You have the latest version.</p>{/if}
      {#if updateState === 'updated'}<p class="subtle">An update is downloading; you will be asked to reload.</p>{/if}
      {#if updateState === 'failed'}<p class="subtle">Could not check for updates.</p>{/if}
    {:else}
      <div class="row">
        <div class="row-text"><p>Install Libraria</p><p class="subtle">{INSTALL_HELP[pwa.platform]}</p></div>
        {#if pwa.canPrompt}<button class="btn small primary" type="button" onclick={() => pwa.promptInstall()}>Install</button>{/if}
      </div>
    {/if}
    {#if pwa.updateAvailable}
      <div class="row">
        <p class="row-text">A new version is ready.</p>
        <button class="btn small primary" type="button" onclick={() => pwa.applyUpdate()}>Reload</button>
      </div>
    {/if}
  </section>

  {#each settingsSections.list() as section (section.id)}
    <section class="card group">
      <h2>{section.title}</h2>
      <section.component />
    </section>
  {/each}

  <section class="card group">
    <h2>Data</h2>
    <div class="row">
      <div class="row-text"><p>Clear all data</p><p class="subtle">Deletes every book, offline copy, bookmark, progress and setting on this device.</p></div>
      <button class="btn small danger-outline" type="button" onclick={() => (clearOpen = true)}>Clear…</button>
    </div>
  </section>

  <section class="about">
    <p><strong>Libraria</strong> {__APP_VERSION__} · <a href="#/about">About Libraria</a></p>
    <p class="subtle">
      Free software under the <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">GNU AGPL-3.0</a>.
      <a href={__SOURCE_URL__} target="_blank" rel="noopener noreferrer">Source code</a>.
    </p>
  </section>
</div>

<Dialog bind:open={clearOpen} title="Clear all data?" onclose={() => (clearText = '')}>
  <form id="clear-form" class="form" onsubmit={(e) => { e.preventDefault(); if (clearText === 'delete') void clearAll(); }}>
    <p class="muted">This removes {plural(catalog.books.length, 'book')} and everything else Libraria stored on this device. It cannot be undone. Data synced to a server is not affected.</p>
    <label class="field"><span>Type <strong>delete</strong> to confirm</span><input class="input" bind:value={clearText} autocomplete="off" /></label>
  </form>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (clearOpen = false)}>Cancel</button>
    <button class="btn danger" type="submit" form="clear-form" disabled={clearText !== 'delete'}>Clear everything</button>
  {/snippet}
</Dialog>

<style>
  .narrow {
    max-width: 760px;
  }
  .group {
    padding: 18px 20px;
    margin-bottom: 16px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 17px;
    margin-bottom: 8px;
  }
  h3 {
    margin: 18px 0 4px;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .intro {
    font-size: 13.5px;
    margin-bottom: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px 16px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  h2 + .row,
  h3 + .row {
    border-top: 0;
  }
  .row-text {
    display: grid;
    gap: 2px;
    flex: 1 1 220px;
    min-width: 0;
  }
  .row-text .subtle,
  .row-text p.subtle {
    font-size: 13px;
  }
  .select {
    width: auto;
    min-width: 150px;
  }
  .name {
    width: min(240px, 100%);
  }
  .meter {
    margin: 4px 0 12px;
    display: grid;
    gap: 6px;
    font-size: 13px;
  }
  .meter-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .meter-bar > div {
    height: 100%;
    background: var(--accent);
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin: 0 0 8px;
  }
  .stats dt {
    font-size: 12px;
    color: var(--text-3);
  }
  .stats dd {
    margin: 2px 0 0;
    font-weight: 600;
    font-size: 17px;
  }
  .offline {
    list-style: none;
    margin: 4px 0 12px;
    padding: 0;
  }
  .offline li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    border-bottom: 1px solid var(--border);
  }
  .offline a {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .size {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .danger-outline {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .about {
    padding: 16px 4px;
    display: grid;
    gap: 4px;
    font-size: 13.5px;
  }
  .form {
    display: grid;
    gap: 14px;
  }
</style>
