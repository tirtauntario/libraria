import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';

// 1x1 PNG
export const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export async function makeCbz(pages = 3, comicInfo?: string): Promise<Blob> {
  const zip = new ZipWriter(new BlobWriter('application/zip'));
  for (let i = pages; i >= 1; i--) await zip.add(`page${i}.png`, new Uint8ArrayReader(PNG));
  await zip.add('__MACOSX/._page1.png', new Uint8ArrayReader(PNG));
  if (comicInfo) await zip.add('ComicInfo.xml', new TextReader(comicInfo));
  return zip.close();
}

export async function makeEpub(): Promise<Blob> {
  const zip = new ZipWriter(new BlobWriter('application/epub+zip'), { extendedTimestamp: false });
  await zip.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await zip.add(
    'META-INF/container.xml',
    new TextReader(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  await zip.add(
    'OEBPS/content.opf',
    new TextReader(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:1</dc:identifier>
    <dc:title>The Test Book</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:creator>Charles Babbage</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>&lt;p&gt;A &lt;b&gt;short&lt;/b&gt; book.&lt;/p&gt;</dc:description>
    <meta property="belongs-to-collection" id="c1">Engines</meta>
    <meta property="group-position">2</meta>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`),
  );
  await zip.add('OEBPS/images/cover.png', new Uint8ArrayReader(PNG));
  await zip.add('OEBPS/nav.xhtml', new TextReader('<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="text/ch1.xhtml">One</a></li></ol></nav></body></html>'));
  await zip.add('OEBPS/text/ch1.xhtml', new TextReader('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello</p></body></html>'));
  return zip.close();
}
