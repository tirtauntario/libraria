/**
 * Screenshots of the remaining pages and panels (for visual review), in
 * light and dark, phone and desktop. Saved to test-results/screens/.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeCbz, makeEpub, makePdf } from './fixtures';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('pages and panels', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('./');
  // A first-time visitor finds the explanation from the empty library.
  await page.getByRole('link', { name: /What Libraria is/ }).click();
  await expect(page.getByRole('heading', { name: 'What is a PWA?' })).toBeVisible();
  await shot(page, 'about-desktop');
  await page.goto('./');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add books' }).first().click();
  await (await chooser).setFiles([
    { name: 'Night Garden v01.cbz', mimeType: 'application/zip', buffer: await makeCbz(6) },
    { name: 'Night Garden v02.cbz', mimeType: 'application/zip', buffer: await makeCbz(4, 2, 'Roots') },
    { name: 'reading-room.epub', mimeType: 'application/epub+zip', buffer: await makeEpub() },
    { name: 'field-notes.pdf', mimeType: 'application/pdf', buffer: makePdf(3) },
  ]);
  await expect(page.getByText(/Added 4 books/)).toBeVisible({ timeout: 60_000 });
  for (const t of await page.locator('.toast .close').all()) await t.click({ timeout: 1000 }).catch(() => {});

  await page.goto('./#/libraries');
  await expect(page.getByRole('heading', { name: 'Libraries' })).toBeVisible();
  await shot(page, 'libraries-desktop');
  await page.getByRole('button', { name: 'Add source' }).click();
  await shot(page, 'add-source-desktop');
  await page.keyboard.press('Escape');

  await page.goto('./#/settings');
  await shot(page, 'settings-desktop');

  await page.goto('./#/');
  await page.getByRole('link', { name: 'Night Garden #1: Seeds', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Start reading' })).toBeVisible();
  await shot(page, 'book-desktop');

  await page.goto('./#/');
  await page.getByRole('link', { name: /On this device/ }).first().click();
  await page.getByRole('button', { name: 'Show as list' }).click();
  await shot(page, 'library-list-desktop');
  await page.getByRole('button', { name: 'Show as grid' }).click();

  // Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'library-dark-desktop');
  await page.setViewportSize({ width: 360, height: 760 });
  await shot(page, 'library-dark-360');
  await page.goto('./#/settings');
  await shot(page, 'settings-dark-360');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./#/');
  await page.getByRole('link', { name: 'The Reading Room', exact: true }).click();
  await shot(page, 'book-360');

  // Reader panels.
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('./#/');
  await page.getByRole('link', { name: 'Read The Reading Room' }).click();
  await expect(page.frameLocator('iframe[title="Book text"]').locator('h1')).toBeVisible();
  await page.mouse.move(300, 300);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await shot(page, 'epub-settings-desktop');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Contents' }).click();
  await shot(page, 'epub-toc-desktop');
  await page.keyboard.press('Escape');

  await page.goto('./#/');
  await page.getByRole('link', { name: 'Read Night Garden #1: Seeds' }).click();
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'End of book' })).toBeVisible();
  await shot(page, 'comic-end-desktop');
  await page.getByRole('button', { name: /Night Garden #2/ }).click();
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await page.mouse.move(300, 300);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await shot(page, 'comic-settings-desktop');

  // Other layouts: comic spread and scroll, PDF pages, EPUB scroll.
  await page.getByRole('checkbox', { name: /Two-page spreads/ }).check();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Page 2' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Page 3' })).toBeVisible();
  await shot(page, 'comic-spread-desktop');
  await page.mouse.move(310, 310);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await page.getByRole('radio', { name: 'Scroll' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'Page 4' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'comic-scroll-mobile');
  await page.setViewportSize({ width: 1280, height: 820 });

  await page.goto('./#/');
  await page.getByRole('link', { name: 'Read Field Notes on Paper' }).click();
  await expect(page.locator('canvas[aria-label="Page 1"]')).toBeVisible();
  await page.mouse.move(300, 300);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await page.getByRole('radio', { name: 'Pages' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('canvas[aria-label="Page 2"]')).toBeVisible();
  await expect(page.locator('.pdf-text-layer')).toContainText('Chapter 2');
  await shot(page, 'pdf-paged-desktop');

  await page.goto('./#/');
  await page.getByRole('link', { name: 'Read The Reading Room' }).click();
  const frame = page.frameLocator('iframe[title="Book text"]');
  await expect(frame.locator('h1')).toBeVisible();
  await page.mouse.move(300, 300);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await page.getByRole('radio', { name: 'Scroll' }).click();
  await page.getByRole('radio', { name: 'dark' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.locator('h1')).toBeVisible();
  await shot(page, 'epub-scroll-dark-mobile');
});
