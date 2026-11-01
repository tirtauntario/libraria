// Renders the app icons (PNG) from the SVG logo with headless Chromium.
// Run: pnpm --filter @libraria/web icons
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = new URL('../public/', import.meta.url);

// Square, full-bleed artwork. `pad` shrinks the book into the maskable safe zone.
const art = (rounded, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%">
  <rect width="64" height="64" rx="${rounded ? 15 : 0}" fill="#24584b"/>
  <g transform="translate(32 32) scale(${1 - pad}) translate(-32 -32)">
    <path d="M14 19.5c6.5 0 12 1.6 18 5.2v24.6c-6-3.6-11.5-5.2-18-5.2z" fill="#f4efe4"/>
    <path d="M50 19.5c-6.5 0-12 1.6-18 5.2v24.6c6-3.6 11.5-5.2 18-5.2z" fill="#e3d9c4"/>
    <path d="M40 14v14l3.5-2.6L47 28V14z" fill="#e0a43a"/>
  </g>
</svg>`;

const icons = [
  { file: 'icon-192.png', size: 192, rounded: true, pad: 0 },
  { file: 'icon-512.png', size: 512, rounded: true, pad: 0 },
  // Maskable: full-bleed background, artwork inside the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, rounded: false, pad: 0.22 },
  // iOS rounds the corners itself.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, pad: 0.08 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const icon of icons) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${art(icon.rounded, icon.pad)}</body></html>`,
  );
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
  writeFileSync(new URL(icon.file, out), png);
  console.log('wrote', icon.file);
}
await browser.close();
