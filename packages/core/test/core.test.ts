import { describe, expect, it } from 'vitest';
import {
  Keyring,
  DEFAULT_KDF,
  deriveAuthHash,
  deriveMasterKey,
  detectFormat,
  detectFormatStrict,
  extractBook,
  extractSeriesName,
  generateDataKey,
  generateRecoveryKey,
  groupBooks,
  isSha512,
  isUuid,
  locatorPercent,
  mergeProgress,
  randomSalt,
  readHead,
  sha512,
  titleFromFilename,
  unwrapDataKey,
  unwrapWithRecoveryKey,
  uuidv7,
  uuidv7Time,
  wrapDataKey,
  wrapWithRecoveryKey,
} from '../src';
import { makeCbz, makeEpub } from './fixtures';

const FAST_KDF = { ...DEFAULT_KDF, memoryKiB: 16 * 1024, iterations: 1 };

describe('uuidv7', () => {
  it('is valid, version 7, and sorts by creation', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.abs(uuidv7Time(ids[0]!) - Date.now())).toBeLessThan(5000);
  });
});

describe('sha512', () => {
  it('matches the known digest and is the same for bytes and blobs', async () => {
    const abc = new TextEncoder().encode('abc');
    const expected =
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f';
    expect(await sha512(abc)).toBe(expected);
    expect(await sha512(new Blob([abc]))).toBe(expected);
    expect(isSha512(expected)).toBe(true);
  });
});

describe('format', () => {
  it('detects by magic bytes and filename', async () => {
    const cbz = await makeCbz();
    const epub = await makeEpub();
    expect(detectFormat('x.cbz', await readHead(cbz))).toBe('cbz');
    expect(detectFormat('book.zip', await readHead(epub))).toBe('epub');
    expect(detectFormatStrict(await readHead(epub))).toBe('epub');
    expect(detectFormat('a.pdf', new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
    expect(detectFormat('a.cbr', new Uint8Array([0x52, 0x61, 0x72, 0x21]))).toBe('cbr');
    expect(detectFormat('a.txt', new Uint8Array([1, 2, 3]))).toBeNull();
    expect(detectFormatStrict(new TextEncoder().encode('hello'))).toBeNull();
    expect(titleFromFilename('dir/My_Comic  v01.cbz')).toBe('My Comic v01');
  });
});

describe('metadata', () => {
  it('reads CBZ page count, ComicInfo and cover', async () => {
    const info = '<?xml version="1.0"?><ComicInfo><Series>Saga</Series><Number>3</Number><Writer>B. K. Vaughan</Writer><Summary>Space.</Summary></ComicInfo>';
    const book = await extractBook(await makeCbz(3, info), 'saga-03.cbz');
    expect(book.format).toBe('cbz');
    expect(book.meta.pageCount).toBe(3);
    expect(book.meta.series).toBe('Saga');
    expect(book.meta.seriesIndex).toBe(3);
    expect(book.meta.title).toBe('Saga #3');
    expect(book.meta.authors).toEqual(['B. K. Vaughan']);
    expect(book.cover?.mime).toBe('image/png');
  });

  it('reads EPUB OPF metadata and cover', async () => {
    const book = await extractBook(await makeEpub(), 'test.epub');
    expect(book.format).toBe('epub');
    expect(book.meta.title).toBe('The Test Book');
    expect(book.meta.authors).toEqual(['Ada Lovelace', 'Charles Babbage']);
    expect(book.meta.series).toBe('Engines');
    expect(book.meta.seriesIndex).toBe(2);
    expect(book.meta.description).toBe('A short book.');
    expect(book.meta.language).toBe('en');
    expect(book.cover).not.toBeNull();
  });

  it('falls back to the filename for damaged files', async () => {
    const broken = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])]);
    const book = await extractBook(broken, 'Broken Comic.cbz');
    expect(book.meta.title).toBe('Broken Comic');
    expect(book.cover).toBeNull();
  });
});

describe('grouping', () => {
  it('extracts series names', () => {
    expect(extractSeriesName('One Piece v01')).toBe('One Piece');
    expect(extractSeriesName('Batman #12')).toBe('Batman');
    expect(extractSeriesName('Saga - 004')).toBe('Saga');
    expect(extractSeriesName('Dune')).toBe('Dune');
  });

  it('prefers custom group, then series metadata', () => {
    const groups = groupBooks(
      [
        { title: 'A v1' },
        { title: 'A v2' },
        { title: 'Odd', series: 'A' },
        { title: 'B v1', customGroup: 'Mine' },
      ],
      'name',
      { A: 'Series A' },
    );
    expect(groups.map((g) => [g.name, g.items.length])).toEqual([
      ['Series A', 3],
      ['Mine', 1],
    ]);
  });
});

describe('crypto', () => {
  it('derives the same auth hash for the same password and salt', async () => {
    const salt = randomSalt();
    const a = await deriveAuthHash(await deriveMasterKey('correct horse', salt, FAST_KDF));
    const b = await deriveAuthHash(await deriveMasterKey('correct horse', salt, FAST_KDF));
    const c = await deriveAuthHash(await deriveMasterKey('wrong horse', salt, FAST_KDF));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('wraps the data key with the master key and the recovery key', async () => {
    const master = await deriveMasterKey('pw', randomSalt(), FAST_KDF);
    const dataKey = generateDataKey();
    const wrapped = await wrapDataKey(dataKey, master);
    expect(await unwrapDataKey(wrapped, master)).toEqual(dataKey);

    const recovery = generateRecoveryKey();
    expect(recovery).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    const byRecovery = await wrapWithRecoveryKey(dataKey, recovery);
    expect(await unwrapWithRecoveryKey(byRecovery, recovery.toLowerCase().replace(/-/g, ' '))).toEqual(dataKey);

    const other = await deriveMasterKey('other', randomSalt(), FAST_KDF);
    await expect(unwrapDataKey(wrapped, other)).rejects.toThrow();
  });

  it('encrypts records bound to their kind and ref', async () => {
    const ring = await Keyring.fromDataKey(generateDataKey());
    const ref = await ring.ref('progress:abc');
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(await ring.ref('progress:abc')).toBe(ref);
    const ct = await ring.encrypt('progress', ref, { page: 4 });
    expect(await ring.decrypt('progress', ref, ct)).toEqual({ page: 4 });
    await expect(ring.decrypt('bookmark', ref, ct)).rejects.toThrow();

    const otherRing = await Keyring.fromDataKey(generateDataKey());
    expect(await otherRing.ref('progress:abc')).not.toBe(ref);
  });
});

describe('sync merge', () => {
  it('last write wins, ties are deterministic', () => {
    const base = { sha512: 'x', locator: { type: 'page' as const, page: 1, total: 10 }, percent: 0.1 };
    const a = { ...base, updatedAt: 10, deviceId: 'a' };
    const b = { ...base, updatedAt: 20, deviceId: 'b', percent: 0.5 };
    expect(mergeProgress(a, b)).toBe(b);
    expect(mergeProgress(b, a)).toBe(b);
    const tieA = { ...a, updatedAt: 30 };
    const tieB = { ...b, updatedAt: 30 };
    expect(mergeProgress(tieA, tieB)).toBe(mergeProgress(tieB, tieA));
  });

  it('computes percent from locators', () => {
    expect(locatorPercent({ type: 'page', page: 9, total: 10 })).toBe(1);
    expect(locatorPercent({ type: 'epub', spine: 1, progression: 0.5, total: 3 })).toBe(0.5);
  });
});
