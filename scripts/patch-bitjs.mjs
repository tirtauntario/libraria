// Patches @codedread/bitjs const-reassignment bugs that break esbuild/Vite.
// See unrar.js (globalData) and rarvm.js (newBlockSize).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const store = 'node_modules/.pnpm';
if (!existsSync(store)) process.exit(0);

const patches = [
  ['unrar.js', 'const globalData = stackFilter.Prg.GlobalData;', 'let globalData = stackFilter.Prg.GlobalData;'],
  ['rarvm.js', 'const newBlockSize = dataView.getUint32(0x1c', 'let newBlockSize = dataView.getUint32(0x1c'],
];

for (const dir of readdirSync(store).filter((d) => d.startsWith('@codedread+bitjs@'))) {
  const archive = join(store, dir, 'node_modules/@codedread/bitjs/archive');
  for (const [file, from, to] of patches) {
    const path = join(archive, file);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, 'utf8');
    if (src.includes(from)) writeFileSync(path, src.replace(from, to));
  }
}
