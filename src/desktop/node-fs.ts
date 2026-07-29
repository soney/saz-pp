// Node-backed adapter pieces. Deliberately vscode-free so plain-node unit
// tests can exercise the shared core through the exact production file access.
import * as fs from 'fs';
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

export async function nodeDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return zlib.deflateRawSync(data, { level: 9 });
}
