/**
 * Registered Libraria servers.
 *
 * A server the user joined is a `libraria` Source (core LibrariaConfig:
 * serverId, url, username, token, role). Like other sources it syncs
 * (end-to-end encrypted) to the user's other devices. Per-device state that
 * should not sync (cached /info, session expired flag, refresh times) lives
 * in `repo.getValue('server:state:<sourceId>')`. Accounts waiting for
 * approval are kept in `server:pending` until the user signs in.
 *
 * The client only talks to servers in this list (or the one the user is
 * adding right now).
 */
import {
  DEFAULT_KDF,
  randomSalt,
  type AuthResponse,
  type KdfParams,
  type LibrariaConfig,
  type Role,
  type ServerInfo,
  type Source,
  type UserDto,
} from '@libraria/core';
import type { Repo } from '../db/repo';
import { isOnline } from '../net.svelte';
import { ServerApi, ServerError, type FetchLike } from './api';
import { deriveKeys } from './kdf';

export type LibrariaSource = Source & { config: { kind: 'libraria' } & LibrariaConfig };

export interface ServerState {
  info: ServerInfo | null;
  infoAt: number;
  user: UserDto | null;
  /** The token was rejected; the user must sign in again. */
  sessionExpired: boolean;
  lastRefreshAt: number;
  lastRefreshError: string | null;
}

export interface PendingAccount {
  url: string;
  serverId: string;
  serverName: string;
  username: string;
  inviteToken?: string | null;
  createdAt: number;
}

const STATE_PREFIX = 'server:state:';
const PENDING_KEY = 'server:pending';

export const EMPTY_STATE: ServerState = {
  info: null,
  infoAt: 0,
  user: null,
  sessionExpired: false,
  lastRefreshAt: 0,
  lastRefreshError: null,
};

// --- change notifications (per-device state does not go through repo events) --

type Listener = () => void;
const listeners = new Set<Listener>();

export function onServersChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyServersChanged(): void {
  for (const l of listeners) l();
}

// --- fetch injection (tests) ---------------------------------------------------

let fetchImpl: FetchLike | undefined;
let onlineCheck: () => boolean = isOnline;

export function setServerFetch(f: FetchLike | undefined, online?: () => boolean): void {
  fetchImpl = f;
  if (online) onlineCheck = online;
}

export function isLibrariaSource(s: Source | undefined | null): s is LibrariaSource {
  return !!s && s.config.kind === 'libraria';
}

export async function listServers(repo: Repo): Promise<LibrariaSource[]> {
  return (await repo.listSources()).filter(isLibrariaSource);
}

export async function getServer(repo: Repo, sourceId: string): Promise<LibrariaSource | undefined> {
  const s = await repo.getSource(sourceId);
  return isLibrariaSource(s) && !s.deleted ? s : undefined;
}

export async function getServerState(repo: Repo, sourceId: string): Promise<ServerState> {
  return { ...EMPTY_STATE, ...((await repo.getValue<ServerState>(STATE_PREFIX + sourceId)) ?? {}) };
}

export async function patchServerState(repo: Repo, sourceId: string, patch: Partial<ServerState>): Promise<ServerState> {
  const next = { ...(await getServerState(repo, sourceId)), ...patch };
  await repo.setValue(STATE_PREFIX + sourceId, next);
  notifyServersChanged();
  return next;
}

export async function listPending(repo: Repo): Promise<PendingAccount[]> {
  return (await repo.getValue<PendingAccount[]>(PENDING_KEY)) ?? [];
}

async function savePending(repo: Repo, items: PendingAccount[]): Promise<void> {
  await repo.setValue(PENDING_KEY, items);
  notifyServersChanged();
}

export async function addPending(repo: Repo, p: PendingAccount): Promise<void> {
  const rest = (await listPending(repo)).filter((x) => !(x.serverId === p.serverId && x.username === p.username));
  await savePending(repo, [...rest, p]);
}

export async function removePending(repo: Repo, serverId: string, username: string): Promise<void> {
  await savePending(
    repo,
    (await listPending(repo)).filter((x) => !(x.serverId === serverId && x.username === username)),
  );
}

/** An API client for a URL the user is adding (no token). */
export function anonymousApi(url: string): ServerApi {
  return new ServerApi({ baseUrl: url, fetch: fetchImpl, isOnline: () => onlineCheck() });
}

/** API client for a registered server. A 401 marks the session expired. */
export function apiFor(source: LibrariaSource, repo: Repo): ServerApi {
  const api = new ServerApi({
    baseUrl: source.config.url,
    token: source.config.token,
    fetch: fetchImpl,
    isOnline: () => onlineCheck(),
    onUnauthorized: async () => {
      await patchServerState(repo, source.id, { sessionExpired: true });
    },
  });
  return api;
}

// --- auth flows ------------------------------------------------------------------

export interface AuthResult {
  info: ServerInfo;
  auth: AuthResponse;
  /** Argon2id(password); used right away for sync keys, then dropped. */
  masterKey: Uint8Array;
}

/** Thrown when an account exists but waits for approval. */
export class PendingApprovalError extends Error {
  constructor(readonly user: UserDto | null) {
    super('Your account is waiting for approval by the library owner or a curator.');
    this.name = 'PendingApprovalError';
  }
}

export async function signIn(url: string, username: string, password: string, deviceName?: string): Promise<AuthResult> {
  const api = anonymousApi(url);
  const info = await api.info();
  const pre = await api.prelogin(username);
  const { masterKey, authHash } = await deriveKeys(password, pre.salt, pre.kdf);
  try {
    const auth = await api.login({ username, authHash, deviceName: deviceName || undefined });
    return { info, auth, masterKey };
  } catch (err) {
    if (err instanceof ServerError && err.code === 'pending_approval') throw new PendingApprovalError(null);
    throw err;
  }
}

export async function signUp(
  url: string,
  username: string,
  password: string,
  opts: { inviteToken?: string | null; deviceName?: string; kdf?: KdfParams } = {},
): Promise<AuthResult> {
  const api = anonymousApi(url);
  const info = await api.info();
  const salt = randomSalt();
  const kdf = opts.kdf ?? DEFAULT_KDF;
  const { masterKey, authHash } = await deriveKeys(password, salt, kdf);
  const auth = await api.register({
    username,
    salt,
    kdf,
    authHash,
    inviteToken: opts.inviteToken || undefined,
    deviceName: opts.deviceName || undefined,
  });
  return { info, auth, masterKey };
}

/** First-run setup: creates the owner account and names the library. */
export async function setupOwner(
  url: string,
  setupToken: string,
  username: string,
  password: string,
  libraryName: string,
  opts: { deviceName?: string; kdf?: KdfParams } = {},
): Promise<AuthResult> {
  const api = anonymousApi(url);
  const salt = randomSalt();
  const kdf = opts.kdf ?? DEFAULT_KDF;
  const { masterKey, authHash } = await deriveKeys(password, salt, kdf);
  const auth = await api.setup({
    setupToken: setupToken.trim(),
    username,
    salt,
    kdf,
    authHash,
    libraryName,
    deviceName: opts.deviceName || undefined,
  });
  const info = await api.info();
  return { info, auth, masterKey };
}

/**
 * Add (or update) the server as a `libraria` source after signing in, and
 * make sure a library named after it shows its books. Returns the source.
 * A guest (anonymous browsing) has no auth.
 */
export async function attachServer(repo: Repo, url: string, info: ServerInfo, auth: AuthResponse | null): Promise<LibrariaSource> {
  const config: LibrariaSource['config'] = {
    kind: 'libraria',
    serverId: info.id,
    url,
    username: auth?.user.username ?? '',
    token: auth?.token ?? '',
    role: (auth?.user.role ?? 'member') as Role,
  };
  // The server's own id (a UUIDv7) is the id of its source and of its
  // library, so every device that joins the server creates the same records
  // and sync merges them instead of duplicating the server.
  const existing = (await repo.getSource(info.id)) ?? (await listServers(repo)).find((s) => s.config.serverId === info.id);
  let source: LibrariaSource;
  if (existing) {
    source = (await repo.updateSource(existing.id, { name: info.name, config, deleted: false })) as LibrariaSource;
  } else {
    source = (await repo.createSource(info.name, config, info.id)) as LibrariaSource;
  }
  const lib = await repo.getLibrary(source.id);
  const ref = { sourceId: source.id, path: '' };
  if (!lib) {
    const libs = await repo.listLibraries();
    if (!libs.some((l) => l.sources.some((r) => r.sourceId === source.id))) await repo.createLibrary(info.name, [ref], source.id);
  } else if (lib.deleted) {
    await repo.updateLibrary(lib.id, { deleted: false, name: info.name, sources: [ref] });
  }
  await patchServerState(repo, source.id, {
    info,
    infoAt: Date.now(),
    user: auth?.user ?? null,
    sessionExpired: false,
  });
  if (auth) await removePending(repo, info.id, auth.user.username);
  return source;
}

/** Re-read /info and /me; updates the stored role and name. */
export async function refreshAccount(repo: Repo, source: LibrariaSource): Promise<ServerState> {
  const api = apiFor(source, repo);
  const info = await api.info();
  let user: UserDto | null = null;
  if (!api.anonymous) user = await api.me();
  const patch: Partial<Pick<Source, 'name' | 'config'>> = {};
  if (info.name !== source.name) patch.name = info.name;
  if (user && user.role !== source.config.role) patch.config = { ...source.config, role: user.role };
  if (patch.name || patch.config) await repo.updateSource(source.id, patch);
  return patchServerState(repo, source.id, { info, infoAt: Date.now(), ...(user ? { user, sessionExpired: false } : {}) });
}

/** The role the user has on a server, or null for a guest. */
export function roleOf(source: LibrariaSource): Role | null {
  return source.config.token ? source.config.role : null;
}
