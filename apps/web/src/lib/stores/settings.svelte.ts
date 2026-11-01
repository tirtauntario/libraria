import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_SYNCED_SETTINGS,
  type DeviceSettings,
  type SyncedSettings,
} from '@libraria/core';
import type { UiState } from '../db/schema';
import type { Repo } from '../db/repo';

export type AppTheme = 'system' | 'light' | 'dark';
const THEME_KEY = 'libraria:theme';

function readTheme(): AppTheme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Reactive settings. Synced settings follow the user across devices; device
 * settings never leave this device. Writes are debounced so dragging a
 * slider or pinching does not hammer IndexedDB.
 */
class SettingsState {
  synced = $state<SyncedSettings>(structuredClone(DEFAULT_SYNCED_SETTINGS));
  device = $state<DeviceSettings>(structuredClone(DEFAULT_DEVICE_SETTINGS));
  ui = $state<UiState>({ collapsedGroups: [] });
  /** App colour scheme (device-only, kept in localStorage so it applies before first paint). */
  theme = $state<AppTheme>(typeof localStorage !== 'undefined' ? readTheme() : 'system');
  loaded = $state(false);

  private repo: Repo | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async load(repo: Repo): Promise<void> {
    this.repo = repo;
    await this.reload();
    this.loaded = true;
    repo.events.subscribe((topics) => {
      if (topics.has('settings') && this.timers.size === 0) void this.reload();
    });
  }

  private async reload(): Promise<void> {
    if (!this.repo) return;
    const [synced, device, ui] = await Promise.all([this.repo.getSyncedSettings(), this.repo.getDeviceSettings(), this.repo.getUiState()]);
    this.synced = synced;
    this.device = device;
    this.ui = ui;
  }

  private schedule(key: string, fn: () => Promise<void>, delay = 400) {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void fn();
      }, delay),
    );
  }

  /** Mutate synced settings in place: settings.updateSynced(s => { s.comic.zoom = 2 }) */
  updateSynced(mutate: (s: SyncedSettings) => void): void {
    mutate(this.synced);
    this.schedule('synced', () => this.repo!.saveSyncedSettings($state.snapshot(this.synced) as SyncedSettings));
  }

  updateDevice(mutate: (s: DeviceSettings) => void): void {
    mutate(this.device);
    this.schedule('device', () => this.repo!.saveDeviceSettings($state.snapshot(this.device) as DeviceSettings), 200);
  }

  updateUi(mutate: (s: UiState) => void): void {
    mutate(this.ui);
    this.schedule('ui', () => this.repo!.saveUiState($state.snapshot(this.ui) as UiState), 200);
  }

  setTheme(theme: AppTheme): void {
    this.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // private mode
    }
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }

  /** Write pending changes now (before unload). */
  async flush(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (!this.repo) return;
    if (pending.includes('synced')) await this.repo.saveSyncedSettings($state.snapshot(this.synced) as SyncedSettings);
    if (pending.includes('device')) await this.repo.saveDeviceSettings($state.snapshot(this.device) as DeviceSettings);
    if (pending.includes('ui')) await this.repo.saveUiState($state.snapshot(this.ui) as UiState);
  }
}

export const settings = new SettingsState();
