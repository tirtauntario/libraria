/// <reference lib="webworker" />
/**
 * Writes one OPFS file with a sync access handle, for browsers without
 * FileSystemFileHandle.createWritable (Safari before 26).
 */
interface SyncHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, opts?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

let handle: SyncHandle | null = null;
let offset = 0;

self.onmessage = async (e: MessageEvent<{ op: 'open'; path: string[] } | { op: 'write'; chunk: ArrayBuffer } | { op: 'close' }>) => {
  const msg = e.data;
  try {
    if (msg.op === 'open') {
      let dir = await navigator.storage.getDirectory();
      for (const part of msg.path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle(msg.path[msg.path.length - 1]!, { create: true });
      handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
    } else if (msg.op === 'write') {
      offset += handle!.write(new Uint8Array(msg.chunk), { at: offset });
    } else {
      handle?.flush();
      handle?.close();
      handle = null;
    }
    self.postMessage({ ok: true });
  } catch (err) {
    handle?.close();
    handle = null;
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
