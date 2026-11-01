export type ComicReadingMode = 'paged' | 'continuous';
export type ReadingDirection = 'ltr' | 'rtl';
export type FitMode = 'contain' | 'width' | 'height' | 'original';
export type BookFlow = 'paginated' | 'scrolled';
export type BookTheme = 'light' | 'sepia' | 'dark';
export type BookFont = 'publisher' | 'serif' | 'sans' | 'dyslexic' | 'mono';
export type LibraryView = 'grid' | 'list';
export type LibrarySort = 'name' | 'lastRead' | 'added';

/** Settings that follow the user across devices (synced, encrypted). */
export interface SyncedSettings {
  comic: {
    mode: ComicReadingMode;
    direction: ReadingDirection;
    fit: FitMode;
    zoom: number;
    spread: boolean;
  };
  book: {
    flow: BookFlow;
    theme: BookTheme;
    font: BookFont;
    fontSize: number;
    lineHeight: number;
    margin: number;
    wordSpacing: number;
    justify: boolean;
  };
  library: {
    view: LibraryView;
    sort: LibrarySort;
    group: boolean;
    groupRenames: Record<string, string>;
  };
  oauth: {
    googleClientId: string;
    dropboxAppKey: string;
  };
}

/** Settings for this device only. Never synced. */
export interface DeviceSettings {
  autoDownloadOnOpen: boolean;
  downloadOnMetered: boolean;
  /** Bytes; 0 means no limit beyond the browser quota. */
  offlineLimitBytes: number;
  /** Remove unpinned offline copies not opened for this many days; 0 = off. */
  autoRemoveDays: number;
  autoSync: boolean;
  deviceName: string;
}

export const DEFAULT_SYNCED_SETTINGS: SyncedSettings = {
  comic: { mode: 'paged', direction: 'ltr', fit: 'contain', zoom: 1, spread: false },
  book: {
    flow: 'paginated',
    theme: 'light',
    font: 'publisher',
    fontSize: 100,
    lineHeight: 1.5,
    margin: 5,
    wordSpacing: 0,
    justify: false,
  },
  library: { view: 'grid', sort: 'lastRead', group: true, groupRenames: {} },
  oauth: { googleClientId: '', dropboxAppKey: '' },
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  autoDownloadOnOpen: true,
  downloadOnMetered: true,
  offlineLimitBytes: 0,
  autoRemoveDays: 0,
  autoSync: true,
  deviceName: '',
};
