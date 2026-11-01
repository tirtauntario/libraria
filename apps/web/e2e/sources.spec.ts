/**
 * Storage sources end to end, against a real WebDAV server on another
 * origin (e2e/webdav-server.ts): add the source in the UI, test the
 * connection, scan, browse folders for a library, open a book (download with
 * a dropped connection that resumes via Range), dedupe against a local
 * import, and read offline. A second server without CORS headers checks the
 * error the user sees. Screenshots of the add-source flows at phone width go
 * to test-results/screens/.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeCbz, makeEpub, makePdf } from './fixtures';
import { startWebdav, type DavServer } from './webdav-server';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const MOBILE = { width: 390, height: 844 };

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
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

async function dismissToasts(page: Page) {
  for (const t of await page.locator('.toast .close').all()) await t.click({ timeout: 1000 }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

let dav: DavServer;
let noCors: DavServer;
let cbzSize = 0;

test.beforeAll(async () => {
  const [cbz, epub] = await Promise.all([makeCbz(4), makeEpub()]);
  cbzSize = cbz.length;
  const files = {
    'Comics/Night Garden v01.cbz': cbz,
    'Books/reading-room-copy.epub': epub,
    'Café & Co/field notes.pdf': makePdf(2),
  };
  dav = await startWebdav({ files, user: 'reader', password: 'pässwörd' });
  noCors = await startWebdav({ files, cors: false });
});

test.afterAll(async () => {
  await dav?.close();
  await noCors?.close();
});

test('WebDAV: add, scan, browse, open with resume, dedupe, read offline', async ({ page, context }) => {
  const errors = watchErrors(page);
  await page.setViewportSize(MOBILE);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

  // The same EPUB is also imported on the device, under another name.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add books' }).first().click();
  await (await chooser).setFiles([{ name: 'reading-room.epub', mimeType: 'application/epub+zip', buffer: await makeEpub() }]);
  await expect(page.getByText(/Added 1 book/)).toBeVisible({ timeout: 60_000 });
  await dismissToasts(page);

  // --- add the source -------------------------------------------------------------
  await page.goto('./#/libraries');
  await page.getByRole('button', { name: 'Add source' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: /WebDAV/ })).toBeEnabled();
  await shot(page, 'sources-add-list-mobile');

  await dialog.getByRole('button', { name: /WebDAV/ }).click();
  await dialog.getByLabel('Server address').fill(dav.url);
  await dialog.getByLabel('Username').fill('reader');
  await dialog.getByLabel('Password').fill('wrong');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByRole('alert')).toContainText('rejected the username or password');
  await expect(dialog.getByRole('alert')).not.toContainText('wrong');

  await dialog.getByLabel('Password').fill('pässwörd');
  await dialog.getByLabel('Name (optional)').fill('Home NAS');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByRole('status')).toContainText('Connected');
  await shot(page, 'sources-webdav-mobile');
  await dialog.getByRole('button', { name: 'Add source' }).click();

  // Scanned into its own library.
  const row = page.getByRole('listitem', { name: 'Home NAS' });
  await expect(row).toContainText('3 files', { timeout: 30_000 });
  await expect(row).toContainText('WebDAV');
  await dismissToasts(page);
  await shot(page, 'sources-libraries-mobile');

  // --- a library made of a folder, picked by browsing --------------------------------
  await page.getByRole('button', { name: 'New library' }).click();
  const editor = page.getByRole('dialog', { name: 'New library' });
  await editor.getByLabel('Name').fill('Comics only');
  await editor.locator('.src-row', { hasText: 'Home NAS' }).getByRole('checkbox').check();
  await editor.getByRole('button', { name: 'Browse…' }).click();
  const picker = page.getByRole('dialog', { name: /Choose a folder/ });
  await expect(picker.getByRole('button', { name: 'Café & Co' })).toBeVisible();
  await shot(page, 'sources-folder-picker-mobile');
  await picker.getByRole('button', { name: 'Comics' }).click();
  await expect(picker).toContainText('1 file in this folder');
  await picker.getByRole('button', { name: 'Use this folder' }).click();
  await expect(editor.getByLabel('Folder (optional)')).toHaveValue('Comics');
  await editor.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('link', { name: /Comics only/ }).click();
  await expect(page.getByText('1 book', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Night Garden v01', exact: true })).toBeVisible();

  // --- the source's own library -------------------------------------------------------
  await page.goto('./#/libraries');
  await page.getByRole('link', { name: /^Home NAS/ }).click();
  await expect(page.getByRole('heading', { name: 'Home NAS' })).toBeVisible();
  await expect(page.getByText('3 books', { exact: true })).toBeVisible();
  for (const t of ['Night Garden v01', 'reading-room-copy', 'field notes']) {
    await expect(page.getByRole('link', { name: t, exact: true })).toBeVisible();
  }
  await shot(page, 'sources-library-mobile');

  // --- open a remote comic: the download drops half way and resumes with Range --------
  const half = Math.floor(cbzSize / 2);
  dav.dropNextGetAfter(half);
  await page.getByRole('link', { name: 'Read Night Garden v01' }).click();
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible({ timeout: 30_000 });
  const gets = dav.requests.filter((r) => r.method === 'GET' && r.path.endsWith('Night Garden v01.cbz'));
  expect(gets.map((r) => r.range ?? null)).toEqual([null, `bytes=${half}-`]);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Page 2' })).toBeVisible();
  await page.waitForTimeout(800); // progress save is debounced

  // --- the remote EPUB is the same file as the imported one: one book ----------------
  await page.goto('./#/libraries');
  await page.getByRole('button', { name: 'Edit On this device' }).click();
  const onDevice = page.getByRole('dialog', { name: 'Edit library' });
  await onDevice.locator('.src-row', { hasText: 'Home NAS' }).getByRole('checkbox').check();
  await onDevice.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('link', { name: /^On this device/ }).click();
  await expect(page.getByText('4 books', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Read reading-room-copy' }).click();
  await expect(page.frameLocator('iframe[title="Book text"]').locator('h1')).toHaveText('The Quiet Hour', { timeout: 30_000 });
  await page.goto('./#/libraries');
  await page.getByRole('link', { name: /^On this device/ }).click();
  await expect(page.getByText('3 books', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'The Reading Room', exact: true })).toHaveCount(1);

  // --- offline: the downloaded comic still opens ---------------------------------------
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  });
  await context.setOffline(true);
  await page.reload();
  await page.goto('./#/libraries');
  await page.getByRole('link', { name: /^Home NAS/ }).click();
  await page.getByRole('link', { name: 'Read Night Garden #1: Seeds' }).click();
  await expect(page.getByRole('img', { name: 'Page 2' })).toBeVisible();
  // A remote book that was never downloaded says why it cannot open.
  await page.goto('./#/libraries');
  await page.getByRole('link', { name: /^Home NAS/ }).click();
  await page.getByRole('link', { name: 'Read field notes' }).click();
  await expect(page.getByRole('alert')).toContainText('offline');
  await context.setOffline(false);

  expect(errors.filter((e) => !/Failed to load resource|Blocked script execution|net::ERR/.test(e))).toEqual([]);
});

test('WebDAV without CORS: a clear error with server help', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('./#/libraries');
  await page.getByRole('button', { name: 'Add source' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /WebDAV/ }).click();
  await dialog.getByLabel('Server address').fill(noCors.url);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('does not allow requests from this app (CORS)');
  const help = dialog.locator('details.help');
  await expect(help).toHaveAttribute('open', '');
  await expect(help).toContainText('Access-Control-Allow-Origin');
  await expect(help).toContainText('Nextcloud');
  await shot(page, 'sources-webdav-cors-mobile');
  // Adding is refused while the connection fails.
  await dialog.getByRole('button', { name: 'Add source' }).click();
  await expect(alert).toBeVisible();
  await expect(page.getByRole('listitem', { name: /127\.0\.0\.1/ })).toHaveCount(0);
});

test('add-source screens for folder, Google Drive and Dropbox', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('./#/libraries');
  await page.getByRole('button', { name: 'Add source' }).click();
  const dialog = page.getByRole('dialog');

  // Chromium has the File System Access API.
  await dialog.getByRole('button', { name: /Folder on this device/ }).click();
  await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
  await shot(page, 'sources-folder-mobile');
  await dialog.getByRole('button', { name: 'Back' }).click();

  await dialog.getByRole('button', { name: /Google Drive/ }).click();
  await expect(dialog.getByRole('button', { name: 'Sign in to Google Drive' })).toBeDisabled();
  await expect(dialog).toContainText('Redirect URI');
  await expect(dialog.getByLabel('redirect URI', { exact: true })).toHaveValue(/^http:\/\/localhost:\d+\/$/);
  await shot(page, 'sources-gdrive-mobile');
  await dialog.getByLabel('Google OAuth client ID').fill('123-abc.apps.googleusercontent.com');
  await dialog.getByLabel('Google OAuth client ID').blur();
  await expect(dialog.getByRole('button', { name: 'Sign in to Google Drive' })).toBeEnabled();

  // Signing in leaves for Google with state and the read-only scope.
  const leaving = page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/'));
  await page.route((url) => url.hostname === 'accounts.google.com', (route) => route.fulfill({ status: 200, body: 'google' }));
  await dialog.getByRole('button', { name: 'Sign in to Google Drive' }).click();
  const auth = new URL((await leaving).url());
  await page.waitForURL((u) => u.hostname === 'accounts.google.com');
  expect(auth.searchParams.get('response_type')).toBe('token');
  expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly');
  const state = auth.searchParams.get('state')!;
  expect(state.length).toBeGreaterThan(20);

  // Coming back: the token in the fragment is captured before the router, the
  // URL is cleaned and the form continues at the folder step.
  await page.route((url) => url.href.startsWith('https://www.googleapis.com/drive/v3/files'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ files: [{ id: 'F1', name: 'Comics', mimeType: 'application/vnd.google-apps.folder' }] }),
    }),
  );
  await page.goto(`./#access_token=ya29.test&token_type=Bearer&expires_in=3599&state=${state}`);
  await expect(page).toHaveURL(/#\/libraries$/);
  const back = page.getByRole('dialog');
  await expect(back.getByText('Signed in. Choose the folder')).toBeVisible();
  await expect(back.getByRole('button', { name: 'Comics' })).toBeVisible();
  await shot(page, 'sources-gdrive-folders-mobile');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Add source' }).click();
  await dialog.getByRole('button', { name: /Dropbox/ }).click();
  await expect(dialog.getByRole('button', { name: 'Sign in to Dropbox' })).toBeDisabled();
  await shot(page, 'sources-dropbox-mobile');
  await page.keyboard.press('Escape');

  await page.goto('./#/settings');
  const cloud = page.locator('section', { has: page.getByRole('heading', { name: 'Cloud storage' }) });
  await expect(cloud.getByLabel('Google OAuth client ID')).toHaveValue('123-abc.apps.googleusercontent.com');
  await cloud.scrollIntoViewIfNeeded();
  await shot(page, 'sources-settings-cloud-mobile');
});
