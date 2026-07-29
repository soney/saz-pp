// End-to-end test of the BUILT web bundle (dist/web/extension.js) against an
// in-memory vscode.workspace.fs — the web zip writer previously had zero
// coverage under `npm test`.
import * as assert from 'assert';
import { createRequire } from 'module';
import * as path from 'path';
import { test } from 'node:test';
import { FakeUri } from './helpers/fake-uri';
import { parseZip, entryNames, entryByName } from './helpers/read-zip';
import { crc32 } from '../src/shared/zip-core';
import { xorshiftBytes } from './helpers/fixture-tree';

const DIST_WEB = path.join(__dirname, '..', 'dist', 'web', 'extension.js');

const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;

interface MemNode {
  type: number;
  mtime: number;
  data?: Uint8Array;
}

class MemFs {
  readonly nodes = new Map<string, MemNode>();

  addDir(p: string, mtime = 1714786922000): void {
    this.nodes.set(p, { type: DIRECTORY, mtime });
  }

  addFile(p: string, data: Uint8Array | string, mtime = 1714786922000): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.nodes.set(p, { type: FILE, mtime, data: bytes });
  }

  pathsUnder(prefix: string): string[] {
    return [...this.nodes.keys()].filter((p) => p === prefix || p.startsWith(`${prefix}/`));
  }

  asWorkspaceFs() {
    const nodes = this.nodes;
    return {
      async stat(uri: FakeUri) {
        const node = nodes.get(uri.path);
        if (!node) {
          throw new Error(`FileNotFound: ${uri.path}`);
        }
        return { type: node.type, ctime: node.mtime, mtime: node.mtime, size: node.data?.length ?? 0 };
      },
      async readDirectory(uri: FakeUri): Promise<Array<[string, number]>> {
        const prefix = uri.path === '/' ? '/' : `${uri.path}/`;
        const children: Array<[string, number]> = [];
        for (const [p, node] of nodes) {
          if (p.startsWith(prefix) && p !== uri.path && !p.slice(prefix.length).includes('/')) {
            children.push([p.slice(prefix.length), node.type]);
          }
        }
        return children;
      },
      async readFile(uri: FakeUri): Promise<Uint8Array> {
        const node = nodes.get(uri.path);
        if (!node || node.type !== FILE) {
          throw new Error(`FileNotFound: ${uri.path}`);
        }
        return node.data!;
      },
      async createDirectory(uri: FakeUri): Promise<void> {
        const segments = uri.path.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments) {
          current += `/${segment}`;
          if (!nodes.has(current)) {
            nodes.set(current, { type: DIRECTORY, mtime: 1714786922000 });
          }
        }
      },
      async writeFile(uri: FakeUri, content: Uint8Array): Promise<void> {
        nodes.set(uri.path, { type: FILE, mtime: 1714786922000, data: content });
      },
      async delete(uri: FakeUri, options?: { recursive?: boolean }): Promise<void> {
        const targets = [...nodes.keys()].filter(
          (p) => p === uri.path || (options?.recursive && p.startsWith(`${uri.path}/`))
        );
        if (targets.length === 0) {
          throw new Error(`FileNotFound: ${uri.path}`);
        }
        for (const target of targets) {
          nodes.delete(target);
        }
      }
    };
  }
}

function createWebVscodeMock(memFs: MemFs) {
  const workspaceFs = memFs.asWorkspaceFs();
  const vscode = {
    FileType: { Unknown: 0, File: FILE, Directory: DIRECTORY, SymbolicLink: SYMLINK },
    ProgressLocation: { Notification: 15 },
    commands: {
      registeredCallback: undefined as ((uri?: FakeUri, selected?: FakeUri[]) => Promise<void>) | undefined,
      executedCommands: [] as Array<{ command: string; resource?: FakeUri }>,
      capturedDownloads: [] as Array<{ filename: string; bytes: Uint8Array }>,
      revealedResource: undefined as FakeUri | undefined,
      registerCommand(_command: string, callback: (uri?: FakeUri, selected?: FakeUri[]) => Promise<void>) {
        this.registeredCallback = callback;
        return { dispose() {} };
      },
      async executeCommand(command: string, resource?: FakeUri) {
        this.executedCommands.push({ command, resource });
        if (command === 'revealInExplorer') {
          this.revealedResource = resource;
        }
        if (command === 'explorer.download') {
          // Like the real workbench, the file is streamed only when
          // explorer.download runs — it must still exist at that moment.
          const revealed = this.revealedResource;
          assert.ok(revealed, 'explorer.download fired without a revealed resource');
          const bytes = await workspaceFs.readFile(revealed);
          this.capturedDownloads.push({ filename: revealed.path.split('/').pop()!, bytes });
        }
      }
    },
    workspace: {
      configuration: { tempDirectory: undefined as string | undefined },
      fs: workspaceFs,
      getConfiguration(section: string) {
        assert.strictEqual(section, 'saveFilesAsZip');
        const configuration = this.configuration;
        return {
          get: (key: string, defaultValue: string) => {
            assert.strictEqual(key, 'tempDirectory');
            return configuration.tempDirectory === undefined ? defaultValue : configuration.tempDirectory;
          }
        };
      }
    },
    window: {
      informationMessages: [] as string[],
      warningMessages: [] as string[],
      errorMessages: [] as string[],
      showInformationMessage(message: string) {
        this.informationMessages.push(message);
      },
      showWarningMessage(message: string) {
        this.warningMessages.push(message);
      },
      showErrorMessage(message: string) {
        this.errorMessages.push(message);
      },
      withProgress(_options: unknown, task: (progress: { report(value: unknown): void }) => Promise<unknown>) {
        return task({ report() {} });
      }
    }
  };
  return vscode;
}

function loadWebBundle(vscode: unknown): { activate(context: unknown): void } {
  const requireFromHere = createRequire(__filename);
  // The real (mutable) Module object, not esbuild's frozen ESM namespace.
  const moduleAny = requireFromHere('module') as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
    _cache: Record<string, unknown>;
  };
  const originalLoad = moduleAny._load;
  moduleAny._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // Bust the require cache so each test gets a bundle bound to its own mock.
    delete moduleAny._cache[DIST_WEB];
    return requireFromHere(DIST_WEB) as { activate(context: unknown): void };
  } finally {
    moduleAny._load = originalLoad;
  }
}

function seedWorkspace(): MemFs {
  const memFs = new MemFs();
  memFs.addDir('/ws');
  memFs.addFile('/ws/hello.txt', 'hello web zip! '.repeat(300));
  memFs.addFile('/ws/blob.bin', xorshiftBytes(0xfeedface, 2048));
  memFs.addDir('/ws/dir');
  memFs.addFile('/ws/dir/nested.txt', 'nested\n');
  memFs.addDir('/ws/dir/empty-sub');
  return memFs;
}

const wsUri = (p: string) => new FakeUri('vscode-test-web', 'mount', p);

test('web bundle zips a multi-selection through the temp-file flow with compression and cleanup', async () => {
  const memFs = seedWorkspace();
  const vscode = createWebVscodeMock(memFs);
  const extension = loadWebBundle(vscode);
  extension.activate({ subscriptions: [] });

  await vscode.commands.registeredCallback!(wsUri('/ws/hello.txt'), [
    wsUri('/ws/hello.txt'),
    wsUri('/ws/blob.bin'),
    wsUri('/ws/dir')
  ]);

  assert.strictEqual(vscode.window.errorMessages.length, 0, vscode.window.errorMessages[0]);
  assert.strictEqual(vscode.commands.capturedDownloads.length, 1);
  const download = vscode.commands.capturedDownloads[0];
  assert.strictEqual(download.filename, 'selected-files.zip');

  const zip = parseZip(download.bytes);
  assert.deepStrictEqual(entryNames(zip), [
    'hello.txt',
    'blob.bin',
    'dir/',
    'dir/empty-sub/',
    'dir/nested.txt'
  ]);

  // Node >= 22 has CompressionStream('deflate-raw'), so the web writer
  // must deflate compressible payloads here.
  assert.strictEqual(entryByName(zip, 'hello.txt').method, 8);
  assert.strictEqual(entryByName(zip, 'hello.txt').data.toString(), 'hello web zip! '.repeat(300));
  assert.strictEqual(entryByName(zip, 'blob.bin').method, 0);
  for (const entry of zip.entries) {
    assert.strictEqual(crc32(entry.data), entry.crc32, `crc mismatch for ${entry.name}`);
  }

  // Without lstat modes, archives carry unix default modes so extraction
  // does not lose permissions.
  assert.strictEqual(
    zip.central.find((entry) => entry.name === 'dir/')!.externalAttributes,
    ((0o40755 << 16) | 0x10) >>> 0
  );
  assert.strictEqual(
    zip.central.find((entry) => entry.name === 'hello.txt')!.externalAttributes,
    (0o100644 << 16) >>> 0
  );

  // Temp files are cleaned up and the explorer download flow ran in order.
  assert.deepStrictEqual(
    vscode.commands.executedCommands.map((call) => call.command),
    ['revealInExplorer', 'explorer.download']
  );
  assert.deepStrictEqual(memFs.pathsUnder('/ws/.save-files-as-zip'), []);
  assert.match(vscode.window.informationMessages[0], /Downloaded selected-files\.zip/);
});

test('web bundle stores uncompressed when CompressionStream is unavailable', async () => {
  const globalAny = globalThis as { CompressionStream?: unknown };
  const original = globalAny.CompressionStream;
  globalAny.CompressionStream = undefined;
  try {
    const memFs = seedWorkspace();
    const vscode = createWebVscodeMock(memFs);
    const extension = loadWebBundle(vscode);
    extension.activate({ subscriptions: [] });

    await vscode.commands.registeredCallback!(wsUri('/ws/hello.txt'), [wsUri('/ws/hello.txt')]);

    assert.strictEqual(vscode.window.errorMessages.length, 0, vscode.window.errorMessages[0]);
    const download = vscode.commands.capturedDownloads[0];
    assert.strictEqual(download.filename, 'hello.zip');
    const zip = parseZip(download.bytes);
    assert.strictEqual(entryByName(zip, 'hello.txt').method, 0);
    assert.strictEqual(crc32(entryByName(zip, 'hello.txt').data), entryByName(zip, 'hello.txt').crc32);
  } finally {
    globalAny.CompressionStream = original;
  }
});

test('web bundle rejects mixed-filesystem selections', async () => {
  const memFs = seedWorkspace();
  const vscode = createWebVscodeMock(memFs);
  const extension = loadWebBundle(vscode);
  extension.activate({ subscriptions: [] });

  await vscode.commands.registeredCallback!(wsUri('/ws/hello.txt'), [
    wsUri('/ws/hello.txt'),
    new FakeUri('other-scheme', 'elsewhere', '/x.txt')
  ]);

  assert.strictEqual(vscode.window.errorMessages.length, 1);
  assert.match(vscode.window.errorMessages[0], /same workspace file system/);
});

test('web bundle preserves literal backslashes in file names', async () => {
  const memFs = seedWorkspace();
  memFs.addFile('/ws/weird\\name.txt', 'backslash content\n');
  const vscode = createWebVscodeMock(memFs);
  const extension = loadWebBundle(vscode);
  extension.activate({ subscriptions: [] });

  await vscode.commands.registeredCallback!(wsUri('/ws/weird\\name.txt'), [
    wsUri('/ws/weird\\name.txt'),
    wsUri('/ws/dir')
  ]);

  assert.strictEqual(vscode.window.errorMessages.length, 0, vscode.window.errorMessages[0]);
  const zip = parseZip(vscode.commands.capturedDownloads[0].bytes);
  assert.ok(entryNames(zip).includes('weird\\name.txt'), `backslash name mangled: ${entryNames(zip)}`);
  assert.strictEqual(entryByName(zip, 'weird\\name.txt').data.toString(), 'backslash content\n');
});

test('web bundle normalizes dotted relative tempDirectory settings and still cleans up', async () => {
  const memFs = seedWorkspace();
  const vscode = createWebVscodeMock(memFs);
  vscode.workspace.configuration.tempDirectory = './zips/../.dotted-temp';
  const extension = loadWebBundle(vscode);
  extension.activate({ subscriptions: [] });

  await vscode.commands.registeredCallback!(wsUri('/ws/hello.txt'), [wsUri('/ws/hello.txt')]);

  assert.strictEqual(vscode.window.errorMessages.length, 0, vscode.window.errorMessages[0]);
  assert.strictEqual(vscode.commands.capturedDownloads[0].filename, 'hello.zip');
  // The temp file was written under the normalized root (no literal '.'/'..'
  // segments) and removed afterwards.
  const revealedPath = vscode.commands.revealedResource!.path;
  assert.ok(
    revealedPath.startsWith('/ws/.dotted-temp/'),
    `expected temp under /ws/.dotted-temp, got ${revealedPath}`
  );
  assert.deepStrictEqual(memFs.pathsUnder('/ws/.dotted-temp'), []);
});

test('web bundle completes the download even when temp cleanup fails', async () => {
  const memFs = seedWorkspace();
  const vscode = createWebVscodeMock(memFs);
  const workspaceFs = vscode.workspace.fs as { delete(uri: FakeUri, options?: { recursive?: boolean }): Promise<void> };
  workspaceFs.delete = async () => {
    throw new Error('EBUSY: cleanup blocked');
  };
  const extension = loadWebBundle(vscode);
  extension.activate({ subscriptions: [] });

  await vscode.commands.registeredCallback!(wsUri('/ws/hello.txt'), [wsUri('/ws/hello.txt')]);

  // Cleanup failures are best-effort: the download still succeeds and the
  // user still gets the success message.
  assert.strictEqual(vscode.window.errorMessages.length, 0, vscode.window.errorMessages[0]);
  assert.strictEqual(vscode.commands.capturedDownloads.length, 1);
  assert.strictEqual(vscode.commands.capturedDownloads[0].filename, 'hello.zip');
  assert.match(vscode.window.informationMessages[0], /Downloaded hello\.zip/);
});
