/**
 * End-to-end: the built web app served by a real Libraria server (built
 * from apps/server, temp data dir). Covers first-run setup, an owner upload,
 * a member who waits for approval, downloads and reads offline, submits a
 * book that the owner reviews, and encrypted sync of reading progress
 * between two browser contexts of the same user. Screenshots go to
 * test-results/screens/server-*.png.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { makeCbz } from './fixtures';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

const PORT = 4318;
const URL = `http://127.0.0.1:${PORT}`;
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 860 };
const OWNER_PW = 'owner password 123';
const MEMBER_PW = 'member password 456';

const WEB_DIR = resolve('dist');
const SERVER_DIR = resolve('../server');

let server: ChildProcess | null = null;
let dataDir = '';
let setupToken = '';

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/server-${name}.png`, fullPage: false });
}

/** Desktop and mobile screenshots of the current page. */
async function shots(page: Page, name: string) {
  const size = page.viewportSize();
  await page.setViewportSize(DESKTOP);
  await shot(page, `${name}-desktop`);
  await page.setViewportSize(MOBILE);
  await shot(page, `${name}-mobile`);
  if (size) await page.setViewportSize(size);
}

function watchErrors(page: Page, into: string[]) {
  page.on('pageerror', (e) => into.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') into.push(`console: ${m.text()}`);
  });
}

test.beforeAll(async () => {
  if (!existsSync(join(WEB_DIR, 'index.html'))) execFileSync('pnpm', ['build'], { stdio: 'inherit' });
  execFileSync('pnpm', ['--filter', '@libraria/server', 'build'], { stdio: 'inherit', cwd: resolve('../..') });
  dataDir = mkdtempSync(join(tmpdir(), 'libraria-e2e-'));
  server = spawn(process.execPath, [join(SERVER_DIR, 'dist/index.js')], {
    env: {
      ...process.env,
      LIBRARIA_DATA_DIR: dataDir,
      LIBRARIA_PORT: String(PORT),
      LIBRARIA_HOST: '127.0.0.1',
      LIBRARIA_WEB_DIR: WEB_DIR,
      LIBRARIA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  setupToken = await new Promise<string>((resolveToken, reject) => {
    const timer = setTimeout(() => reject(new Error(`No setup token in server output:\n${out}`)), 30_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const m = /one-time setup token:\s+([A-Za-z0-9_-]{16,})/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveToken(m[1]!);
      }
    };
    server!.stdout!.on('data', onData);
    server!.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    server!.on('exit', (code) => reject(new Error(`Server exited (${code}):\n${out}`)));
  });
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function newContext(browser: Browser, viewport = DESKTOP): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport, baseURL: `${URL}/` });
  const page = await context.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);
  await page.goto(`${URL}/`);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  return { context, page, errors };
}

async function importBook(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add books' }).filter({ visible: true }).first().click();
  await (await chooser).setFiles([{ name, mimeType: 'application/vnd.comicbook+zip', buffer }]);
  await expect(page.getByText(/Added 1 book/)).toBeVisible({ timeout: 60_000 });
}

async function openBookPage(page: Page, title: string) {
  await page.goto(`${URL}/#/`);
  const recent = page.locator('section', { has: page.getByRole('heading', { name: 'Recently added' }) });
  await recent.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
}

async function serverTab(page: Page, serverId: string, tab: string) {
  await page.goto(`${URL}/#/server/${serverId}?tab=${tab}`);
}

/** Sign in (or register) through the join page. */
async function fillAuth(page: Page, username: string, password: string, opts: { register?: boolean; sync: boolean }) {
  if (!opts.register) await page.getByRole('radio', { name: 'Sign in' }).click();
  await page.getByLabel('User name').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  if (opts.register) await page.getByLabel('Repeat password').fill(password);
  const syncBox = page.getByLabel(/Sync my reading/);
  if (await syncBox.count()) await syncBox.setChecked(opts.sync);
}

test('server: setup, uploads, approval, offline download, review, sync', async ({ browser }) => {
  test.setTimeout(300_000);
  const [ownerBook, memberBook] = await Promise.all([makeCbz(6, 1, 'Seeds'), makeCbz(4, 2, 'Roots')]);

  // --- owner: first-run setup from the client ----------------------------------
  const owner = await newContext(browser);
  const op = owner.page;
  await op.getByRole('link', { name: 'Servers' }).first().click();
  await expect(op.getByRole('heading', { name: 'Servers', exact: true })).toBeVisible();
  await shots(op, 'servers-empty');
  await op.getByRole('link', { name: 'Add server' }).click();
  await op.getByLabel('Server address').fill(URL);
  await shots(op, 'join-address');
  await op.getByRole('button', { name: 'Continue' }).click();
  await expect(op.getByRole('heading', { name: 'Set up your server' })).toBeVisible();
  await op.getByLabel('Setup token').fill(setupToken);
  await op.getByLabel('Library name').fill('Night Owls');
  await fillAuth(op, 'owner', OWNER_PW, { register: true, sync: true });
  await shots(op, 'join-setup');
  await op.getByRole('button', { name: 'Create owner account' }).click();

  // Sync is set up with the owner's password: the recovery key is shown once.
  const recovery = op.getByTestId('recovery-key');
  await expect(recovery).toBeVisible({ timeout: 60_000 });
  await expect(recovery.getByLabel('Recovery key', { exact: true })).toHaveText(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4}){12}$/);
  await shots(op, 'sync-recovery-key');
  await expect(recovery.getByRole('button', { name: 'Done' })).toBeDisabled();
  await recovery.getByLabel(/I saved my recovery key/).check();
  await recovery.getByRole('button', { name: 'Done' }).click();
  await expect(op.getByRole('heading', { name: 'Night Owls', level: 1 })).toBeVisible();
  const serverId = /#\/server\/([^?]+)/.exec(op.url())![1]!;

  // --- owner uploads a local book: approved at once --------------------------------
  await importBook(op, 'Night Garden v01.cbz', ownerBook);
  await openBookPage(op, 'Night Garden #1: Seeds');
  await op.getByRole('button', { name: 'Send to server…' }).click();
  await expect(op.getByRole('dialog')).toContainText('Added right away');
  await shots(op, 'send-dialog');
  await op.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(op.getByText('In Night Owls')).toBeVisible({ timeout: 30_000 });
  await shots(op, 'book-panel-owner');

  await serverTab(op, serverId, 'books');
  await expect(op.getByRole('link', { name: 'Night Garden #1: Seeds', exact: true })).toBeVisible();
  await shots(op, 'books');

  // Admin pages.
  await serverTab(op, serverId, 'invites');
  await op.getByRole('button', { name: 'New invite' }).click();
  await expect(op.getByTestId('invite-link')).toContainText('#/join?server=');
  await shots(op, 'invites');
  await serverTab(op, serverId, 'settings');
  await expect(op.getByLabel('Name', { exact: true })).toHaveValue('Night Owls');
  await shots(op, 'settings');
  await serverTab(op, serverId, 'sources');
  await expect(op.getByText(/No roots are configured/)).toBeVisible();
  await shots(op, 'sources');

  // --- member: signs up to the private library and waits ---------------------------
  const member = await newContext(browser, MOBILE);
  const mp = member.page;
  await mp.goto(`${URL}/#/join?server=${encodeURIComponent(URL)}`);
  await expect(mp.getByTestId('server-info')).toContainText('Private library');
  await expect(mp.getByTestId('server-info')).toContainText('Signups need approval');
  await fillAuth(mp, 'mia', MEMBER_PW, { register: true, sync: false });
  await shots(mp, 'join-register');
  await mp.getByRole('button', { name: 'Create account' }).last().click();
  await expect(mp.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible({ timeout: 60_000 });
  await shots(mp, 'join-pending');

  // --- owner approves the signup -----------------------------------------------------
  await serverTab(op, serverId, 'members');
  const pendingUser = op.getByTestId('pending-user');
  await expect(pendingUser).toContainText('mia');
  await shots(op, 'members');
  await pendingUser.getByRole('button', { name: 'Approve' }).click();
  await expect(op.getByTestId('pending-user')).toHaveCount(0);

  // --- member signs in, downloads the book, reads it offline --------------------------
  await mp.goto(`${URL}/#/servers`);
  await expect(mp.getByText('waiting for approval')).toBeVisible();
  await mp.getByRole('link', { name: 'Sign in' }).click();
  await expect(mp.getByLabel('User name')).toHaveValue('mia');
  await mp.getByLabel('Password', { exact: true }).fill(MEMBER_PW);
  await mp.getByLabel(/Sync my reading/).uncheck();
  await mp.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(mp.getByRole('heading', { name: 'Night Owls', level: 1 })).toBeVisible({ timeout: 60_000 });
  const card = mp.getByRole('link', { name: 'Night Garden #1: Seeds', exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await shots(mp, 'books-member');
  await card.click();
  await mp.getByRole('button', { name: 'Keep offline' }).click();
  await expect(mp.getByText('Saved for offline reading')).toBeVisible({ timeout: 30_000 });

  await mp.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  });
  await member.context.setOffline(true);
  await mp.reload();
  await expect(mp.getByText(/You're offline/)).toBeVisible();
  await mp.getByRole('link', { name: /Start reading|Continue reading/ }).click();
  await expect(mp.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await mp.keyboard.press('ArrowRight');
  await expect(mp.getByRole('img', { name: 'Page 2' })).toBeVisible();
  await mp.goto(`${URL}/#/server/${serverId}`);
  await expect(mp.getByText(/Offline: showing what this device remembers/)).toBeVisible();
  await shots(mp, 'server-offline');
  await member.context.setOffline(false);

  // --- member submits a book; owner reviews it -------------------------------------------
  await mp.goto(`${URL}/#/`);
  await importBook(mp, 'Night Garden v02.cbz', memberBook);
  await openBookPage(mp, 'Night Garden #2: Roots');
  await mp.getByRole('button', { name: 'Send to server…' }).click();
  await expect(mp.getByRole('dialog')).toContainText('Reviewed by the owner or a curator first');
  await mp.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(mp.getByText('Waiting for review')).toBeVisible({ timeout: 30_000 });
  await shots(mp, 'submission-pending');

  await serverTab(op, serverId, 'review');
  const sub = op.getByTestId('submission');
  await expect(sub).toContainText('Night Garden #2: Roots');
  await expect(sub).toContainText('mia');
  await shots(op, 'review');
  await sub.getByRole('link', { name: 'Open' }).click();
  await expect(op.getByRole('img', { name: 'Page 1' })).toBeVisible({ timeout: 30_000 });
  await expect(op.getByText('Review copy · not saved')).toBeVisible();
  await shot(op, 'review-reader-desktop');
  await op.goBack();
  await op.getByTestId('submission').getByRole('button', { name: 'Approve' }).click();
  await expect(op.getByText('Nothing to review.')).toBeVisible();

  await serverTab(mp, serverId, 'contribute');
  await expect(mp.getByText('Approved').first()).toBeVisible({ timeout: 30_000 });
  await shots(mp, 'contribute');

  // --- sync: owner reads on device 1, a second device sees the position ------------------
  await openBookPage(op, 'Night Garden #1: Seeds');
  await op.getByRole('link', { name: 'Start reading' }).click();
  await expect(op.getByRole('img', { name: 'Page 1' })).toBeVisible();
  for (let i = 0; i < 3; i++) await op.keyboard.press('ArrowRight');
  await expect(op.getByRole('img', { name: 'Page 4' })).toBeVisible();
  await op.waitForTimeout(900); // progress save is debounced
  await op.goto(`${URL}/#/servers`);
  await op.getByTestId('sync-status').getByRole('button', { name: 'Sync now' }).click();
  await expect(op.getByTestId('sync-status')).toContainText('Up to date', { timeout: 30_000 });
  await expect(op.getByTestId('sync-status')).not.toContainText('to send');
  await shots(op, 'servers');

  const second = await newContext(browser);
  const sp = second.page;
  await sp.goto(`${URL}/#/join?server=${encodeURIComponent(URL)}&mode=login`);
  await fillAuth(sp, 'owner', OWNER_PW, { sync: true });
  await sp.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(sp.getByText(/Sync is on/)).toBeVisible({ timeout: 60_000 });
  await shots(sp, 'sync-unlocked');
  await sp.getByRole('button', { name: 'Continue' }).click();
  await expect(sp.getByRole('link', { name: 'Night Garden #1: Seeds', exact: true })).toBeVisible({ timeout: 30_000 });
  await sp.goto(`${URL}/#/sync`);
  await expect(sp.getByTestId('sync-status')).toContainText('Up to date', { timeout: 30_000 });
  await shots(sp, 'sync-page');
  await openBookPage(sp, 'Night Garden #1: Seeds');
  await expect(sp.getByText(/60% read/)).toBeVisible({ timeout: 30_000 });
  await sp.getByRole('link', { name: 'Continue reading' }).click();
  await expect(sp.getByRole('img', { name: 'Page 4' })).toBeVisible({ timeout: 30_000 });

  // The library created on device 1 arrived once, not twice.
  await sp.goto(`${URL}/#/libraries`);
  await expect(sp.locator('main').getByRole('link', { name: /Night Owls/ })).toHaveCount(1);

  const allErrors = [...owner.errors, ...member.errors, ...second.errors].filter(
    (e) => !/Failed to load resource|Blocked script execution|ERR_INTERNET_DISCONNECTED/.test(e),
  );
  expect(allErrors).toEqual([]);
  await Promise.all([owner.context.close(), member.context.close(), second.context.close()]);
});
