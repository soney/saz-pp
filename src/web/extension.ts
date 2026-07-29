import * as vscode from 'vscode';
import type { FsAdapter, PlatformAdapter, UriLike } from '../shared/types';
import { createExtension } from '../shared/main';
import { downloadViaTempFile } from '../shared/download-temp';
import { stripTrailingSlash } from '../shared/uri-path';

const webFs: FsAdapter = {
  async stat(uri) {
    const stat = await vscode.workspace.fs.stat(uri as vscode.Uri);
    return {
      isFile: Boolean(stat.type & vscode.FileType.File),
      isDirectory: Boolean(stat.type & vscode.FileType.Directory),
      isSymbolicLink: Boolean(stat.type & vscode.FileType.SymbolicLink),
      mtimeMs: stat.mtime
    };
  },
  async readDirectory(uri) {
    const children = await vscode.workspace.fs.readDirectory(uri as vscode.Uri);
    return children.map(([name]) => name);
  },
  async readFile(uri) {
    return vscode.workspace.fs.readFile(uri as vscode.Uri);
  },
  async createDirectory(uri) {
    await vscode.workspace.fs.createDirectory(uri as vscode.Uri);
  },
  async writeFile(uri, content) {
    await vscode.workspace.fs.writeFile(uri as vscode.Uri, content);
  },
  async delete(uri, options) {
    await vscode.workspace.fs.delete(uri as vscode.Uri, { recursive: options.recursive, useTrash: false });
  }
};

const adapter: PlatformAdapter = {
  fs: webFs,
  deflateRaw: webDeflateRaw,
  acceptsUri(uri: UriLike): boolean {
    return Boolean(uri.scheme);
  },
  dedupKey(uri: UriLike): string {
    return uri.toString();
  },
  displayPath(uri: UriLike): string {
    return uri.toString();
  },
  resolveTempRoot(configured: string, baseUri: UriLike): UriLike {
    const normalized = configured.replace(/\\/g, '/').replace(/\/+/g, '/');
    // Relative settings resolve against the archive root; '.' and '..'
    // segments are normalized away in both branches so the resulting URI
    // matches what file-system providers actually store.
    const combined = normalized.startsWith('/')
      ? normalized
      : `${stripTrailingSlash(baseUri.path)}/${normalized}`;
    return baseUri.with({ path: normalizeAbsoluteUriPath(combined) });
  },
  async download(filename: string, bytes: Uint8Array, tempRootUri: UriLike): Promise<void> {
    // The browser extension host only runs web UIs; downloads always go
    // through a temp file so the workbench (not a sandboxed webview) can
    // hand the bytes to the browser.
    await downloadViaTempFile(vscode, webFs, filename, bytes, tempRootUri);
  },
  ensureCompatibleSelection(uris: UriLike[]): void {
    const first = uris[0];
    for (const uri of uris) {
      if (uri.scheme !== first.scheme || uri.authority !== first.authority) {
        throw new Error('All selected items must be from the same workspace file system.');
      }
    }
  }
};

/**
 * Raw-deflate via CompressionStream where the runtime supports it; returns
 * undefined (= store uncompressed) on older hosts.
 */
async function webDeflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined') {
    return undefined;
  }

  try {
    const stream = new CompressionStream('deflate-raw');
    const writePromise = (async () => {
      const writer = stream.writable.getWriter();
      // Cast: BufferSource wants an ArrayBuffer-backed view; adapter reads are
      // never SharedArrayBuffer-backed.
      await writer.write(data as Uint8Array<ArrayBuffer>);
      await writer.close();
    })();
    // If the read side rejects first we never reach the await below; keep the
    // write side's rejection observed so it cannot surface as unhandled.
    writePromise.catch(() => {});
    const buffer = await new Response(stream.readable).arrayBuffer();
    await writePromise;
    return new Uint8Array(buffer);
  } catch {
    return undefined;
  }
}

function normalizeAbsoluteUriPath(sourcePath: string): string {
  const segments: string[] = [];
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

const extension = createExtension(vscode, adapter);

export const activate = extension.activate;
export const deactivate = extension.deactivate;
