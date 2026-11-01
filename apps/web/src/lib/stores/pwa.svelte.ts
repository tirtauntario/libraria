/**
 * Install prompt and service-worker update state.
 */
import { toasts } from './toasts.svelte';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'libraria:install-dismissed';

function standalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type Platform = 'ios' | 'android' | 'mac-safari' | 'chromium' | 'firefox' | 'other';

export function detectPlatform(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'mac-safari';
  return 'other';
}

/** How to install on each platform (Settings and About). */
export const INSTALL_HELP: Record<Platform, string> = {
  ios: 'In Safari, tap Share, then “Add to Home Screen”. On iPhone and iPad, offline storage is only dependable for the installed app.',
  android: 'Open the browser menu and choose “Install app” or “Add to Home screen”.',
  'mac-safari': 'In Safari, choose File › Add to Dock.',
  chromium: 'Use the install icon in the address bar, or the browser menu › “Install Libraria”.',
  firefox: 'Firefox on desktop cannot install web apps. Libraria still works in the browser tab.',
  other: 'Look for “Install” or “Add to Home Screen” in your browser menu.',
};

class PwaState {
  installed = $state(standalone());
  canPrompt = $state(false);
  updateAvailable = $state(false);
  dismissed = $state(false);
  platform: Platform = detectPlatform();

  private deferred: BeforeInstallPromptEvent | null = null;
  private updateSW: ((reload?: boolean) => Promise<void>) | null = null;
  private registration: ServiceWorkerRegistration | null = null;

  init(): void {
    try {
      this.dismissed = !!localStorage.getItem(DISMISS_KEY);
    } catch {
      // ignore
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferred = e as BeforeInstallPromptEvent;
      this.canPrompt = true;
    });
    window.addEventListener('appinstalled', () => {
      this.installed = true;
      this.canPrompt = false;
      this.deferred = null;
    });
    window.matchMedia?.('(display-mode: standalone)').addEventListener('change', (e) => (this.installed = e.matches));
    void this.register();
  }

  private async register(): Promise<void> {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
    try {
      const { registerSW } = await import('virtual:pwa-register');
      this.updateSW = registerSW({
        immediate: true,
        onNeedRefresh: () => {
          this.updateAvailable = true;
          toasts.show('A new version of Libraria is ready.', {
            timeout: 0,
            action: { label: 'Reload', run: () => void this.applyUpdate() },
          });
        },
        onOfflineReady: () => {
          toasts.show('Libraria is ready to work offline.', { kind: 'success' });
        },
        onRegisteredSW: (_url, reg) => {
          this.registration = reg ?? null;
          // Look for updates every hour while open.
          if (reg) setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000);
        },
      });
    } catch {
      // No service worker (e.g. insecure origin). The app still works online.
    }
  }

  async promptInstall(): Promise<boolean> {
    if (!this.deferred) return false;
    await this.deferred.prompt();
    const { outcome } = await this.deferred.userChoice;
    this.deferred = null;
    this.canPrompt = false;
    return outcome === 'accepted';
  }

  dismissInstall(): void {
    this.dismissed = true;
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore
    }
  }

  async checkForUpdate(): Promise<'updated' | 'current' | 'failed'> {
    try {
      const reg = this.registration ?? (await navigator.serviceWorker?.getRegistration());
      if (!reg) return 'failed';
      await reg.update();
      return reg.waiting || reg.installing ? 'updated' : 'current';
    } catch {
      return 'failed';
    }
  }

  async applyUpdate(): Promise<void> {
    await this.updateSW?.(true);
  }
}

export const pwa = new PwaState();
