import type { FsAdapter, UriLike } from './types';
import { joinUriPath } from './uri-path';
import { createTempId, delay } from './util';

type VscodeHost = typeof import('vscode');

const REVEAL_IN_EXPLORER_COMMAND = 'revealInExplorer';
const EXPLORER_DOWNLOAD_COMMAND = 'explorer.download';

/**
 * Write the zip under a short-lived unique directory below `tempRootUri`,
 * trigger the workbench download flow, then clean up (best effort).
 */
export async function downloadViaTempFile(
  host: VscodeHost,
  fs: FsAdapter,
  filename: string,
  bytes: Uint8Array,
  tempRootUri: UriLike
): Promise<void> {
  const tempDir = joinUriPath(tempRootUri, createTempId());
  const tempZipUri = joinUriPath(tempDir, filename);

  await fs.createDirectory(tempDir);
  try {
    await fs.writeFile(tempZipUri, bytes);
    await downloadViaExplorer(host, tempZipUri);
  } finally {
    await bestEffort(() => fs.delete(tempDir, { recursive: true }));
    await removeEmptyTempRoot(fs, tempRootUri);
  }
}

async function downloadViaExplorer(host: VscodeHost, resourceUri: UriLike): Promise<void> {
  // VS Code Web starts downloads from the workbench window; webview downloads are sandboxed.
  await host.commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND, resourceUri);
  await delay(250);
  await host.commands.executeCommand(EXPLORER_DOWNLOAD_COMMAND);
}

async function removeEmptyTempRoot(fs: FsAdapter, tempRootUri: UriLike): Promise<void> {
  try {
    const entries = await fs.readDirectory(tempRootUri);
    if (entries.length === 0) {
      await fs.delete(tempRootUri, { recursive: false });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

async function bestEffort(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    // Best-effort cleanup only.
  }
}
