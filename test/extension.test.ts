// End-to-end test of the BUILT desktop bundle (dist/extension.js) through the
// registered command, with the vscode module mocked at require time.
import * as assert from 'assert';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { FakeUri } from './helpers/fake-uri';
import { parseZip, entryNames, entryByName } from './helpers/read-zip';

const DIST_DESKTOP = path.join(__dirname, '..', 'dist', 'extension.js');

interface RecordedDownload {
  filename: string;
  bytes: Buffer;
}

test('desktop bundle zips the selection and downloads via webview, then via temp file on web UIs', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-files-as-zip-command-'));
  const fixtureDir = path.join(tempDir, 'fixture');
  const nestedDir = path.join(fixtureDir, 'nested');
  await fs.promises.mkdir(nestedDir, { recursive: true });
  await fs.promises.writeFile(path.join(fixtureDir, 'alpha.txt'), 'alpha\n');
  await fs.promises.writeFile(path.join(nestedDir, 'beta.txt'), 'beta\n');

  const vscode = createVscodeMock();
  const extension = requireWithVscodeMock(DIST_DESKTOP, vscode);
  const context = { subscriptions: [] as Array<{ dispose(): unknown }> };
  extension.activate(context);

  assert.strictEqual(vscode.commands.registeredCommand, 'saveFilesAsZip.saveAsZip');
  assert.strictEqual(context.subscriptions.length, 1);

  await vscode.commands.registeredCallback!(FakeUri.file(path.join(fixtureDir, 'alpha.txt')), [
    FakeUri.file(path.join(fixtureDir, 'alpha.txt')),
    FakeUri.file(nestedDir)
  ]);

  const outputPath = path.join(fixtureDir, 'selected-files.zip');
  assert.strictEqual(fs.existsSync(outputPath), false);
  assert.strictEqual(vscode.window.downloads.length, 1);
  assert.strictEqual(vscode.window.downloads[0].filename, 'selected-files.zip');
  const zip = parseZip(vscode.window.downloads[0].bytes);
  assert.deepStrictEqual(entryNames(zip), ['alpha.txt', 'nested/', 'nested/beta.txt']);
  assert.strictEqual(entryByName(zip, 'alpha.txt').data.toString(), 'alpha\n');
  assert.strictEqual(entryByName(zip, 'nested/beta.txt').data.toString(), 'beta\n');
  assert.strictEqual(vscode.window.informationMessages.length, 1);
  assert.match(vscode.window.informationMessages[0], /Downloaded selected-files\.zip/);
  assert.deepStrictEqual(vscode.window.progressTitles, ['Creating selected-files.zip']);

  // Switch to a web UI: the same command must go through the temp-file +
  // explorer.download flow and clean up after itself.
  vscode.env.uiKind = vscode.UIKind.Web;
  vscode.workspace.configuration.tempDirectory = path.join(tempDir, 'absolute-temp-zips');
  vscode.commands.executedCommands.length = 0;
  await vscode.commands.registeredCallback!(FakeUri.file(path.join(fixtureDir, 'alpha.txt')), [
    FakeUri.file(path.join(fixtureDir, 'alpha.txt')),
    FakeUri.file(nestedDir)
  ]);

  assert.strictEqual(fs.existsSync(outputPath), false);
  assert.strictEqual(fs.existsSync(vscode.workspace.configuration.tempDirectory), false);
  assert.strictEqual(vscode.commands.executedCommands.length, 2);
  assert.strictEqual(vscode.commands.executedCommands[0].command, 'revealInExplorer');
  const revealed = vscode.commands.executedCommands[0].resource as FakeUri;
  assert.ok(revealed.fsPath.startsWith(`${vscode.workspace.configuration.tempDirectory}${path.sep}`));
  assert.strictEqual(path.basename(revealed.fsPath), 'selected-files.zip');
  assert.strictEqual(vscode.commands.executedCommands[1].command, 'explorer.download');

  // Empty selection warns instead of erroring.
  await vscode.commands.registeredCallback!(undefined, []);
  assert.strictEqual(vscode.window.warningMessages.length, 1);

  // A URI-shaped tempDirectory is rejected with the command-level error message.
  vscode.env.uiKind = vscode.UIKind.Desktop;
  vscode.workspace.configuration.tempDirectory = 'scheme://host/path';
  await vscode.commands.registeredCallback!(FakeUri.file(path.join(fixtureDir, 'alpha.txt')), [
    FakeUri.file(path.join(fixtureDir, 'alpha.txt'))
  ]);
  assert.strictEqual(vscode.window.errorMessages.length, 1);
  assert.match(vscode.window.errorMessages[0], /must be a filesystem path, not a URI/);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function requireWithVscodeMock(modulePath: string, vscode: unknown): { activate(context: unknown): void } {
  const requireFromHere = createRequire(__filename);
  // The real (mutable) Module object, not esbuild's frozen ESM namespace.
  const moduleAny = requireFromHere('module') as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = moduleAny._load;
  moduleAny._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return requireFromHere(modulePath) as { activate(context: unknown): void };
  } finally {
    moduleAny._load = originalLoad;
  }
}

function createVscodeMock() {
  const vscode = {
    ProgressLocation: {
      Notification: 15
    },
    UIKind: {
      Desktop: 1,
      Web: 2
    },
    env: {
      uiKind: 1
    },
    ViewColumn: {
      Active: -1
    },
    Uri: {
      file(fsPath: string): FakeUri {
        return FakeUri.file(fsPath);
      }
    },
    commands: {
      registeredCommand: undefined as string | undefined,
      registeredCallback: undefined as
        | ((uri: FakeUri | undefined, selected: FakeUri[]) => Promise<void>)
        | undefined,
      executedCommands: [] as Array<{ command: string; resource?: unknown }>,
      registerCommand(command: string, callback: (uri: FakeUri | undefined, selected: FakeUri[]) => Promise<void>) {
        this.registeredCommand = command;
        this.registeredCallback = callback;
        return { dispose() {} };
      },
      executeCommand(command: string, resource?: unknown) {
        this.executedCommands.push({ command, resource });
        return Promise.resolve();
      }
    },
    workspace: {
      configuration: {
        tempDirectory: undefined as string | undefined
      },
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
      downloads: [] as RecordedDownload[],
      createWebviewPanel(viewType: string, title: string, showOptions: unknown, options: unknown) {
        assert.strictEqual(viewType, 'saveFilesAsZip.download');
        assert.match(title, /Downloading selected-files\.zip/);
        assert.deepStrictEqual(showOptions, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true });
        assert.deepStrictEqual(options, { enableScripts: true, retainContextWhenHidden: true });

        const downloads = this.downloads;
        let messageHandler: (message: { type: string }) => void;
        const panel = {
          webview: {
            html: '',
            onDidReceiveMessage(handler: (message: { type: string }) => void) {
              messageHandler = handler;
              queueMicrotask(() => messageHandler({ type: 'ready' }));
              return { dispose() {} };
            },
            postMessage(message: { type: string; filename: string; mimeType: string; base64: string }) {
              assert.strictEqual(message.type, 'download');
              assert.strictEqual(message.filename, 'selected-files.zip');
              assert.strictEqual(message.mimeType, 'application/zip');
              assert.ok(message.base64.length > 0);
              downloads.push({
                filename: message.filename,
                bytes: Buffer.from(message.base64, 'base64')
              });
              queueMicrotask(() => messageHandler({ type: 'done' }));
              return Promise.resolve(true);
            }
          },
          onDidDispose() {
            return { dispose() {} };
          },
          dispose() {}
        };
        return panel;
      },
      showErrorMessage(message: string) {
        this.errorMessages.push(message);
      },
      showInformationMessage(message: string) {
        this.informationMessages.push(message);
      },
      showWarningMessage(message: string) {
        this.warningMessages.push(message);
      },
      progressTitles: [] as string[],
      withProgress(
        options: { location: number; title: string },
        task: (progress: { report(value: unknown): void }) => Promise<unknown>
      ) {
        assert.strictEqual(options.location, vscode.ProgressLocation.Notification);
        this.progressTitles.push(options.title);
        return task({ report() {} });
      }
    }
  };

  return vscode;
}
