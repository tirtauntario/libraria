/**
 * Placeholders for source kinds that are not built yet. Each one is replaced
 * by calling registerSourceKind() with a real definition from its own module
 * (e.g. `sources/webdav.ts`); keep the same `kind`.
 */
import type { SourceKind } from '@libraria/core';
import { registerSourceKind } from './registry';

const STUBS: { kind: SourceKind; label: string; description: string; deviceOnly: boolean; supported?: () => boolean }[] = [
  {
    kind: 'folder',
    label: 'Folder on this device',
    description: 'Read books straight from a folder (Chrome and Edge).',
    deviceOnly: true,
    supported: () => typeof window !== 'undefined' && 'showDirectoryPicker' in window,
  },
  { kind: 'webdav', label: 'WebDAV', description: 'Nextcloud, ownCloud, a NAS or any WebDAV server.', deviceOnly: false },
  { kind: 'gdrive', label: 'Google Drive', description: 'A folder in your Google Drive.', deviceOnly: false },
  { kind: 'dropbox', label: 'Dropbox', description: 'A folder in your Dropbox.', deviceOnly: false },
  { kind: 'libraria', label: 'Libraria server', description: 'A community library you joined.', deviceOnly: false },
];

for (const s of STUBS) {
  registerSourceKind({
    kind: s.kind,
    label: s.label,
    description: s.description,
    deviceOnly: s.deviceOnly,
    implemented: false,
    userCreatable: true,
    isSupported: s.supported ?? (() => true),
    createDriver: () => {
      throw new Error(`${s.label} sources are not available yet.`);
    },
  });
}
