/**
 * Android share target, end to end against the production build: the
 * service worker receives the multipart POST the share sheet sends, parks
 * the file and redirects to the app, which imports it on start.
 */
import { expect, test } from '@playwright/test';
import { makeEpub } from './fixtures';

test('a book shared to the app is imported', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  // The share target only exists once the service worker controls the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  });

  const epub = [...(await makeEpub())];
  const landed = await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('books', new File([new Uint8Array(bytes)], 'shared room.epub', { type: 'application/epub+zip' }));
    // What Android's share sheet does: POST to the manifest's share_target action.
    const res = await fetch('./share-target', { method: 'POST', body: form });
    // The worker redirects to the app, which it then serves from the precache.
    const parked = await (await caches.open('libraria-share')).keys();
    return { status: res.status, app: (await res.text()).includes('<title>Libraria</title>'), parked: parked.length };
  }, epub);
  expect(landed).toEqual({ status: 200, app: true, parked: 1 });

  await page.reload();
  await expect(page.getByRole('link', { name: 'Read The Reading Room' })).toBeVisible();
  // The share is consumed: another start imports nothing.
  expect(await page.evaluate(async () => (await (await caches.open('libraria-share')).keys()).length)).toBe(0);
});
