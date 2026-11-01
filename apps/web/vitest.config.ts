import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __APP_BUILD__: JSON.stringify({ version: '0.0.0-test', full: '0.0.0-test', commit: null, dirty: false, release: false, date: '2026-01-01T00:00:00.000Z' }),
    __SOURCE_URL__: JSON.stringify('https://example.invalid'),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    testTimeout: 30000,
  },
});
