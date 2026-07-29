const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');
const { runServer } = require('@vscode/test-web/out/server/main');
const { downloadAndUnzipVSCode } = require('@vscode/test-web/out/server/download');

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const STORE = 0;
const DEFLATE = 8;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const testRunnerDataDir = path.join(rootDir, '.vscode-test-web');
  const downloadsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-files-as-zip-downloads-'));
  const host = 'localhost';
  const port = await findAvailablePort(host, 3012);
  const build = await getBuild(testRunnerDataDir);
  const server = await runServer(host, port, {
    extensionDevelopmentPath: rootDir,
    extensionTestsPath: path.join(rootDir, 'dist/web/test/suite/index.js'),
    build,
    folderMountPath: path.join(rootDir, 'test-fixtures/workspace'),
    printServerLog: false
  });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      downloadsPath: downloadsDir
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: null
    });
    const page = await context.newPage();
    const downloadPromises = [];
    const pageErrors = [];

    page.on('download', (download) => {
      downloadPromises.push(saveDownload(download, downloadsDir));
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error);
    });

    await page.exposeFunction('codeAutomationLog', (type, args) => {
      const logger = console[type] || console.log;
      logger(...args);
    });

    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const timeout = setTimeout(() => {
      rejectDone(new Error('Timed out waiting for VS Code Web extension tests to finish.'));
    }, 60000);

    await page.exposeFunction('codeAutomationExit', async (code) => {
      try {
        if (code !== 0) {
          throw new Error(`VS Code Web extension tests exited with code ${code}.`);
        }

        const downloads = await waitForDownloads(downloadPromises, 3);
        assertDownloadedArchives(downloads);
        if (pageErrors.length > 0) {
          throw pageErrors[0];
        }

        clearTimeout(timeout);
        resolveDone(downloads);
      } catch (error) {
        clearTimeout(timeout);
        rejectDone(error);
      }
    });

    await page.goto(`http://${host}:${port}`, { waitUntil: 'domcontentloaded' });
    const downloads = await done;
    console.log(`web download smoke passed: ${downloads.map((download) => download.filename).join(', ')}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    server.close();
    await fs.promises.rm(downloadsDir, { recursive: true, force: true });
  }
}

async function getBuild(testRunnerDataDir) {
  const cached = await findCachedBuild(testRunnerDataDir);
  if (cached) {
    return cached;
  }

  return downloadAndUnzipVSCode(testRunnerDataDir, 'insider');
}

async function findCachedBuild(testRunnerDataDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(testRunnerDataDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const builds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const match = /^vscode-web-(stable|insider)-(.+)$/.exec(entry.name);
    if (!match) {
      continue;
    }

    const location = path.join(testRunnerDataDir, entry.name);
    const versionFile = path.join(location, 'version');
    try {
      const stat = await fs.promises.stat(versionFile);
      builds.push({
        type: 'static',
        location,
        quality: match[1],
        version: match[2],
        mtimeMs: stat.mtimeMs
      });
    } catch {
      // Ignore partial downloads.
    }
  }

  builds.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (builds.length === 0) {
    return undefined;
  }

  const { mtimeMs, ...build } = builds[0];
  return build;
}

async function saveDownload(download, downloadsDir) {
  const filename = download.suggestedFilename();
  const targetPath = path.join(downloadsDir, filename);
  await download.saveAs(targetPath);
  return { filename, path: targetPath };
}

async function waitForDownloads(downloadPromises, expectedCount) {
  const startedAt = Date.now();
  while (downloadPromises.length < expectedCount) {
    if (Date.now() - startedAt > 15000) {
      throw new Error(`Expected ${expectedCount} browser downloads, saw ${downloadPromises.length}.`);
    }
    await delay(100);
  }

  return Promise.all(downloadPromises);
}

function assertDownloadedArchives(downloads) {
  const byName = new Map(downloads.map((download) => [download.filename, download.path]));
  assert.deepStrictEqual([...byName.keys()].sort(), ['folder-to-zip.zip', 'selected-files.zip', 'single-file.zip']);
  assertZipEntries(fs.readFileSync(byName.get('single-file.zip')), ['single-file.txt']);
  assertZipEntries(fs.readFileSync(byName.get('selected-files.zip')), [
    'multi-one.txt',
    'multi-two.txt',
    'folder-to-zip/',
    'folder-to-zip/nested/',
    'folder-to-zip/nested/data.json',
    'folder-to-zip/nested/table.csv',
    'folder-to-zip/notes.md'
  ]);
  assertZipEntries(fs.readFileSync(byName.get('folder-to-zip.zip')), [
    'folder-to-zip/',
    'folder-to-zip/nested/',
    'folder-to-zip/nested/data.json',
    'folder-to-zip/nested/table.csv',
    'folder-to-zip/notes.md'
  ]);
}

function assertZipEntries(bytes, expectedNames) {
  const names = readZipEntryNames(bytes);
  assert.deepStrictEqual(names, expectedNames);
}

function readZipEntryNames(bytes) {
  const names = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset < bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature === CENTRAL_DIRECTORY_SIGNATURE) {
      break;
    }

    assert.strictEqual(signature, LOCAL_FILE_HEADER_SIGNATURE);
    const method = view.getUint16(offset + 8, true);
    const expectedCrc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressedData = bytes.subarray(dataStart, dataStart + compressedSize);

    // Verify actual archive integrity, not just entry names: decompress and
    // check the CRC so a broken writer cannot pass the smoke test.
    let data;
    if (method === STORE) {
      data = compressedData;
    } else if (method === DEFLATE) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unexpected compression method ${method} for ${name}`);
    }
    assert.strictEqual(data.length, uncompressedSize, `uncompressed size mismatch for ${name}`);
    assert.strictEqual(crc32(data), expectedCrc, `crc mismatch for ${name}`);

    names.push(name);
    offset = dataStart + compressedSize;
  }

  return names;
}

function findAvailablePort(host, startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          tryPort(port + 1);
        } else {
          reject(error);
        }
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, host);
    };

    tryPort(startPort);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
