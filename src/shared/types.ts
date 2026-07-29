/**
 * Structural URI type shared code operates on. `vscode.Uri` satisfies it, and
 * plain-node tests can supply a lightweight fake without loading vscode.
 */
export interface UriLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  /** Present on real vscode.Uri and on test fakes for file-scheme URIs. */
  readonly fsPath?: string;
  with(change: { path: string }): UriLike;
  toString(): string;
}

/** lstat-shaped on desktop (does not follow symlinks); provider-stat-shaped on web. */
export interface StatInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtimeMs: number;
  /** Unix mode bits; only the desktop adapter can supply them. */
  mode?: number;
}

export interface FsAdapter {
  stat(uri: UriLike): Promise<StatInfo>;
  /** Child entry names (unsorted; the collector sorts). */
  readDirectory(uri: UriLike): Promise<string[]>;
  readFile(uri: UriLike): Promise<Uint8Array>;
  createDirectory(uri: UriLike): Promise<void>;
  writeFile(uri: UriLike, content: Uint8Array): Promise<void>;
  delete(uri: UriLike, options: { recursive: boolean }): Promise<void>;
}

export interface PlatformAdapter {
  fs: FsAdapter;
  /**
   * Raw-deflate `data`, or return undefined to store uncompressed (e.g. when
   * CompressionStream('deflate-raw') is unavailable). The zip writer still
   * stores uncompressed whenever compression does not shrink the payload.
   */
  deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined>;
  /** Selection filter: desktop accepts only file-scheme URIs; web accepts any scheme. */
  acceptsUri(uri: UriLike): boolean;
  /** Selection dedup key: resolved fsPath on desktop, uri.toString() on web. */
  dedupKey(uri: UriLike): string;
  /** Human-readable path for error messages: fsPath on desktop, uri.toString() on web. */
  displayPath(uri: UriLike): string;
  /** Resolve the configured tempDirectory setting against the archive root. */
  resolveTempRoot(configured: string, baseUri: UriLike): UriLike;
  /** Platform download flow (webview blob on desktop UI, temp file + explorer.download on web UI). */
  download(filename: string, bytes: Uint8Array, tempRootUri: UriLike): Promise<void>;
  /** Optional selection precondition (web rejects mixed-filesystem selections). */
  ensureCompatibleSelection?(uris: UriLike[]): void;
}

export interface SelectedItem {
  uri: UriLike;
  stat: StatInfo;
}

export interface ZipEntryInput {
  kind: 'file' | 'directory';
  /** Forward-slash path inside the archive; directories end with '/'. */
  zipPath: string;
  /** Path shown in size-limit and progress messages. */
  displayPath: string;
  mtimeMs: number;
  mode?: number;
  /** File payload loader; unset for directories. */
  getData?: () => Promise<Uint8Array>;
}

export type ProgressCallback = (completed: number, total: number, currentPath: string) => void;
