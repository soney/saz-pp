const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createZipFromPaths } = require('../lib/zip');

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const STORE = 0;
const DEFLATE = 8;

async function main() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-files-as-zip-'));
  const fixtureDir = path.join(tempDir, 'fixture');
  const nestedDir = path.join(fixtureDir, 'nested');
  const emptyDir = path.join(fixtureDir, 'empty');
  await fs.promises.mkdir(nestedDir, { recursive: true });
  await fs.promises.mkdir(emptyDir, { recursive: true });
  await fs.promises.writeFile(path.join(fixtureDir, 'alpha.txt'), 'alpha\n');
  await fs.promises.writeFile(path.join(nestedDir, 'beta.txt'), 'beta\n');

  const singleOutput = path.join(tempDir, 'alpha.zip');
  await createZipFromPaths([path.join(fixtureDir, 'alpha.txt')], singleOutput, {
    rootDir: fixtureDir
  });
  const singleEntries = readZipEntries(singleOutput);
  assert.deepStrictEqual(Object.keys(singleEntries), ['alpha.txt']);
  assert.strictEqual(singleEntries['alpha.txt'].toString(), 'alpha\n');

  const multiOutput = path.join(tempDir, 'multi.zip');
  await createZipFromPaths([path.join(fixtureDir, 'alpha.txt'), nestedDir, emptyDir], multiOutput, {
    rootDir: fixtureDir
  });
  const multiEntries = readZipEntries(multiOutput);
  assert.deepStrictEqual(Object.keys(multiEntries), ['alpha.txt', 'nested/', 'nested/beta.txt', 'empty/']);
  assert.strictEqual(multiEntries['nested/beta.txt'].toString(), 'beta\n');
  assert.strictEqual(multiEntries['empty/'].length, 0);

  const folderOutput = path.join(tempDir, 'fixture.zip');
  await createZipFromPaths([fixtureDir], folderOutput, {
    rootDir: tempDir
  });
  const folderEntries = readZipEntries(folderOutput);
  assert.deepStrictEqual(Object.keys(folderEntries), [
    'fixture/',
    'fixture/alpha.txt',
    'fixture/empty/',
    'fixture/nested/',
    'fixture/nested/beta.txt'
  ]);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
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
    console.log('zip tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
