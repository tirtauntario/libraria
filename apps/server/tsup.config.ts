import { defineConfig } from 'tsup';
import { buildInfo } from '../../scripts/build-info.mjs';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // node:sqlite only exists with the prefix; never rewrite it to 'sqlite'.
  removeNodeProtocol: false,
  // Core is workspace TS source: bundle it (and its pure-JS deps) so dist runs
  // with only the runtime dependencies listed in package.json.
  noExternal: ['@libraria/core'],
  define: { __SERVER_BUILD__: JSON.stringify(buildInfo(pkg.version)) },
  banner: {
    // Bundled CommonJS deps may call require().
    js: "import { createRequire as __librariaCreateRequire } from 'node:module'; const require = __librariaCreateRequire(import.meta.url);",
  },
});
