import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { collectZipEntries } from '../src/shared/collect';
import {
  createArchivePlan,
  getSelectedUris,
  getSingleArchiveName,
  removeNestedSelections
} from '../src/shared/plan';
import { findCommonParentUri, relativeUriPath, uriBasename, uriDirname } from '../src/shared/uri-path';
import { nodeFs } from '../src/desktop/node-fs';
import { FakeUri } from './helpers/fake-uri';
import type { UriLike } from '../src/shared/types';

const fileStat = { isFile: true, isDirectory: false, isSymbolicLink: false, mtimeMs: 0 };
const dirStat = { isFile: false, isDirectory: true, isSymbolicLink: false, mtimeMs: 0 };

function displayPath(uri: UriLike): string {
  return uri.fsPath ?? uri.toString();
}

async function makeTempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'saz-collect-'));
}

test('getSelectedUris falls back to the primary uri, filters, and dedups', () => {
  const acceptsFile = (uri: UriLike) => uri.scheme === 'file';
  const dedupKey = (uri: UriLike) => uri.path;

  const a = FakeUri.file('/ws/a.txt');
  const b = FakeUri.file('/ws/b.txt');
  const remote = new FakeUri('vscode-remote', 'wsl', '/ws/c.txt');

  assert.deepStrictEqual(getSelectedUris(a, undefined, acceptsFile, dedupKey), [a]);
  assert.deepStrictEqual(getSelectedUris(a, [a, b, a], acceptsFile, dedupKey), [a, b]);
  assert.deepStrictEqual(getSelectedUris(undefined, [remote], acceptsFile, dedupKey), []);
  assert.deepStrictEqual(getSelectedUris(undefined, undefined, acceptsFile, dedupKey), []);
});

test('single-selection archive names avoid clobbering the original name', () => {
  assert.strictEqual(getSingleArchiveName(FakeUri.file('/ws/notes.txt'), fileStat), 'notes.zip');
  assert.strictEqual(getSingleArchiveName(FakeUri.file('/ws/archive.zip'), fileStat), 'archive-archive.zip');
  assert.strictEqual(getSingleArchiveName(FakeUri.file('/ws/.bashrc'), fileStat), '.bashrc.zip');
  assert.strictEqual(getSingleArchiveName(FakeUri.file('/ws/no-extension'), fileStat), 'no-extension.zip');
  assert.strictEqual(getSingleArchiveName(FakeUri.file('/ws/folder'), dirStat), 'folder.zip');
});

test('multi-selection plans zip to selected-files.zip under the common parent', () => {
  const plan = createArchivePlan([
    { uri: FakeUri.file('/ws/src/deep/a.txt'), stat: fileStat },
    { uri: FakeUri.file('/ws/src/other/b.txt'), stat: fileStat }
  ]);
  assert.strictEqual(plan.filename, 'selected-files.zip');
  assert.strictEqual(plan.rootUri.path, '/ws/src');
});

test('findCommonParentUri handles disjoint paths and root parents', () => {
  assert.strictEqual(
    findCommonParentUri([FakeUri.file('/a/b/c.txt'), FakeUri.file('/a/b/d/e.txt')]).path,
    '/a/b'
  );
  assert.strictEqual(findCommonParentUri([FakeUri.file('/a/x.txt'), FakeUri.file('/b/y.txt')]).path, '/');
});

test('uri path helpers behave like their node counterparts for posix paths', () => {
  assert.strictEqual(uriDirname(FakeUri.file('/a/b/c')).path, '/a/b');
  assert.strictEqual(uriDirname(FakeUri.file('/a')).path, '/');
  assert.strictEqual(uriBasename(FakeUri.file('/a/b/c.txt')), 'c.txt');
  assert.strictEqual(relativeUriPath(FakeUri.file('/a/b'), FakeUri.file('/a/b/c/d')), 'c/d');
  assert.strictEqual(relativeUriPath(FakeUri.file('/a/b'), FakeUri.file('/a/bc')), undefined);
  assert.strictEqual(relativeUriPath(FakeUri.file('/a/b'), FakeUri.file('/a/b')), undefined);
});

test('removeNestedSelections drops items covered by a selected ancestor directory', async () => {
  const baseDir = await makeTempDir();
  try {
    const nested = path.join(baseDir, 'parent', 'child');
    await fs.promises.mkdir(nested, { recursive: true });
    await fs.promises.writeFile(path.join(nested, 'file.txt'), 'x');
    await fs.promises.writeFile(path.join(baseDir, 'other.txt'), 'y');

    const items = await removeNestedSelections(nodeFs, [
      FakeUri.file(path.join(nested, 'file.txt')),
      FakeUri.file(path.join(baseDir, 'parent')),
      FakeUri.file(path.join(baseDir, 'other.txt'))
    ]);

    assert.deepStrictEqual(
      items.map((item) => item.uri.path),
      [path.join(baseDir, 'parent'), path.join(baseDir, 'other.txt')]
    );
  } finally {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  }
});

test('collect excludes the temp directory by base name and by uri', async () => {
  const baseDir = await makeTempDir();
  try {
    await fs.promises.mkdir(path.join(baseDir, 'data', '.save-files-as-zip'), { recursive: true });
    await fs.promises.mkdir(path.join(baseDir, 'data', 'skipme'), { recursive: true });
    await fs.promises.writeFile(path.join(baseDir, 'data', '.save-files-as-zip', 'stale.zip'), 'x');
    await fs.promises.writeFile(path.join(baseDir, 'data', 'skipme', 'secret.txt'), 'x');
    await fs.promises.writeFile(path.join(baseDir, 'data', 'keep.txt'), 'x');

    const root = FakeUri.file(baseDir);
    const items = await removeNestedSelections(nodeFs, [FakeUri.file(path.join(baseDir, 'data'))]);
    const entries = await collectZipEntries(nodeFs, items, {
      rootUri: root,
      excludeBaseNames: ['.save-files-as-zip'],
      excludeUris: [FakeUri.file(path.join(baseDir, 'data', 'skipme'))],
      displayPath
    });

    assert.deepStrictEqual(
      entries.map((entry) => entry.zipPath),
      ['data/', 'data/keep.txt']
    );
  } finally {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  }
});

test('collect rejects Windows drive-root and cross-drive selections like the old implementation', async () => {
  // Uri.file('C:\\') has path '/c:/', so a drive root or cross-drive
  // selection ends up with rootUri path '/' and a drive-letter first segment.
  const driveRoot = new FakeUri('file', '', '/c:/');
  const crossDrive = new FakeUri('file', '', '/d:/data/file.txt');
  const root = new FakeUri('file', '', '/');

  await assert.rejects(
    collectZipEntries(nodeFs, [{ uri: driveRoot, stat: dirStat }], { rootUri: root, displayPath }),
    /outside the archive root/
  );
  await assert.rejects(
    collectZipEntries(nodeFs, [{ uri: crossDrive, stat: fileStat }], { rootUri: root, displayPath }),
    /outside the archive root/
  );
});

test('collect accepts file names that merely start with dots', async () => {
  const baseDir = await makeTempDir();
  try {
    await fs.promises.writeFile(path.join(baseDir, '..foo'), 'dots\n');
    const items = await removeNestedSelections(nodeFs, [FakeUri.file(path.join(baseDir, '..foo'))]);
    const entries = await collectZipEntries(nodeFs, items, { rootUri: FakeUri.file(baseDir), displayPath });
    assert.deepStrictEqual(
      entries.map((entry) => entry.zipPath),
      ['..foo']
    );
  } finally {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  }
});

test('collect rejects symbolic links and out-of-root selections', async () => {
  const baseDir = await makeTempDir();
  try {
    await fs.promises.writeFile(path.join(baseDir, 'real.txt'), 'x');
    await fs.promises.symlink(path.join(baseDir, 'real.txt'), path.join(baseDir, 'link.txt'));

    const root = FakeUri.file(baseDir);
    await assert.rejects(
      collectZipEntries(
        nodeFs,
        [{ uri: FakeUri.file(path.join(baseDir, 'link.txt')), stat: fileStat }],
        { rootUri: root, displayPath }
      ),
      /Symbolic links are not supported/
    );

    await assert.rejects(
      collectZipEntries(nodeFs, [{ uri: FakeUri.file('/elsewhere/file.txt'), stat: fileStat }], {
        rootUri: root,
        displayPath
      }),
      /outside the archive root/
    );
  } finally {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  }
});
