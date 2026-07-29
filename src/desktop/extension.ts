import * as path from 'path';
import * as vscode from 'vscode';
import type { PlatformAdapter, UriLike } from '../shared/types';
import { createExtension } from '../shared/main';
import { downloadViaTempFile } from '../shared/download-temp';
import { downloadViaWebview } from '../shared/download-webview';
import { fsPathOf, nodeFs, nodeDeflateRaw } from './node-fs';

const adapter: PlatformAdapter = {
  fs: nodeFs,
  deflateRaw: nodeDeflateRaw,
  acceptsUri(uri: UriLike): boolean {
    return uri.scheme === 'file' && Boolean(uri.fsPath);
  },
  dedupKey(uri: UriLike): string {
    return path.resolve(fsPathOf(uri));
  },
  displayPath(uri: UriLike): string {
    return fsPathOf(uri);
  },
  resolveTempRoot(configured: string, baseUri: UriLike): UriLike {
    if (path.isAbsolute(configured)) {
      return vscode.Uri.file(path.resolve(configured));
    }
    // A Windows drive-root base arrives from Uri.fsPath as "c:" without a
    // separator; resolving against that would use the per-drive cwd instead
    // of the drive root.
    const basePath = fsPathOf(baseUri);
    const base = /^[a-zA-Z]:$/.test(basePath) ? `${basePath}${path.sep}` : basePath;
    return vscode.Uri.file(path.resolve(base, configured));
  },
  async download(filename: string, bytes: Uint8Array, tempRootUri: UriLike): Promise<void> {
    if (isWebUi()) {
      await downloadViaTempFile(vscode, nodeFs, filename, bytes, tempRootUri);
      return;
    }

    await downloadViaWebview(vscode, filename, bytes);
  }
};

function isWebUi(): boolean {
  return Boolean(vscode.env && vscode.UIKind && vscode.env.uiKind === vscode.UIKind.Web);
}

const extension = createExtension(vscode, adapter);

export const activate = extension.activate;
export const deactivate = extension.deactivate;
