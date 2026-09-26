// Node-backed adapter pieces. Deliberately vscode-free so plain-node unit
// tests can exercise the shared core through the exact production file access.
import * as fs from 'fs';
import { promisify } from 'util';
import * as zlib from 'zlib';
import type { FsAdapter, UriLike } from '../shared/types';

export function fsPathOf(uri: UriLike): string {
  return uri.fsPath ?? uri.path;
}

export const nodeFs: FsAdapter = {
  async stat(uri) {
    const stat = await fs.promises.lstat(fsPathOf(uri));
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      mtimeMs: stat.mtimeMs,
      mode: stat.mode
    };
  },
  async readDirectory(uri) {
    return fs.promises.readdir(fsPathOf(uri));
  },
  async readFile(uri) {
    return fs.promises.readFile(fsPathOf(uri));
  },
  async createDirectory(uri) {
    await fs.promises.mkdir(fsPathOf(uri), { recursive: true });
  },
  async writeFile(uri, content) {
    await fs.promises.writeFile(fsPathOf(uri), content, { flag: 'wx' });
  },
  async delete(uri, options) {
    if (options.recursive) {
      await fs.promises.rm(fsPathOf(uri), { recursive: true, force: true });
    } else {
      await fs.promises.rmdir(fsPathOf(uri));
    }
  }
};

const deflateRawAsync = promisify(zlib.deflateRaw);

// The async form runs on libuv's thread pool and yields the same bytes. The
// sync form held the extension host, which code-server shares between every
// extension, for seconds on a folder with node_modules in it.
export async function nodeDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return deflateRawAsync(data, { level: 9 });
}
