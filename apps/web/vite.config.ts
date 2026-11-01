import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// @codedread/bitjs only exports its index, but the CBR worker in core imports
// `@codedread/bitjs/archive/unrar.js` directly. Point that at the real file.
const bitjsDir = dirname(createRequire(new URL('../../packages/core/package.json', import.meta.url)).resolve('@codedread/bitjs'));

const THEME = '#24584b';
const BACKGROUND = '#f7f5f0';

export default defineConfig({
  // Relative base: the same build works at a domain root, under a sub-path
  // (static hosting) and when served by a Libraria server.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SOURCE_URL__: JSON.stringify('https://github.com/tirtauntario/libraria'),
  },
  resolve: {
    alias: [{ find: /^@codedread\/bitjs\/archive\/(.*)$/, replacement: `${bitjsDir}/archive/$1` }],
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: './',
        name: 'Libraria',
        short_name: 'Libraria',
        description: 'Offline-first reader for EPUB, PDF and comics.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        theme_color: THEME,
        background_color: BACKGROUND,
        categories: ['books', 'entertainment'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        file_handlers: [
          {
            action: './',
            accept: {
              'application/epub+zip': ['.epub'],
              'application/pdf': ['.pdf'],
              'application/vnd.comicbook+zip': ['.cbz'],
              'application/vnd.comicbook-rar': ['.cbr'],
            },
          },
        ],
        launch_handler: { client_mode: 'focus-existing' },
        // Android: appear in the share sheet for books (public/share-target.js receives them).
        // file_handlers above is desktop-only; iOS supports neither.
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            files: [
              {
                name: 'books',
                // Android often labels comics as plain zip/rar or as octet-stream.
                accept: [
                  'application/epub+zip',
                  'application/pdf',
                  'application/vnd.comicbook+zip',
                  'application/vnd.comicbook-rar',
                  'application/x-cbz',
                  'application/x-cbr',
                  'application/zip',
                  'application/vnd.rar',
                  'application/x-rar-compressed',
                  'application/octet-stream',
                  '.epub',
                  '.pdf',
                  '.cbz',
                  '.cbr',
                ],
              },
            ],
          },
        },
      },
      workbox: {
        importScripts: ['share-target.js'],
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest,wasm}'],
        // pdf.js worker and the app chunks are larger than workbox's 2 MB default.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
    }),
  ],
});
