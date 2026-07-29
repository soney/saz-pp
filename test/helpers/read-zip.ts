import * as assert from 'assert';
import * as zlib from 'zlib';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const STORE = 0;
const DEFLATE = 8;

export interface ZipLocalEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Decompressed payload. */
  data: Buffer;
}

export interface ZipCentralEntry {
  name: string;
  method: number;
  crc32: number;
  externalAttributes: number;
  localHeaderOffset: number;
}

export interface ParsedZip {
  entries: ZipLocalEntry[];
  central: ZipCentralEntry[];
  entryCount: number;
}

export function parseZip(input: Uint8Array): ParsedZip {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const entries: ZipLocalEntry[] = [];
  const central: ZipCentralEntry[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
      break;
    }

    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === STORE) {
      data = Buffer.from(compressedData);
    } else if (method === DEFLATE) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unexpected compression method ${method} for ${name}`);
    }

    assert.strictEqual(data.length, uncompressedSize, `uncompressed size mismatch for ${name}`);
    entries.push({ name, method, crc32: crc, compressedSize, uncompressedSize, data });
    offset = dataStart + compressedSize;
  }

  while (offset < buffer.length && buffer.readUInt32LE(offset) === CENTRAL_DIRECTORY_SIGNATURE) {
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    central.push({ name, method, crc32: crc, externalAttributes, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  assert.ok(offset < buffer.length, 'missing end-of-central-directory record');
  assert.strictEqual(buffer.readUInt32LE(offset), END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  const entryCount = buffer.readUInt16LE(offset + 10);

  return { entries, central, entryCount };
}

export function entryNames(zip: ParsedZip): string[] {
  return zip.entries.map((entry) => entry.name);
}

export function entryByName(zip: ParsedZip, name: string): ZipLocalEntry {
  const entry = zip.entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `missing zip entry ${name}`);
  return entry;
}
