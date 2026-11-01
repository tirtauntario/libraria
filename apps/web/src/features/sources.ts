/**
 * Storage sources feature: cloud settings section, finishing OAuth sign-ins
 * after a redirect, permission checks for linked folders and the throttled
 * rescan on app start. The drivers themselves register in
 * `lib/sources/register.ts`.
 */
import { onStartup, settingsSections } from '../lib/extensions';
import { net } from '../lib/net.svelte';
import { router } from '../lib/router.svelte';
import { services } from '../lib/services';
import { finishSignIn } from '../lib/sources/oauth-flow.svelte';
import CloudSettings from '../lib/sources/ui/CloudSettings.svelte';
import { scanner } from '../lib/stores/scanner.svelte';
import { toasts } from '../lib/stores/toasts.svelte';

settingsSections.register({ id: 'cloud-storage', title: 'Cloud storage', component: CloudSettings, order: 50 });

onStartup(async () => {
  const s = services();
  scanner.attach(s);

  const signIn = await finishSignIn(s.repo);
  if (signIn && !signIn.redirecting) {
    if (!signIn.ok) {
      toasts.error('Sign-in did not complete', signIn.message);
    } else if (signIn.purpose === 'reauth' && signIn.sourceId) {
      toasts.show('Signed in again', { kind: 'success' });
      scanner.setProblem(signIn.sourceId, null);
      const src = await s.repo.getSource(signIn.sourceId);
      if (src) void scanner.scan(src);
    } else if (signIn.purpose === 'setup' && !router.path.startsWith('/libraries')) {
      router.navigate(`/libraries?add=${signIn.provider}`, { replace: true });
    }
  }

  await scanner.checkAccess();
  // Periodic rescan on app open, throttled per source (RESCAN_INTERVAL).
  net.whenOnline(() => void scanner.autoRescan().catch(() => {}));
});
