// Golden byte-parity and zip-writer unit tests. TZ is forced to UTC because
// zip DOS timestamps use local time and the golden fixture was generated
// under TZ=UTC.
process.env.TZ = 'UTC';

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { buildZip, crc32 } from '../src/shared/zip-core';
import { collectZipEntries } from '../src/shared/collect';
import { createArchivePlan, removeNestedSelections } from '../src/shared/plan';
import { nodeFs, nodeDeflateRaw } from '../src/desktop/node-fs';
import { FakeUri } from './helpers/fake-uri';
import { buildTree, xorshiftBytes, TreeSpec } from './helpers/fixture-tree';
import { parseZip, entryByName } from './helpers/read-zip';

const fixturesDir = path.join(__dirname, '..', 'test', 'fixtures');

function displayPath(uri: { fsPath?: string; toString(): string }): string {
  return uri.fsPath ?? uri.toString();
}

test('reproduces the pre-refactor desktop bytes exactly (golden fixture)', async () => {
  assert.strictEqual(new Date().getTimezoneOffset(), 0, 'golden test must run with TZ=UTC');

  const spec: TreeSpec = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'golden-tree.json'), 'utf8'));
  const golden = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'golden-desktop.json'), 'utf8'));
  const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'saz-golden-'));

  try {
    await buildTree(baseDir, spec);
    const rootUri = FakeUri.file(path.join(baseDir, spec.root));
    const selectedItems = await removeNestedSelections(nodeFs, [rootUri]);
    const plan = createArchivePlan(selectedItems);
    assert.strictEqual(plan.filename, `${spec.root}.zip`);
    assert.strictEqual(plan.rootUri.path, baseDir);

    const entries = await collectZipEntries(nodeFs, selectedItems, {
      rootUri: plan.rootUri,
      excludeBaseNames: ['.save-files-as-zip'],
      displayPath
    });
    const bytes = await buildZip(entries, { deflateRaw: nodeDeflateRaw });

    const expected = Buffer.from(golden.base64, 'base64');
    assert.strictEqual(Buffer.compare(Buffer.from(bytes), expected), 0, 'zip bytes must match the golden fixture');
  } finally {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  }
});

test('crc32 matches known vectors', () => {
  assert.strictEqual(crc32(new Uint8Array(0)), 0);
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('deflates compressible payloads and stores incompressible or empty ones', async () => {
  const compressible = Buffer.from('abcdef '.repeat(500));
  const incompressible = xorshiftBytes(0xdecafbad, 2048);

  const bytes = await buildZip(
    [
      { kind: 'file', zipPath: 'text.txt', displayPath: 'text.txt', mtimeMs: 1714786922000, getData: async () => compressible },
      { kind: 'file', zipPath: 'noise.bin', displayPath: 'noise.bin', mtimeMs: 1714786922000, getData: async () => incompressible },
      { kind: 'file', zipPath: 'empty.txt', displayPath: 'empty.txt', mtimeMs: 1714786922000, getData: async () => new Uint8Array(0) },
      { kind: 'directory', zipPath: 'dir/', displayPath: 'dir', mtimeMs: 1714786922000 }
    ],
    { deflateRaw: nodeDeflateRaw }
  );

  const zip = parseZip(bytes);
  assert.strictEqual(zip.entryCount, 4);
  assert.strictEqual(entryByName(zip, 'text.txt').method, 8);
  assert.deepStrictEqual(entryByName(zip, 'text.txt').data, compressible);
  assert.strictEqual(entryByName(zip, 'noise.bin').method, 0);
  assert.deepStrictEqual(entryByName(zip, 'noise.bin').data, Buffer.from(incompressible));
  assert.strictEqual(entryByName(zip, 'empty.txt').method, 0);
  assert.strictEqual(entryByName(zip, 'empty.txt').data.length, 0);
  for (const entry of zip.entries) {
    assert.strictEqual(crc32(entry.data), entry.crc32, `crc mismatch for ${entry.name}`);
  }
});

test('stores everything when no deflate implementation is available', async () => {
  const compressible = Buffer.from('abcdef '.repeat(500));
  const bytes = await buildZip([
    { kind: 'file', zipPath: 'text.txt', displayPath: 'text.txt', mtimeMs: 1714786922000, getData: async () => compressible }
  ]);
  assert.strictEqual(entryByName(parseZip(bytes), 'text.txt').method, 0);
});

test('uses unix default modes in external attributes when the platform has no modes', async () => {
  const bytes = await buildZip([
    { kind: 'directory', zipPath: 'dir/', displayPath: 'dir', mtimeMs: 1714786922000 },
    { kind: 'file', zipPath: 'file.txt', displayPath: 'file.txt', mtimeMs: 1714786922000, getData: async () => Buffer.from('x') }
  ]);
  const zip = parseZip(bytes);
  assert.strictEqual(zip.central.find((entry) => entry.name === 'dir/')!.externalAttributes, ((0o40755 << 16) | 0x10) >>> 0);
  assert.strictEqual(zip.central.find((entry) => entry.name === 'file.txt')!.externalAttributes, (0o100644 << 16) >>> 0);
});

test('rejects empty entry lists, oversized archives, and overlong paths', async () => {
  await assert.rejects(() => buildZip([]), /did not contain any files or folders/);

  const manyEntries = Array.from({ length: 65536 }, (_, index) => ({
    kind: 'directory' as const,
    zipPath: `d${index}/`,
    displayPath: `d${index}`,
    mtimeMs: 1714786922000
  }));
  await assert.rejects(() => buildZip(manyEntries), /more than 65535 entries/);

  await assert.rejects(
    () =>
      buildZip([
        { kind: 'file', zipPath: 'x'.repeat(70000), displayPath: 'long', mtimeMs: 1714786922000, getData: async () => new Uint8Array(0) }
      ]),
    /Zip path is too long/
  );
});
