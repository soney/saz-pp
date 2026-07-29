import type { ProgressCallback, ZipEntryInput } from './types';
import { concatUint8Arrays } from './util';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_MADE_BY = 0x031e;
const VERSION_NEEDED = 20;
const STORE = 0;
const DEFLATE = 8;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const DEFAULT_FILE_MODE = 0o100644;
const DEFAULT_DIRECTORY_MODE = 0o40755;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface BuildZipOptions {
  deflateRaw?: (data: Uint8Array) => Promise<Uint8Array | undefined>;
  onProgress?: ProgressCallback;
}

interface EntryRecord {
  nameBytes: Uint8Array;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

export async function buildZip(entries: ZipEntryInput[], options: BuildZipOptions = {}): Promise<Uint8Array> {
  if (entries.length === 0) {
    throw new Error('The selected items did not contain any files or folders that can be zipped.');
  }
  if (entries.length > MAX_UINT16) {
    throw new Error('Zip archives with more than 65535 entries are not supported.');
  }

  const textEncoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralDirectory: EntryRecord[] = [];
  let offset = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const nameBytes = textEncoder.encode(entry.zipPath);
    assertUInt16(nameBytes.length, `Zip path is too long: ${entry.zipPath}`);

    const payload = await createPayload(entry, options.deflateRaw);
    assertUInt32(payload.uncompressedSize, `File is too large for this zip writer: ${entry.displayPath}`);
    assertUInt32(payload.compressedSize, `Compressed file is too large for this zip writer: ${entry.displayPath}`);
    assertUInt32(offset, 'Zip archive is too large for this zip writer.');

    const { dosTime, dosDate } = toDosDateTime(new Date(entry.mtimeMs));
    const record: EntryRecord = {
      nameBytes,
      method: payload.method,
      crc32: payload.crc32,
      compressedSize: payload.compressedSize,
      uncompressedSize: payload.uncompressedSize,
      dosTime,
      dosDate,
      localHeaderOffset: offset,
      externalAttributes: getExternalAttributes(entry)
    };

    const header = createLocalFileHeader(record);
    chunks.push(header, nameBytes);
    if (payload.data.length > 0) {
      chunks.push(payload.data);
    }
    centralDirectory.push(record);
    offset += header.length + nameBytes.length + payload.data.length;

    if (options.onProgress) {
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
  return concatUint8Arrays(chunks, (total) => assertUInt32(total, 'Zip archive is too large for this zip writer.'));
}

interface EntryPayload {
  method: number;
  data: Uint8Array;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}

async function createPayload(
  entry: ZipEntryInput,
  deflateRaw: BuildZipOptions['deflateRaw']
): Promise<EntryPayload> {
  if (entry.kind === 'directory' || !entry.getData) {
    return { method: STORE, data: new Uint8Array(0), crc32: 0, compressedSize: 0, uncompressedSize: 0 };
  }

  const source = await entry.getData();
  const compressed = deflateRaw ? await deflateRaw(source) : undefined;
  const useCompressed = compressed !== undefined && compressed.length < source.length;
  const data = useCompressed ? compressed : source;

  return {
    method: useCompressed ? DEFLATE : STORE,
    data,
    crc32: crc32(source),
    compressedSize: data.length,
    uncompressedSize: source.length
  };
}

function createLocalFileHeader(record: EntryRecord): Uint8Array {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, record.method, true);
  view.setUint16(10, record.dosTime, true);
  view.setUint16(12, record.dosDate, true);
  view.setUint32(14, record.crc32, true);
  view.setUint32(18, record.compressedSize, true);
  view.setUint32(22, record.uncompressedSize, true);
  view.setUint16(26, record.nameBytes.length, true);
  view.setUint16(28, 0, true);
  return header;
}

function createCentralDirectoryHeader(record: EntryRecord): Uint8Array {
  assertUInt32(record.localHeaderOffset, 'Zip archive is too large for this zip writer.');

  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, VERSION_MADE_BY, true);
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

function createEndOfCentralDirectoryRecord(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number
): Uint8Array {
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

function getExternalAttributes(entry: ZipEntryInput): number {
  const mode = entry.mode ?? (entry.kind === 'directory' ? DEFAULT_DIRECTORY_MODE : DEFAULT_FILE_MODE);
  const unixMode = (mode & 0xffff) << 16;
  if (entry.kind === 'directory') {
    return (unixMode | 0x10) >>> 0;
  }
  return unixMode >>> 0;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
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

function assertUInt16(value: number, message: string): void {
  if (value > MAX_UINT16) {
    throw new Error(message);
  }
}

function assertUInt32(value: number, message: string): void {
  if (value > MAX_UINT32) {
    throw new Error(message);
  }
}
