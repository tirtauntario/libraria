/**
 * Real drivers for the folder, WebDAV, Google Drive and Dropbox kinds. They
 * replace the stubs registered in `stubs.ts` (imported first).
 */
import { DropboxDriver } from './dropbox';
import { FolderDriver, folderSupported } from './folder';
import { GdriveDriver } from './gdrive';
import { registerSourceKind } from './registry';
import DropboxSetup from './ui/DropboxSetup.svelte';
import FolderSetup from './ui/FolderSetup.svelte';
import GdriveSetup from './ui/GdriveSetup.svelte';
import WebdavSetup from './ui/WebdavSetup.svelte';
import { WebdavDriver } from './webdav';

registerSourceKind({
  kind: 'folder',
  label: 'Folder on this device',
  description: 'Read books straight from a folder on this computer. Nothing is copied.',
  deviceOnly: true,
  implemented: true,
  userCreatable: true,
  isSupported: folderSupported,
  unsupportedHint: 'Linking a folder needs Chrome or Edge on a computer. In this browser, use “Add books” to import files instead.',
  createDriver: (source, ctx) => new FolderDriver(source, ctx.repo),
  setup: FolderSetup,
});

registerSourceKind({
  kind: 'webdav',
  label: 'WebDAV',
  description: 'Nextcloud, ownCloud, a NAS or any WebDAV server.',
  deviceOnly: false,
  implemented: true,
  userCreatable: true,
  isSupported: () => true,
  createDriver: (source) => {
    if (source.config.kind !== 'webdav') throw new Error('Not a WebDAV source');
    return new WebdavDriver(source, source.config);
  },
  setup: WebdavSetup,
});

registerSourceKind({
  kind: 'gdrive',
  label: 'Google Drive',
  description: 'A folder in your Google Drive (read-only).',
  deviceOnly: false,
  implemented: true,
  userCreatable: true,
  pathsAreIds: true,
  isSupported: () => typeof crypto !== 'undefined' && !!crypto.getRandomValues,
  createDriver: (source) => {
    if (source.config.kind !== 'gdrive') throw new Error('Not a Google Drive source');
    return new GdriveDriver(source, source.config);
  },
  setup: GdriveSetup,
});

registerSourceKind({
  kind: 'dropbox',
  label: 'Dropbox',
  description: 'A folder in your Dropbox.',
  deviceOnly: false,
  implemented: true,
  userCreatable: true,
  isSupported: () => typeof crypto !== 'undefined' && !!crypto.subtle,
  createDriver: (source, ctx) => {
    if (source.config.kind !== 'dropbox') throw new Error('Not a Dropbox source');
    return new DropboxDriver(source, source.config, ctx.repo);
  },
  setup: DropboxSetup,
});
