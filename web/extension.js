const vscode = require('vscode');

const COMMAND_ID = 'saveFilesAsZip.saveAsZip';
const CONFIG_SECTION = 'saveFilesAsZip';
const TEMP_DIRECTORY_SETTING = 'tempDirectory';
const EXPLORER_DOWNLOAD_COMMAND = 'explorer.download';
const REVEAL_IN_EXPLORER_COMMAND = 'revealInExplorer';
const DEFAULT_TEMP_DOWNLOAD_DIR = '.save-files-as-zip';
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const STORE = 0;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

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
  const uris = getSelectedUris(uri, selectedUris);
  if (uris.length === 0) {
    vscode.window.showWarningMessage('Right-click one or more files or folders in the Explorer to save them as a zip.');
    return;
  }

  ensureSameFileSystem(uris);
  const selectedItems = await removeNestedSelections(uris);
  const plan = await createArchivePlan(selectedItems);
  const tempRootUri = resolveTempRootUri(plan.rootUri);

  const zipBytes = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating ${plan.filename}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: 'Collecting files...' });
      return createZipFromUris(selectedItems, {
        rootUri: plan.rootUri,
        excludeBaseNames: [DEFAULT_TEMP_DOWNLOAD_DIR],
        excludeUris: [tempRootUri],
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

  await downloadZipFile(plan.filename, zipBytes, tempRootUri);
  vscode.window.showInformationMessage(`Downloaded ${plan.filename} (${formatBytes(zipBytes.byteLength)}).`);
}

function getSelectedUris(uri, selectedUris) {
  const items = Array.isArray(selectedUris) && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  const seen = new Set();
  const uris = [];

  for (const item of items) {
    if (!item || !item.scheme) {
      continue;
    }

    const key = item.toString();
    if (!seen.has(key)) {
      seen.add(key);
      uris.push(item);
    }
  }

  return uris;
}

async function createArchivePlan(selectedItems) {
  if (selectedItems.length === 1) {
    const item = selectedItems[0];
    const parentUri = dirname(item.uri);
    return { rootUri: parentUri, filename: getSingleArchiveName(item.uri, item.stat) };
  }

  const rootUri = findCommonParent(selectedItems.map((item) => item.uri));
  return {
    rootUri,
    filename: 'selected-files.zip'
  };
}

function getSingleArchiveName(uri, stat) {
  const baseName = basename(uri);
  if (isDirectory(stat)) {
    return `${baseName}.zip`;
  }

  const extension = extname(baseName);
  const baseWithoutExtension = extension ? baseName.slice(0, -extension.length) : baseName;
  const archiveName = `${baseWithoutExtension}.zip`;
  return archiveName === baseName ? `${baseWithoutExtension}-archive.zip` : archiveName;
}

async function removeNestedSelections(uris) {
  const withStats = await Promise.all(
    uris.map(async (uri, index) => ({
      uri,
      stat: await vscode.workspace.fs.stat(uri),
      index
    }))
  );

  const kept = [];
  for (const item of [...withStats].sort((a, b) => a.uri.path.length - b.uri.path.length)) {
    const alreadyCovered = kept.some(
      (candidate) => isDirectory(candidate.stat) && isPathInside(candidate.uri, item.uri)
    );
    if (!alreadyCovered) {
      kept.push(item);
    }
  }

  const keptKeys = new Set(kept.map((item) => item.uri.toString()));
  return withStats.filter((item) => keptKeys.has(item.uri.toString())).sort((a, b) => a.index - b.index);
}

async function createZipFromUris(selectedItems, options) {
  const rootUri = options.rootUri;
  const entries = [];
  const seenZipPaths = new Set();

  for (const item of selectedItems) {
    const relativePath = relativeUriPath(rootUri, item.uri);
    if (!relativePath) {
      throw new Error(`Selected item is outside the archive root: ${item.uri.toString()}`);
    }

    await collectUri(item.uri, toZipPath(relativePath), entries, seenZipPaths, options);
  }

  if (entries.length === 0) {
    throw new Error('The selected items did not contain any files or folders that can be zipped.');
  }

  return createZipBytes(entries, options);
}

async function collectUri(uri, zipPath, entries, seenZipPaths, options) {
  const stat = await vscode.workspace.fs.stat(uri);
  if (shouldExcludeUri(uri, options)) {
    return;
  }

  if (isSymbolicLink(stat)) {
    throw new Error(`Symbolic links are not supported: ${uri.toString()}`);
  }

  if (isDirectory(stat)) {
    const directoryZipPath = zipPath.endsWith('/') ? zipPath : `${zipPath}/`;
    addEntry(entries, seenZipPaths, {
      type: 'directory',
      uri,
      zipPath: directoryZipPath,
      stat
    });

    const children = await vscode.workspace.fs.readDirectory(uri);
    children.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name] of children) {
      await collectUri(
        vscode.Uri.joinPath(uri, name),
        `${directoryZipPath}${toZipPath(name)}`,
        entries,
        seenZipPaths,
        options
      );
    }
    return;
  }

  if (isFile(stat)) {
    addEntry(entries, seenZipPaths, {
      type: 'file',
      uri,
      zipPath,
      stat
    });
  }
}

function shouldExcludeUri(uri, options) {
  if (Array.isArray(options.excludeUris) && options.excludeUris.length > 0) {
    for (const excludeUri of options.excludeUris) {
      if (isSameUri(excludeUri, uri) || isPathInside(excludeUri, uri)) {
        return true;
      }
    }
  }

  return (
    Array.isArray(options.excludeBaseNames) &&
    options.excludeBaseNames.length > 0 &&
    options.excludeBaseNames.includes(basename(uri))
  );
}

function addEntry(entries, seenZipPaths, entry) {
  if (seenZipPaths.has(entry.zipPath)) {
    return;
  }
  seenZipPaths.add(entry.zipPath);
  entries.push(entry);
}

async function createZipBytes(entries, options) {
  if (entries.length > MAX_UINT16) {
    throw new Error('Zip archives with more than 65535 entries are not supported.');
  }

  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const record = await createLocalEntry(entry, offset);
    chunks.push(record.header, record.nameBytes, record.data);
    centralDirectory.push(record);
    offset += record.header.length + record.nameBytes.length + record.data.length;

    if (typeof options.onProgress === 'function') {
      options.onProgress(index + 1, entries.length, entry.zipPath);
    }
  }

  const centralDirectoryOffset = offset;
  for (const record of centralDirectory) {
    const centralHeader = createCentralDirectoryHeader(record);
    chunks.push(centralHeader, record.nameBytes);
    offset += centralHeader.length + record.nameBytes.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  chunks.push(createEndOfCentralDirectoryRecord(centralDirectory.length, centralDirectorySize, centralDirectoryOffset));
  return concatUint8Arrays(chunks);
}

async function createLocalEntry(entry, offset) {
  const nameBytes = textEncoder().encode(entry.zipPath);
  assertUInt16(nameBytes.length, `Zip path is too long: ${entry.zipPath}`);

  const data = entry.type === 'file' ? await vscode.workspace.fs.readFile(entry.uri) : new Uint8Array(0);
  assertUInt32(data.length, `File is too large for this zip writer: ${entry.uri.toString()}`);
  assertUInt32(offset, 'Zip archive is too large for this zip writer.');

  const { dosTime, dosDate } = toDosDateTime(new Date(entry.stat.mtime));
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, STORE, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc32(data), true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);

  return {
    header,
    nameBytes,
    data,
    method: STORE,
    crc32: crc32(data),
    compressedSize: data.length,
    uncompressedSize: data.length,
    dosTime,
    dosDate,
    localHeaderOffset: offset,
    externalAttributes: entry.type === 'directory' ? 0x10 : 0
  };
}

function createCentralDirectoryHeader(record) {
  assertUInt32(record.localHeaderOffset, 'Zip archive is too large for this zip writer.');

  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0x031e, true);
  view.setUint16(6, VERSION_NEEDED, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, record.method, true);
  view.setUint16(12, record.dosTime, true);
  view.setUint16(14, record.dosDate, true);
  view.setUint32(16, record.crc32, true);
  view.setUint32(20, record.compressedSize, true);
  view.setUint32(24, record.uncompressedSize, true);
  view.setUint16(28, record.nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, record.externalAttributes, true);
  view.setUint32(42, record.localHeaderOffset, true);
  return header;
}

function createEndOfCentralDirectoryRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
  assertUInt16(entryCount, 'Zip archive has too many entries.');
  assertUInt32(centralDirectorySize, 'Zip archive is too large for this zip writer.');
  assertUInt32(centralDirectoryOffset, 'Zip archive is too large for this zip writer.');

  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectorySize, true);
  view.setUint32(16, centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

function ensureSameFileSystem(uris) {
  const first = uris[0];
  for (const uri of uris) {
    if (uri.scheme !== first.scheme || uri.authority !== first.authority) {
      throw new Error('All selected items must be from the same workspace file system.');
    }
  }
}

function findCommonParent(uris) {
  const parentPaths = uris.map((uri) => dirname(uri).path);
  const first = splitPath(parentPaths[0]);
  let common = first;

  for (const parentPath of parentPaths.slice(1)) {
    const parts = splitPath(parentPath);
    let index = 0;
    while (index < common.length && common[index] === parts[index]) {
      index += 1;
    }
    common = common.slice(0, index);
  }

  const path = common.length === 0 ? '/' : `/${common.join('/')}`;
  return uris[0].with({ path });
}

function relativeUriPath(rootUri, uri) {
  if (rootUri.scheme !== uri.scheme || rootUri.authority !== uri.authority) {
    return undefined;
  }

  const rootPath = stripTrailingSlash(rootUri.path);
  const targetPath = stripTrailingSlash(uri.path);
  if (targetPath === rootPath) {
    return undefined;
  }

  const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
  if (!targetPath.startsWith(prefix)) {
    return undefined;
  }

  return targetPath.slice(prefix.length);
}

function dirname(uri) {
  const cleanPath = stripTrailingSlash(uri.path);
  const slashIndex = cleanPath.lastIndexOf('/');
  const parentPath = slashIndex <= 0 ? '/' : cleanPath.slice(0, slashIndex);
  return uri.with({ path: parentPath });
}

function basename(uri) {
  const cleanPath = stripTrailingSlash(uri.path);
  const slashIndex = cleanPath.lastIndexOf('/');
  return slashIndex < 0 ? cleanPath : cleanPath.slice(slashIndex + 1);
}

function extname(fileName) {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(dotIndex) : '';
}

function isPathInside(parentUri, childUri) {
  if (parentUri.scheme !== childUri.scheme || parentUri.authority !== childUri.authority) {
    return false;
  }

  const parentPath = stripTrailingSlash(parentUri.path);
  const childPath = stripTrailingSlash(childUri.path);
  if (parentPath === childPath) {
    return false;
  }

  return childPath.startsWith(parentPath === '/' ? '/' : `${parentPath}/`);
}

function isSameUri(first, second) {
  return (
    first.scheme === second.scheme &&
    first.authority === second.authority &&
    stripTrailingSlash(first.path) === stripTrailingSlash(second.path)
  );
}

function isFile(stat) {
  return Boolean(stat.type & vscode.FileType.File);
}

function isDirectory(stat) {
  return Boolean(stat.type & vscode.FileType.Directory);
}

function isSymbolicLink(stat) {
  return Boolean(stat.type & vscode.FileType.SymbolicLink);
}

function splitPath(sourcePath) {
  return sourcePath.split('/').filter(Boolean);
}

function stripTrailingSlash(sourcePath) {
  return sourcePath.length > 1 ? sourcePath.replace(/\/+$/, '') : sourcePath;
}

function toZipPath(sourcePath) {
  return sourcePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function toDosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    dosTime: (hours << 11) | (minutes << 5) | seconds,
    dosDate: ((year - 1980) << 9) | (month << 5) | day
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  assertUInt32(totalLength, 'Zip archive is too large for this zip writer.');

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function textEncoder() {
  return new TextEncoder();
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

async function downloadZipFile(filename, bytes, tempRootUri) {
  if (isWebUi()) {
    await downloadZipBytesViaTempFile(filename, bytes, tempRootUri);
    return;
  }

  await downloadZipBytes(filename, bytes);
}

async function downloadZipBytesViaTempFile(filename, bytes, tempRootUri) {
  const tempRoot = tempRootUri || resolveTempRootUri(getWorkspaceRootUri());
  const tempDir = vscode.Uri.joinPath(tempRoot, createTempId());
  const tempZipUri = vscode.Uri.joinPath(tempDir, filename);

  await vscode.workspace.fs.createDirectory(tempDir);
  try {
    await vscode.workspace.fs.writeFile(tempZipUri, bytes);
    await downloadViaExplorer(tempZipUri);
  } finally {
    await deleteUri(tempDir, { recursive: true });
    await removeEmptyTempRoot(tempRoot);
  }
}

function resolveTempRootUri(baseRootUri) {
  const tempDirectory = getConfiguredTempDirectory();
  if (isUriString(tempDirectory)) {
    throw new Error('saveFilesAsZip.tempDirectory must be a filesystem path, not a URI.');
  }

  const normalized = tempDirectory.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.startsWith('/')) {
    return baseRootUri.with({ path: normalizeAbsoluteUriPath(normalized) });
  }

  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? vscode.Uri.joinPath(baseRootUri, ...parts) : baseRootUri;
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

function normalizeAbsoluteUriPath(sourcePath) {
  const segments = [];
  for (const segment of sourcePath.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  return `/${segments.join('/')}`;
}

function getWorkspaceRootUri() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open.');
  }
  return folders[0].uri;
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

async function removeEmptyTempRoot(tempRoot) {
  try {
    const entries = await vscode.workspace.fs.readDirectory(tempRoot);
    if (entries.length === 0) {
      await deleteUri(tempRoot, { recursive: false });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

async function deleteUri(uri, options) {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: options.recursive, useTrash: false });
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
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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

function assertUInt16(value, message) {
  if (value > MAX_UINT16) {
    throw new Error(message);
  }
}

function assertUInt32(value, message) {
  if (value > MAX_UINT32) {
    throw new Error(message);
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  downloadZipFile,
  downloadZipBytes
};
