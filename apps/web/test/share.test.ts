import { describe, expect, it } from 'vitest';
import { SHARE_CACHE, takeSharedFiles } from '../src/lib/stores/importer.svelte';

/** In-memory CacheStorage with just what takeSharedFiles uses. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const cache = (name: string) => {
    let entries = stores.get(name);
    if (!entries) stores.set(name, (entries = new Map()));
    const map = entries;
    return {
      keys: async () => [...map.keys()].map((url) => new Request(url)),
      match: async (req: Request) => map.get(req.url)?.clone(),
      delete: async (req: Request) => map.delete(req.url),
      put: async (url: string, res: Response) => void map.set(url, res),
    };
  };
  const storage = {
    has: async (name: string) => stores.has(name),
    open: async (name: string) => cache(name),
  };
  return { storage: storage as unknown as CacheStorage, stores, cache };
}

describe('shared files (Android share target)', () => {
  it('returns nothing when no share is waiting', async () => {
    const { storage } = fakeCaches();
    expect(await takeSharedFiles(storage)).toEqual([]);
    expect(await takeSharedFiles(undefined)).toEqual([]);
  });

  it('turns parked responses back into named files and empties the cache', async () => {
    const { storage, stores, cache } = fakeCaches();
    const parked = cache(SHARE_CACHE);
    await parked.put('https://example.test/shared/1-0', new Response('epub bytes', {
      headers: { 'content-type': 'application/epub+zip', 'x-libraria-name': encodeURIComponent('Ünïcode book.epub') },
    }));
    await parked.put('https://example.test/shared/1-1', new Response('comic', { headers: { 'content-type': 'application/octet-stream' } }));

    const files = await takeSharedFiles(storage);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['Ünïcode book.epub', 'application/epub+zip', 10],
      ['Shared book', 'application/octet-stream', 5],
    ]);
    expect(await files[0]!.text()).toBe('epub bytes');
    expect(stores.get(SHARE_CACHE)?.size).toBe(0);
  });
});
