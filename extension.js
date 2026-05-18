const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { createZipBytesFromPaths } = require('./lib/zip');

const COMMAND_ID = 'saveFilesAsZip.saveAsZip';
const CONFIG_SECTION = 'saveFilesAsZip';
const TEMP_DIRECTORY_SETTING = 'tempDirectory';
const EXPLORER_DOWNLOAD_COMMAND = 'explorer.download';
const REVEAL_IN_EXPLORER_COMMAND = 'revealInExplorer';
const DEFAULT_TEMP_DOWNLOAD_DIR = '.save-files-as-zip';

function activate(context) {
  const disposable = vscode.commands.registerCommand(COMMAND_ID, async (uri, selectedUris) => {
    try {
      await saveAsZip(uri, selectedUris);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      vscode.window.showErrorMessage(`Download as Zip failed: ${message}`);
    }
  });

  context.subscriptions.push(disposable);
}

async function saveAsZip(uri, selectedUris) {
  const uris = getSelectedFileUris(uri, selectedUris);
  if (uris.length === 0) {
    vscode.window.showWarningMessage('Right-click one or more files or folders in the Explorer to save them as a zip.');
    return;
  }

  const selectedPaths = await removeNestedSelections(uris.map((item) => item.fsPath));
  const plan = await createArchivePlan(selectedPaths);
  const tempRootPath = resolveTempRootPath(plan.rootDir);

  const zipBytes = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating ${plan.filename}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: 'Collecting files...' });
      return createZipBytesFromPaths(selectedPaths, {
        rootDir: plan.rootDir,
        excludeBaseNames: [DEFAULT_TEMP_DOWNLOAD_DIR],
        excludePaths: [tempRootPath],
        onProgress: (completed, total, currentPath) => {
          const increment = total > 0 ? 100 / total : 0;
          progress.report({
            increment,
            message: `${completed}/${total} ${currentPath}`
          });
        }
      });
    }
  );

  const size = zipBytes.byteLength;
  await downloadZipFile(plan.filename, zipBytes, tempRootPath);
  vscode.window.showInformationMessage(`Downloaded ${plan.filename} (${formatBytes(size)}).`);
}

function getSelectedFileUris(uri, selectedUris) {
  const items = Array.isArray(selectedUris) && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  const seen = new Set();
  const fileUris = [];

  for (const item of items) {
    if (!item || item.scheme !== 'file' || !item.fsPath) {
      continue;
    }

    const resolved = path.resolve(item.fsPath);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      fileUris.push(item);
    }
  }

  return fileUris;
}

async function createArchivePlan(selectedPaths) {
  if (selectedPaths.length === 1) {
    const sourcePath = selectedPaths[0];
    const stat = await fs.promises.lstat(sourcePath);
    const parent = path.dirname(sourcePath);
    return { rootDir: parent, filename: getSingleArchiveName(sourcePath, stat) };
  }

  const rootDir = findCommonParent(selectedPaths);
  return {
    rootDir,
    filename: 'selected-files.zip'
  };
}

function getSingleArchiveName(sourcePath, stat) {
  const baseName = path.basename(sourcePath);
  if (stat.isDirectory()) {
    return `${baseName}.zip`;
  }

  const extension = path.extname(baseName);
  const baseWithoutExtension = extension ? baseName.slice(0, -extension.length) : baseName;
  const archiveName = `${baseWithoutExtension}.zip`;
  return archiveName === baseName ? `${baseWithoutExtension}-archive.zip` : archiveName;
}

async function removeNestedSelections(selectedPaths) {
  const withStats = await Promise.all(
    selectedPaths.map(async (sourcePath, index) => ({
      sourcePath: path.resolve(sourcePath),
      stat: await fs.promises.lstat(sourcePath),
      index
    }))
  );

  const kept = [];
  for (const item of withStats.sort((a, b) => a.sourcePath.length - b.sourcePath.length)) {
    const alreadyCovered = kept.some(
      (candidate) => candidate.stat.isDirectory() && isPathInside(candidate.sourcePath, item.sourcePath)
    );
    if (!alreadyCovered) {
      kept.push(item);
    }
  }

  const keptPaths = new Set(kept.map((item) => item.sourcePath));
  return withStats
    .sort((a, b) => a.index - b.index)
    .filter((item) => keptPaths.has(item.sourcePath))
    .map((item) => item.sourcePath);
}

function findCommonParent(selectedPaths) {
  const parentPaths = selectedPaths.map((sourcePath) => path.dirname(path.resolve(sourcePath)));
  if (parentPaths.length === 0) {
    return process.cwd();
  }

  const [first, ...rest] = parentPaths.map((parentPath) => splitPath(parentPath));
  let common = first;

  for (const parts of rest) {
    let index = 0;
    while (index < common.length && common[index] === parts[index]) {
      index += 1;
    }
    common = common.slice(0, index);
  }

  if (common.length === 0) {
    return path.parse(parentPaths[0]).root;
  }

  return common.length === 1 && common[0].endsWith(path.sep) ? common[0] : path.join(...common);
}

function splitPath(sourcePath) {
  const parsed = path.parse(sourcePath);
  const relativeParts = path.relative(parsed.root, sourcePath).split(path.sep).filter(Boolean);
  return [parsed.root, ...relativeParts];
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function downloadZipBytes(filename, bytes) {
  const panel = vscode.window.createWebviewPanel(
    'saveFilesAsZip.download',
    `Downloading ${filename}`,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const nonce = createNonce();
  const base64 = toBase64(bytes);

  panel.webview.html = createDownloadHtml(nonce);

  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error('Timed out while starting the browser download.'));
    }, 15000);

    const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'ready') {
        panel.webview.postMessage({
          type: 'download',
          filename,
          mimeType: 'application/zip',
          base64
        });
      } else if (message.type === 'done') {
        finish();
      } else if (message.type === 'error') {
        finish(new Error(message.message || 'Browser download failed.'));
      }
    });

    const disposeDisposable = panel.onDidDispose(() => {
      finish(new Error('Download webview was closed before the download started.'));
    });

    function finish(error) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      messageDisposable.dispose();
      disposeDisposable.dispose();
      if (error) {
        panel.dispose();
        reject(error);
      } else {
        setTimeout(() => panel.dispose(), 500);
        resolve();
      }
    }
  });
}

async function downloadZipFile(filename, bytes, tempRootPath) {
  if (isWebUi()) {
    await downloadZipBytesViaTempFile(filename, bytes, tempRootPath);
    return;
  }

  await downloadZipBytes(filename, bytes);
}

async function downloadZipBytesViaTempFile(filename, bytes, tempRootPath) {
  const tempSessionPath = path.join(tempRootPath || resolveTempRootPath(process.cwd()), createTempId());
  const tempZipPath = path.join(tempSessionPath, filename);

  await fs.promises.mkdir(tempSessionPath, { recursive: true });
  try {
    await fs.promises.writeFile(tempZipPath, bytes, { flag: 'wx' });
    await downloadViaExplorer(vscode.Uri.file(tempZipPath));
  } finally {
    await fs.promises.rm(tempSessionPath, { recursive: true, force: true });
    await removeEmptyTempRoot(path.dirname(tempSessionPath));
  }
}

function resolveTempRootPath(basePath) {
  const tempDirectory = getConfiguredTempDirectory();
  if (isUriString(tempDirectory)) {
    throw new Error('saveFilesAsZip.tempDirectory must be a filesystem path, not a URI.');
  }

  if (path.isAbsolute(tempDirectory)) {
    return path.resolve(tempDirectory);
  }

  return path.resolve(basePath || process.cwd(), tempDirectory);
}

function getConfiguredTempDirectory() {
  const configuration =
    vscode.workspace && typeof vscode.workspace.getConfiguration === 'function'
      ? vscode.workspace.getConfiguration(CONFIG_SECTION)
      : undefined;
  const configured =
    configuration && typeof configuration.get === 'function'
      ? configuration.get(TEMP_DIRECTORY_SETTING, DEFAULT_TEMP_DOWNLOAD_DIR)
      : DEFAULT_TEMP_DOWNLOAD_DIR;

  if (typeof configured !== 'string') {
    return DEFAULT_TEMP_DOWNLOAD_DIR;
  }

  const trimmed = configured.trim();
  return trimmed || DEFAULT_TEMP_DOWNLOAD_DIR;
}

function isUriString(value) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value);
}

async function downloadViaExplorer(resourceUri) {
  // VS Code Web starts downloads from the workbench window; webview downloads are sandboxed.
  await vscode.commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND, resourceUri);
  await delay(250);
  await vscode.commands.executeCommand(EXPLORER_DOWNLOAD_COMMAND);
}

function isWebUi() {
  return Boolean(vscode.env && vscode.UIKind && vscode.env.uiKind === vscode.UIKind.Web);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempId() {
  return `${Date.now().toString(36)}-${createNonce()}`;
}

async function removeEmptyTempRoot(tempRootPath) {
  try {
    const entries = await fs.promises.readdir(tempRootPath);
    if (entries.length === 0) {
      await fs.promises.rmdir(tempRootPath);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function createDownloadHtml(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';">
  <title>Downloading Zip</title>
</head>
<body>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'download') {
        return;
      }

      try {
        const binary = atob(message.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const blob = new Blob([bytes], { type: message.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = message.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => {
          URL.revokeObjectURL(url);
          vscode.postMessage({ type: 'done' });
        }, 100);
      } catch (error) {
        vscode.postMessage({
          type: 'error',
          message: error && error.message ? error.message : String(error)
        });
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function createNonce() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function formatBytes(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  saveAsZip,
  getSelectedFileUris,
  createArchivePlan,
  getSingleArchiveName,
  removeNestedSelections,
  findCommonParent,
  downloadZipFile,
  downloadZipBytes,
  formatBytes
};
