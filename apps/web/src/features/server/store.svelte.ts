/** Reactive view of registered servers, pending accounts and upload jobs. */
import type { Services } from '../../lib/services';
import {
  getServerState,
  listPending,
  listServers,
  onServersChanged,
  type LibrariaSource,
  type PendingAccount,
  type ServerState,
} from '../../lib/server/servers';
import { listUploads, onUploads, type UploadJob, type UploadProgress } from '../../lib/server/uploads';

export interface ServerEntry {
  source: LibrariaSource;
  state: ServerState;
}

class ServersStore {
  list = $state.raw<ServerEntry[]>([]);
  pending = $state.raw<PendingAccount[]>([]);
  uploads = $state.raw<UploadJob[]>([]);
  progress = $state<Record<string, UploadProgress>>({});
  loaded = $state(false);

  private s: Services | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  async load(s: Services): Promise<void> {
    if (this.s) return;
    this.s = s;
    await this.reload();
    this.loaded = true;
    s.repo.events.subscribe((topics) => {
      if (topics.has('sources')) this.soon();
    });
    onServersChanged(() => this.soon());
    onUploads((e) => {
      if (e.type === 'progress') this.progress[e.progress.jobId] = e.progress;
      else void this.reloadUploads();
    });
  }

  private soon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, 30);
  }

  async reload(): Promise<void> {
    const s = this.s;
    if (!s) return;
    const sources = await listServers(s.repo);
    this.list = await Promise.all(sources.map(async (source) => ({ source, state: await getServerState(s.repo, source.id) })));
    this.pending = await listPending(s.repo);
    await this.reloadUploads();
  }

  private async reloadUploads(): Promise<void> {
    if (this.s) this.uploads = await listUploads(this.s);
  }

  get(id: string): ServerEntry | undefined {
    return this.list.find((e) => e.source.id === id);
  }

  /** Servers the user is signed in to (not guests, session not expired). */
  get signedIn(): ServerEntry[] {
    return this.list.filter((e) => !!e.source.config.token && !e.state.sessionExpired);
  }
}

export const servers = new ServersStore();
