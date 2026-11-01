/**
 * Book fixtures generated in Node: comic pages as PNGs (tiny hand-rolled
 * encoder), an EPUB and a CBZ via zip.js, and a PDF written by hand.
 */
import { deflateSync } from 'node:zlib';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new TextEncoder().encode(type);
  out.set(typed, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGB image, `paint(x, y)` returns [r, g, b]. */
export function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[i++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      raw[i++] = r;
      raw[i++] = g;
      raw[i++] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A comic page: a coloured panel layout with the page number as bars. */
function comicPage(n: number): Uint8Array {
  const hue = (n * 67) % 360;
  const [r, g, b] = hsl(hue, 0.45, 0.55);
  return png(400, 600, (x, y) => {
    const border = x < 16 || x > 383 || y < 16 || y > 583 || (y > 290 && y < 306);
    if (border) return [250, 248, 240];
    // n vertical bars in the top panel so pages are distinguishable.
    if (y > 60 && y < 250 && x > 40 && x < 40 + n * 40 && (x - 40) % 40 < 24) return [30, 30, 30];
    return y < 300 ? [r, g, b] : [Math.round(r * 0.7), Math.round(g * 0.7), Math.round(b * 0.7)];
  });
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

async function bytes(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

// --- CBZ ---------------------------------------------------------------------

export async function makeCbz(pages = 6, number = 1, title = 'Seeds'): Promise<Buffer> {
  const zip = new ZipWriter(new BlobWriter('application/zip'));
  for (let i = pages; i >= 1; i--) await zip.add(`Pages/page-${String(i).padStart(2, '0')}.png`, new Uint8ArrayReader(comicPage(i)));
  await zip.add(
    'ComicInfo.xml',
    new TextReader(
      `<?xml version="1.0"?><ComicInfo><Series>Night Garden</Series><Number>${number}</Number><Title>${title}</Title><Writer>Mira Holt</Writer></ComicInfo>`,
    ),
  );
  return bytes(await zip.close());
}

// --- EPUB --------------------------------------------------------------------

const LOREM =
  'It was the quiet hour before the lamps were lit, and the reading room held its breath. Shelves leaned toward one another like old friends sharing a secret. ' +
  'Somewhere a clock disagreed with the cathedral bells, and nobody minded. She turned the page and the page turned her, the way good pages do. ';

function chapter(n: number, title: string, extra = ''): string {
  const paras = Array.from({ length: 14 }, (_, i) => `<p>${LOREM.repeat(1 + (i % 3))}</p>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title><link rel="stylesheet" href="../styles/book.css"/></head>
<body>
<h1 id="top">${title}</h1>
${extra}
${paras}
<p id="end-${n}">End of ${title}.</p>
</body></html>`;
}

export async function makeEpub(): Promise<Buffer> {
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
    <dc:identifier id="id">urn:uuid:7b0c2a8e-0000-4000-8000-000000000001</dc:identifier>
    <dc:title>The Reading Room</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>A short book for testing.</dc:description>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`),
  );
  const cover = png(300, 450, (x, y) => (y > 150 && y < 300 && x > 30 && x < 270 ? [244, 239, 228] : [36, 88, 75]));
  await zip.add('OEBPS/images/cover.png', new Uint8ArrayReader(cover));
  await zip.add('OEBPS/styles/book.css', new TextReader('h1 { font-variant: small-caps; } p { text-indent: 1.2em; margin: 0 0 .4em; }'));
  await zip.add(
    'OEBPS/nav.xhtml',
    new TextReader(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' +
        '<li><a href="text/ch1.xhtml">The Quiet Hour</a></li><li><a href="text/ch2.xhtml">Lamps</a></li><li><a href="text/ch3.xhtml">Closing Time</a></li>' +
        '</ol></nav></body></html>',
    ),
  );
  // Chapter 1 carries hostile markup: none of it may run.
  const hostile =
    '<script>parent.__pwned = "script";</script>' +
    '<img src="missing.png" onerror="parent.__pwned = \'onerror\'" alt=""/>' +
    '<p><a id="go-ch3" href="ch3.xhtml#end-3">Skip to the end</a> · <a id="external" href="https://example.com/">external link</a> · ' +
    '<a href="javascript:parent.__pwned=1">bad link</a></p>';
  await zip.add('OEBPS/text/ch1.xhtml', new TextReader(chapter(1, 'The Quiet Hour', hostile)));
  await zip.add('OEBPS/text/ch2.xhtml', new TextReader(chapter(2, 'Lamps')));
  await zip.add('OEBPS/text/ch3.xhtml', new TextReader(chapter(3, 'Closing Time')));
  return bytes(await zip.close());
}

// --- PDF ---------------------------------------------------------------------

/** A minimal, valid multi-page PDF with real text (selectable) and an outline. */
export function makePdf(pages = 4): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };
  const catalog = add(''); // placeholder, filled below
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (let i = 1; i <= pages; i++) {
    const text = [
      'BT /F1 36 Tf 72 700 Td (Chapter ' + i + ') Tj ET',
      'BT /F1 14 Tf 72 650 Td (This is page ' + i + ' of the Libraria test document.) Tj ET',
      'BT /F1 14 Tf 72 630 Td (Select this sentence to check the text layer.) Tj ET',
      '0.14 0.35 0.29 rg 72 120 ' + i * 60 + ' 24 re f',
    ].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  // Outline with one entry per page.
  const outlineRoot = add('');
  const items = pageIds.map((pid, i) => add(`<< /Title (Chapter ${i + 1}) /Parent ${outlineRoot} 0 R /Dest [${pid} 0 R /Fit] >>`));
  items.forEach((id, i) => {
    const links = [i > 0 ? `/Prev ${items[i - 1]} 0 R` : '', i < items.length - 1 ? `/Next ${items[i + 1]} 0 R` : ''].join(' ');
    objects[id - 1] = objects[id - 1]!.replace(' >>', ` ${links} >>`);
  });
  objects[outlineRoot - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /Outlines ${outlineRoot} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pages} >>`;
  const info = add('<< /Title (Field Notes on Paper) /Author (Grace Hopper) >>');

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
