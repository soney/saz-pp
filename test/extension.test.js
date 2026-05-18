const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const STORE = 0;
const DEFLATE = 8;

async function main() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-files-as-zip-command-'));
  const fixtureDir = path.join(tempDir, 'fixture');
  const nestedDir = path.join(fixtureDir, 'nested');
  await fs.promises.mkdir(nestedDir, { recursive: true });
  await fs.promises.writeFile(path.join(fixtureDir, 'alpha.txt'), 'alpha\n');
  await fs.promises.writeFile(path.join(nestedDir, 'beta.txt'), 'beta\n');

  const vscode = createVscodeMock();
  const extension = requireWithVscodeMock('../extension', vscode);
  const context = { subscriptions: [] };
  extension.activate(context);

  assert.strictEqual(vscode.commands.registeredCommand, 'saveFilesAsZip.saveAsZip');
  assert.strictEqual(context.subscriptions.length, 1);

  await vscode.commands.registeredCallback(vscode.Uri.file(path.join(fixtureDir, 'alpha.txt')), [
    vscode.Uri.file(path.join(fixtureDir, 'alpha.txt')),
    vscode.Uri.file(nestedDir)
  ]);

  const outputPath = path.join(fixtureDir, 'selected-files.zip');
  assert.strictEqual(fs.existsSync(outputPath), false);
  assert.strictEqual(vscode.window.downloads.length, 1);
  assert.strictEqual(vscode.window.downloads[0].filename, 'selected-files.zip');
  const entries = readZipEntries(vscode.window.downloads[0].bytes);
  assert.deepStrictEqual(Object.keys(entries), ['alpha.txt', 'nested/', 'nested/beta.txt']);
  assert.strictEqual(entries['alpha.txt'].toString(), 'alpha\n');
  assert.strictEqual(entries['nested/beta.txt'].toString(), 'beta\n');
  assert.strictEqual(vscode.window.informationMessages.length, 1);
  assert.match(vscode.window.informationMessages[0], /Downloaded selected-files\.zip/);

  vscode.env.uiKind = vscode.UIKind.Web;
  vscode.workspace.configuration.tempDirectory = path.join(tempDir, 'absolute-temp-zips');
  vscode.commands.executedCommands.length = 0;
  await vscode.commands.registeredCallback(vscode.Uri.file(path.join(fixtureDir, 'alpha.txt')), [
    vscode.Uri.file(path.join(fixtureDir, 'alpha.txt')),
    vscode.Uri.file(nestedDir)
  ]);

  assert.strictEqual(fs.existsSync(outputPath), false);
  assert.strictEqual(fs.existsSync(vscode.workspace.configuration.tempDirectory), false);
  assert.strictEqual(vscode.commands.executedCommands.length, 2);
  assert.strictEqual(vscode.commands.executedCommands[0].command, 'revealInExplorer');
  assert.ok(
    vscode.commands.executedCommands[0].resource.fsPath.startsWith(
      `${vscode.workspace.configuration.tempDirectory}${path.sep}`
    )
  );
  assert.strictEqual(path.basename(vscode.commands.executedCommands[0].resource.fsPath), 'selected-files.zip');
  assert.strictEqual(vscode.commands.executedCommands[1].command, 'explorer.download');

  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

function requireWithVscodeMock(modulePath, vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
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
      file(fsPath) {
        return {
          scheme: 'file',
          fsPath
        };
      }
    },
    commands: {
      registeredCommand: undefined,
      registeredCallback: undefined,
      executedCommands: [],
      registerCommand(command, callback) {
        this.registeredCommand = command;
        this.registeredCallback = callback;
        return { dispose() {} };
      },
      executeCommand(command, resource) {
        this.executedCommands.push({ command, resource });
        return Promise.resolve();
      }
    },
    workspace: {
      configuration: {
        tempDirectory: undefined
      },
      getConfiguration(section) {
        assert.strictEqual(section, 'saveFilesAsZip');
        return {
          get: (key, defaultValue) => {
            assert.strictEqual(key, 'tempDirectory');
            return this.configuration.tempDirectory === undefined ? defaultValue : this.configuration.tempDirectory;
          }
        };
      },
      asRelativePath(sourcePath) {
        return sourcePath;
      }
    },
    window: {
      informationMessages: [],
      downloads: [],
      createWebviewPanel(viewType, title, showOptions, options) {
        assert.strictEqual(viewType, 'saveFilesAsZip.download');
        assert.match(title, /Downloading selected-files\.zip/);
        assert.deepStrictEqual(showOptions, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true });
        assert.deepStrictEqual(options, { enableScripts: true, retainContextWhenHidden: true });

        let messageHandler;
        const panel = {
          webview: {
            html: '',
            onDidReceiveMessage(handler) {
              messageHandler = handler;
              queueMicrotask(() => messageHandler({ type: 'ready' }));
              return { dispose() {} };
            },
            postMessage(message) {
              assert.strictEqual(message.type, 'download');
              assert.strictEqual(message.filename, 'selected-files.zip');
              assert.strictEqual(message.mimeType, 'application/zip');
              assert.ok(message.base64.length > 0);
              this.downloads.push({
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
        panel.webview.downloads = this.downloads;
        return panel;
      },
      showErrorMessage(message) {
        throw new Error(message);
      },
      showInformationMessage(message) {
        this.informationMessages.push(message);
      },
      showWarningMessage() {
        throw new Error('Unexpected warning prompt');
      },
      withProgress(options, task) {
        assert.strictEqual(options.location, vscode.ProgressLocation.Notification);
        assert.match(options.title, /Creating selected-files\.zip/);
        return task({ report() {} });
      }
    }
  };

  return vscode;
}

function readZipEntries(buffer) {
  const entries = {};
  let offset = 0;

  while (offset < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === CENTRAL_DIRECTORY_SIGNATURE) {
      break;
    }
    assert.strictEqual(signature, LOCAL_FILE_HEADER_SIGNATURE);

    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === STORE) {
      entries[name] = Buffer.from(compressedData);
    } else if (method === DEFLATE) {
      entries[name] = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unexpected compression method ${method}`);
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}

main()
  .then(() => {
    console.log('extension command test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
