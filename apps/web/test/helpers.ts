import { extractBook } from '@libraria/core';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { openLibrariaDb } from '../src/lib/db/schema';
import { hashInThread } from '../src/lib/library/hash';
import { makeServices, type Services } from '../src/lib/services';
import { IdbFileStore } from '../src/lib/storage/opfs';

let n = 0;

/** Fresh services on a fresh fake-indexeddb database, IDB file store, no covers. */
export async function testServices(now?: () => number): Promise<Services> {
  const db = await openLibrariaDb(`test-${Date.now()}-${n++}`);
  const s = makeServices(db, new IdbFileStore(db), {
    hash: hashInThread,
    analyze: async (blob, name) => ({ ...(await extractBook(blob, name)), cover: null }),
    now,
  });
  await s.repo.init();
  return s;
}

export const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export async function cbzFile(name: string, pages = 3, seed = ''): Promise<File> {
  const zip = new ZipWriter(new BlobWriter('application/zip'));
  for (let i = 1; i <= pages; i++) await zip.add(`p${i}.png`, new Uint8ArrayReader(PNG));
  // Different seeds make different files (different SHA-512).
  await zip.add('seed.txt', new TextReader(seed || name));
  const blob = await zip.close();
  return new File([blob], name, { type: 'application/zip', lastModified: 1_700_000_000_000 });
}

export async function epubFile(name: string, title = 'The Test Book'): Promise<File> {
  const zip = new ZipWriter(new BlobWriter('application/epub+zip'), { extendedTimestamp: false });
  await zip.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await zip.add(
    'META-INF/container.xml',
    new TextReader(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  await zip.add(
    'content.opf',
    new TextReader(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:1</dc:identifier><dc:title>${title}</dc:title><dc:creator>Ada Lovelace</dc:creator>
  </metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`),
  );
  await zip.add('c1.xhtml', new TextReader('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello</p></body></html>'));
  return new File([await zip.close()], name, { type: 'application/epub+zip' });
}
