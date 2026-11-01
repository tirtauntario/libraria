/**
 * End-to-end smoke test against the production build (vite preview):
 * import a generated CBZ, EPUB and PDF, open each reader, turn pages,
 * reload and check progress is restored, then go offline and check the app
 * still loads and opens a book. Screenshots go to test-results/screens/.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeCbz, makeEpub, makePdf } from './fixtures';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 860 };

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Bring the reader controls back (they auto-hide). */
async function showControls(page: Page) {
  await page.mouse.move(200, 200);
  await page.mouse.move(210, 210);
}

test.describe.configure({ mode: 'serial' });

test('import, read, restore progress, work offline', async ({ page, context }) => {
  const errors = watchErrors(page);
  await page.setViewportSize(DESKTOP);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await shot(page, 'empty-desktop');

  // --- import ------------------------------------------------------------------
  const [cbz, epub] = await Promise.all([makeCbz(6), makeEpub()]);
  const pdf = makePdf(4);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add books' }).first().click();
  await (await chooser).setFiles([
    { name: 'Night Garden v01.cbz', mimeType: 'application/vnd.comicbook+zip', buffer: cbz },
    { name: 'reading-room.epub', mimeType: 'application/epub+zip', buffer: epub },
    { name: 'field-notes.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  await expect(page.getByText(/Added 3 books/)).toBeVisible({ timeout: 60_000 });

  const recent = page.locator('section', { has: page.getByRole('heading', { name: 'Recently added' }) });
  await expect(recent.locator('article')).toHaveCount(3);
  // Every book got a real cover image.
  await expect(recent.locator('article img')).toHaveCount(3);
  for (const title of ['Night Garden #1: Seeds', 'The Reading Room', 'Field Notes on Paper']) {
    await expect(recent.getByRole('link', { name: title, exact: true })).toBeVisible();
  }

  // Importing the same file again is detected as a duplicate.
  const again = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add books' }).first().click();
  await (await again).setFiles([{ name: 'copy.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  await expect(page.getByText(/already in your library/)).toBeVisible();
  await expect(recent.locator('article')).toHaveCount(3);

  await shot(page, 'home-desktop');
  await page.getByRole('link', { name: /On this device/ }).first().click();
  await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible();
  await shot(page, 'library-desktop');
  await page.setViewportSize(MOBILE);
  await shot(page, 'library-mobile');
  await page.goto('./#/');
  await shot(page, 'home-mobile');
  await page.setViewportSize(DESKTOP);

  // --- comic ---------------------------------------------------------------------
  await page.goto('./#/');
  await recent.getByRole('link', { name: 'Read Night Garden #1: Seeds' }).click();
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Page 3' })).toBeVisible();
  await showControls(page);
  await expect(page.getByTitle('Go to page')).toHaveText('3 / 6');
  await shot(page, 'comic-desktop');
  await page.setViewportSize(MOBILE);
  await showControls(page);
  await shot(page, 'comic-mobile');
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(800); // progress save is debounced
  await page.reload();
  await expect(page.getByRole('img', { name: 'Page 3' })).toBeVisible();

  // Bookmark this page, then check it is listed.
  await showControls(page);
  await page.getByRole('button', { name: 'Bookmark this page' }).click();
  await expect(page.getByRole('button', { name: 'Remove bookmark here' })).toBeVisible();

  // --- PDF -----------------------------------------------------------------------
  await page.goto('./#/');
  await recent.getByRole('link', { name: 'Read Field Notes on Paper' }).click();
  await expect(page.locator('canvas[aria-label="Page 1"]')).toBeVisible();
  await expect(page.locator('.pdf-text-layer').first()).toContainText('Chapter 1');
  await page.keyboard.press('End');
  await showControls(page);
  await expect(page.getByTitle('Go to page')).toHaveText('4 / 4');
  await shot(page, 'pdf-desktop');
  await page.setViewportSize(MOBILE);
  await showControls(page);
  await shot(page, 'pdf-mobile');
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(800);
  await page.reload();
  await showControls(page);
  await expect(page.getByTitle('Go to page')).toHaveText('4 / 4');
  // Outline as table of contents.
  await page.getByRole('button', { name: 'Contents' }).click();
  await page.getByRole('button', { name: /^Chapter 2/ }).click();
  await showControls(page);
  await expect(page.getByTitle('Go to page')).toHaveText('2 / 4');

  // --- EPUB ----------------------------------------------------------------------
  await page.goto('./#/');
  await recent.getByRole('link', { name: 'Read The Reading Room' }).click();
  const frame = page.frameLocator('iframe[title="Book text"]');
  await expect(frame.locator('h1')).toHaveText('The Quiet Hour');
  const iframe = page.locator('iframe[title="Book text"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
  // Nothing from the book ran.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
  await expect(frame.locator('script')).toHaveCount(0);

  await showControls(page);
  const pos = page.locator('.pos');
  await expect(pos).toContainText('1 /');
  await page.keyboard.press('ArrowRight');
  await expect(pos).toContainText('2 /');
  // Tapping the right third of the page turns it too (events inside the sandboxed frame).
  // Wait for the page-turn animation to end: mid-slide the frame is moved aside.
  await expect(page.locator('iframe[title="Page turn"]')).toBeHidden();
  const box = (await iframe.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await showControls(page);
  await expect(pos).toContainText('3 /');
  await shot(page, 'epub-desktop');
  await page.waitForTimeout(800);
  await page.reload();
  await showControls(page);
  await expect(page.locator('.pos')).toContainText('3 /');

  // Internal link goes to chapter 3; the TOC jumps back to chapter 2.
  await page.getByRole('button', { name: 'Contents' }).click();
  await page.getByRole('button', { name: 'Lamps' }).click();
  await expect(frame.locator('h1')).toHaveText('Lamps');

  // Reader settings: sepia + larger text re-paginates and keeps the chapter.
  await showControls(page);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await page.getByRole('radio', { name: /sepia/i }).click();
  await page.getByRole('button', { name: 'Larger text' }).click();
  await page.keyboard.press('Escape');
  await expect(frame.locator('h1')).toHaveText('Lamps');
  await page.setViewportSize(MOBILE);
  await showControls(page);
  await shot(page, 'epub-mobile');
  await page.setViewportSize(DESKTOP);

  // --- offline -------------------------------------------------------------------
  await page.goto('./#/');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
    return reg.active?.state;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible();
  await expect(page.getByText(/You're offline/)).toBeVisible();
  await recent.getByRole('link', { name: 'Read Night Garden #1: Seeds' }).click();
  await expect(page.getByRole('img', { name: 'Page 3' })).toBeVisible();
  await page.goto('./#/');
  await recent.getByRole('link', { name: 'Read The Reading Room' }).click();
  await expect(frame.locator('h1')).toHaveText('Lamps');
  await context.setOffline(false);

  // "Blocked script execution" is the sandbox doing its job (logged once per frame document).
  expect(errors.filter((e) => !/Failed to load resource|Blocked script execution/.test(e))).toEqual([]);
});
