const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const STORE = 0;
const DEFLATE = 8;
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

async function createZipFromPaths(sourcePaths, outputPath, options = {}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('No files or folders were selected.');
  }

  const resolvedOutputPath = path.resolve(outputPath);
  const rootDir = path.resolve(options.rootDir || inferRootDir(sourcePaths));
  const entries = await collectEntries(sourcePaths, rootDir, resolvedOutputPath, options);
  if (entries.length === 0) {
    throw new Error('The selected items did not contain any files or folders that can be zipped.');
  }

  await writeZip(entries, resolvedOutputPath, options);
  return {
    entries: entries.length,
    outputPath: resolvedOutputPath
  };
}

async function createZipBytesFromPaths(sourcePaths, options = {}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('No files or folders were selected.');
  }

  const rootDir = path.resolve(options.rootDir || inferRootDir(sourcePaths));
  const entries = await collectEntries(sourcePaths, rootDir, undefined, options);
  if (entries.length === 0) {
    throw new Error('The selected items did not contain any files or folders that can be zipped.');
  }

  return buildZipBuffer(entries, options);
}

function inferRootDir(sourcePaths) {
  if (sourcePaths.length === 1) {
    return path.dirname(path.resolve(sourcePaths[0]));
  }

  const parentPaths = sourcePaths.map((sourcePath) => path.dirname(path.resolve(sourcePath)));
  return commonPath(parentPaths);
}

async function collectEntries(sourcePaths, rootDir, outputPath, options = {}) {
  const entries = [];
  const seenZipPaths = new Set();
  const resolvedOutputPath = outputPath ? path.resolve(outputPath) : undefined;

  for (const sourcePath of sourcePaths) {
    const resolvedSourcePath = path.resolve(sourcePath);
    const relativePath = path.relative(rootDir, resolvedSourcePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Selected item is outside the archive root: ${sourcePath}`);
    }

    await collectPath(resolvedSourcePath, toZipPath(relativePath), resolvedOutputPath, entries, seenZipPaths, options);
  }

  return entries;
}

async function collectPath(sourcePath, zipPath, outputPath, entries, seenZipPaths, options) {
  const stat = await fs.promises.lstat(sourcePath);
  const resolvedSourcePath = path.resolve(sourcePath);

  if (resolvedSourcePath === outputPath || shouldExcludePath(sourcePath, options)) {
    return;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not supported: ${sourcePath}`);
  }

  if (stat.isDirectory()) {
    const directoryZipPath = zipPath.endsWith('/') ? zipPath : `${zipPath}/`;
    addEntry(entries, seenZipPaths, {
      type: 'directory',
      sourcePath,
      zipPath: directoryZipPath,
      stat
    });

    const children = await fs.promises.readdir(sourcePath, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      await collectPath(
        path.join(sourcePath, child.name),
        `${directoryZipPath}${toZipPath(child.name)}`,
        outputPath,
        entries,
        seenZipPaths,
        options
      );
    }
    return;
  }

  if (stat.isFile()) {
    addEntry(entries, seenZipPaths, {
      type: 'file',
      sourcePath,
      zipPath,
      stat
    });
  }
}

async function buildZipBuffer(entries, options = {}) {
  if (entries.length > MAX_UINT16) {
    throw new Error('Zip archives with more than 65535 entries are not supported.');
  }

  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const record = await createLocalEntryBuffer(entry, offset);
    chunks.push(record.header, record.nameBytes);
    if (record.data.length > 0) {
      chunks.push(record.data);
    }
    centralDirectory.push(record);
    offset += record.localHeaderSize + record.compressedSize;

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
  return Buffer.concat(chunks);
}

async function createLocalEntryBuffer(entry, offset) {
  const nameBytes = Buffer.from(entry.zipPath, 'utf8');
  assertUInt16(nameBytes.length, `Zip path is too long: ${entry.zipPath}`);

  const { dosTime, dosDate } = toDosDateTime(entry.stat.mtime);
  const payload = entry.type === 'file' ? await createFilePayload(entry.sourcePath) : createDirectoryPayload();
  assertUInt32(payload.uncompressedSize, `File is too large for this zip writer: ${entry.sourcePath}`);
  assertUInt32(payload.compressedSize, `Compressed file is too large for this zip writer: ${entry.sourcePath}`);
  assertUInt32(offset, 'Zip archive is too large for this zip writer.');

  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(payload.method, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(payload.crc32, 14);
  header.writeUInt32LE(payload.compressedSize, 18);
  header.writeUInt32LE(payload.uncompressedSize, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);

  return {
    header,
    nameBytes,
    data: payload.data,
    method: payload.method,
    crc32: payload.crc32,
    compressedSize: payload.compressedSize,
    uncompressedSize: payload.uncompressedSize,
    dosTime,
    dosDate,
    localHeaderOffset: offset,
    localHeaderSize: header.length + nameBytes.length,
    externalAttributes: getExternalAttributes(entry)
  };
}

function addEntry(entries, seenZipPaths, entry) {
  if (seenZipPaths.has(entry.zipPath)) {
    return;
  }
  seenZipPaths.add(entry.zipPath);
  entries.push(entry);
}

function shouldExcludePath(sourcePath, options) {
  if (Array.isArray(options.excludePaths) && options.excludePaths.length > 0) {
    const resolvedSourcePath = path.resolve(sourcePath);
    for (const excludePath of options.excludePaths) {
      if (!excludePath) {
        continue;
      }

      const resolvedExcludePath = path.resolve(excludePath);
      if (resolvedSourcePath === resolvedExcludePath || isPathInside(resolvedExcludePath, resolvedSourcePath)) {
        return true;
      }
    }
  }

  return (
    Array.isArray(options.excludeBaseNames) &&
    options.excludeBaseNames.length > 0 &&
    options.excludeBaseNames.includes(path.basename(sourcePath))
  );
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function writeZip(entries, outputPath, options = {}) {
  if (entries.length > MAX_UINT16) {
    throw new Error('Zip archives with more than 65535 entries are not supported.');
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  const stream = fs.createWriteStream(tempPath, { flags: 'wx' });
  const centralDirectory = [];
  let offset = 0;

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const record = await writeLocalEntry(stream, entry, offset);
      centralDirectory.push(record);
      offset += record.localHeaderSize + record.compressedSize;

      if (typeof options.onProgress === 'function') {
        options.onProgress(index + 1, entries.length, entry.zipPath);
      }
    }

    const centralDirectoryOffset = offset;
    for (const record of centralDirectory) {
      const centralHeader = createCentralDirectoryHeader(record);
      await writeBuffer(stream, centralHeader);
      await writeBuffer(stream, record.nameBytes);
      offset += centralHeader.length + record.nameBytes.length;
    }

    const centralDirectorySize = offset - centralDirectoryOffset;
    const endRecord = createEndOfCentralDirectoryRecord(
      centralDirectory.length,
      centralDirectorySize,
      centralDirectoryOffset
    );
    await writeBuffer(stream, endRecord);
    await finishStream(stream);
    await replaceFile(tempPath, outputPath);
  } catch (error) {
    stream.destroy();
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

async function writeLocalEntry(stream, entry, offset) {
  const nameBytes = Buffer.from(entry.zipPath, 'utf8');
  assertUInt16(nameBytes.length, `Zip path is too long: ${entry.zipPath}`);

  const { dosTime, dosDate } = toDosDateTime(entry.stat.mtime);
  const payload = entry.type === 'file' ? await createFilePayload(entry.sourcePath) : createDirectoryPayload();
  assertUInt32(payload.uncompressedSize, `File is too large for this zip writer: ${entry.sourcePath}`);
  assertUInt32(payload.compressedSize, `Compressed file is too large for this zip writer: ${entry.sourcePath}`);
  assertUInt32(offset, 'Zip archive is too large for this zip writer.');

  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(payload.method, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(payload.crc32, 14);
  header.writeUInt32LE(payload.compressedSize, 18);
  header.writeUInt32LE(payload.uncompressedSize, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);

  await writeBuffer(stream, header);
  await writeBuffer(stream, nameBytes);
  if (payload.data.length > 0) {
    await writeBuffer(stream, payload.data);
  }

  return {
    nameBytes,
    method: payload.method,
    crc32: payload.crc32,
    compressedSize: payload.compressedSize,
    uncompressedSize: payload.uncompressedSize,
    dosTime,
    dosDate,
    localHeaderOffset: offset,
    localHeaderSize: header.length + nameBytes.length,
    externalAttributes: getExternalAttributes(entry)
  };
}

async function createFilePayload(sourcePath) {
  const source = await fs.promises.readFile(sourcePath);
  const compressed = zlib.deflateRawSync(source, { level: 9 });
  const useCompressed = compressed.length < source.length;
  const data = useCompressed ? compressed : source;

  return {
    method: useCompressed ? DEFLATE : STORE,
    data,
    crc32: crc32(source),
    compressedSize: data.length,
    uncompressedSize: source.length
  };
}

function createDirectoryPayload() {
  return {
    method: STORE,
    data: Buffer.alloc(0),
    crc32: 0,
    compressedSize: 0,
    uncompressedSize: 0
  };
}

function createCentralDirectoryHeader(record) {
  assertUInt32(record.localHeaderOffset, 'Zip archive is too large for this zip writer.');

  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(0x031e, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(record.dosTime, 12);
  header.writeUInt16LE(record.dosDate, 14);
  header.writeUInt32LE(record.crc32, 16);
  header.writeUInt32LE(record.compressedSize, 20);
  header.writeUInt32LE(record.uncompressedSize, 24);
  header.writeUInt16LE(record.nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(record.externalAttributes, 38);
  header.writeUInt32LE(record.localHeaderOffset, 42);
  return header;
}

function createEndOfCentralDirectoryRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
  assertUInt16(entryCount, 'Zip archive has too many entries.');
  assertUInt32(centralDirectorySize, 'Zip archive is too large for this zip writer.');
  assertUInt32(centralDirectoryOffset, 'Zip archive is too large for this zip writer.');

  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralDirectorySize, 12);
  record.writeUInt32LE(centralDirectoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function getExternalAttributes(entry) {
  const unixMode = (entry.stat.mode & 0xffff) << 16;
  if (entry.type === 'directory') {
    return (unixMode | 0x10) >>> 0;
  }
  return unixMode >>> 0;
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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeBuffer(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function finishStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

async function replaceFile(tempPath, outputPath) {
  try {
    await fs.promises.rename(tempPath, outputPath);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      await fs.promises.rm(outputPath, { force: true });
      await fs.promises.rename(tempPath, outputPath);
      return;
    }
    throw error;
  }
}

function toZipPath(sourcePath) {
  return sourcePath.split(path.sep).join('/');
}

function commonPath(sourcePaths) {
  const [first, ...rest] = sourcePaths.map((sourcePath) => splitPath(path.resolve(sourcePath)));
  let common = first;

  for (const parts of rest) {
    let index = 0;
    while (index < common.length && common[index] === parts[index]) {
      index += 1;
    }
    common = common.slice(0, index);
  }

  if (common.length === 0) {
    return path.parse(sourcePaths[0]).root;
  }

  return common.length === 1 && common[0].endsWith(path.sep) ? common[0] : path.join(...common);
}

function splitPath(sourcePath) {
  const parsed = path.parse(sourcePath);
  const relativeParts = path.relative(parsed.root, sourcePath).split(path.sep).filter(Boolean);
  return [parsed.root, ...relativeParts];
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

module.exports = {
  createZipFromPaths,
  createZipBytesFromPaths,
  collectEntries,
  crc32
};
