/**
 * Optional features register themselves here (routes, nav items, settings
 * sections, source kinds, startup hooks). See README "Extension points".
 *
 * Example:
 *   import './features/server';   // Libraria server login, browse, submit, admin
 *   import './features/sync';     // end-to-end encrypted sync engine
 *   import './lib/sources/webdav';
 */
import './features/sources'; // folder, WebDAV, Google Drive, Dropbox: settings, sign-in, rescans
