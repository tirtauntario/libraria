/**
 * Libraria server integration and end-to-end encrypted sync.
 *
 * Registers the `libraria` source kind, the server pages, the "Send to
 * server" book panel, the Sync settings section, and startup work (catalog
 * refresh, queued uploads, sync). Nothing here runs a request against a
 * server the user has not joined.
 */
import { bookPanels, navItems, onStartup, settingsSections } from '../../lib/extensions';
import { net } from '../../lib/net.svelte';
import { registerRoute, router } from '../../lib/router.svelte';
import { services, type Services } from '../../lib/services';
import { getServerState, isLibrariaSource, listServers, onServersChanged } from '../../lib/server/servers';
import { toasts } from '../../lib/stores/toasts.svelte';
import { purgeSourceFiles, refreshIfStale, refreshServerCatalog, registerLibrariaSource } from '../../lib/server/source';
import { processUploads } from '../../lib/server/uploads';
import { forgetDriver } from '../../lib/sources/registry';
import { sync } from '../../lib/sync/controller.svelte';
import BookServerPanel from './BookServerPanel.svelte';
import JoinPage from './JoinPage.svelte';
import LibrariaSetup from './LibrariaSetup.svelte';
import ReviewReader from './ReviewReader.svelte';
import ServerPage from './ServerPage.svelte';
import ServersPage from './ServersPage.svelte';
import { servers } from './store.svelte';
import SyncPage from './SyncPage.svelte';
import SyncSettings from './SyncSettings.svelte';

registerLibrariaSource(LibrariaSetup);

registerRoute({ pattern: '/servers', component: ServersPage, section: 'servers' });
registerRoute({ pattern: '/join', component: JoinPage, section: 'servers' });
registerRoute({ pattern: '/sync', component: SyncPage, section: 'servers' });
registerRoute({ pattern: '/server/:id', component: ServerPage, section: 'servers' });
registerRoute({ pattern: '/server/:id/review/:sub', component: ReviewReader, layout: 'bare' });

navItems.register({ id: 'servers', label: 'Servers', href: '#/servers', icon: 'cloud', order: 50 });
settingsSections.register({ id: 'sync', title: 'Sync', component: SyncSettings, order: 10 });
bookPanels.register({ id: 'server', component: BookServerPanel, order: 10 });

async function refreshAll(s: Services, maxAgeMs?: number): Promise<void> {
  for (const source of await listServers(s.repo)) {
    try {
      await refreshIfStale(source, s, maxAgeMs);
    } catch {
      // Shown on the server page (lastRefreshError).
    }
  }
}

/** A rejected token (401) marks the session expired; tell the user once and offer to sign in. */
function warnExpiredSessions(s: Services): void {
  const warned = new Set<string>();
  onServersChanged(() => {
    void (async () => {
      for (const src of await listServers(s.repo)) {
        const expired = (await getServerState(s.repo, src.id)).sessionExpired;
        if (!expired) {
          warned.delete(src.id);
          continue;
        }
        if (warned.has(src.id)) continue;
        warned.add(src.id);
        const c = src.config;
        toasts.show(`Signed out of ${src.name}`, {
          kind: 'error',
          detail: 'Your session ended. Sign in again to keep using this server.',
          timeout: 12_000,
          action: {
            label: 'Sign in',
            run: () => router.navigate(`/join?server=${encodeURIComponent(c.url)}&mode=login&username=${encodeURIComponent(c.username)}`),
          },
        });
      }
    })();
  });
}

onStartup(async () => {
  const s = services();
  await servers.load(s);
  await sync.init(s, {
    // A server joined on another device arrives as a source: fetch its
    // catalog. A server removed elsewhere: drop its books here too.
    onApplied: async (payload, svc) => {
      if (payload.kind !== 'config' || payload.value.type !== 'source') return;
      const src = payload.value.value;
      if (!isLibrariaSource(src)) return;
      if (payload.value.deleted || src.deleted) {
        await purgeSourceFiles(src.id, svc);
        forgetDriver(src.id);
      } else if (net.online) {
        void refreshServerCatalog(src, svc).catch(() => {});
      }
    },
  });
  warnExpiredSessions(s);
  void sync.auto();
  void processUploads(s).catch(() => {});
  void refreshAll(s);

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      void processUploads(s).catch(() => {});
      void refreshAll(s);
    });
  }
});
