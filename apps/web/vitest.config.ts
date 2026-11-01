import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __SOURCE_URL__: JSON.stringify('https://example.invalid'),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    testTimeout: 30000,
  },
});
