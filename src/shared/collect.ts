import type { FsAdapter, SelectedItem, UriLike, ZipEntryInput } from './types';
import { isSameUri, isUriInside, relativeUriPath, uriBasename, joinUriPath } from './uri-path';

export interface CollectOptions {
  rootUri: UriLike;
  excludeBaseNames?: string[];
  excludeUris?: UriLike[];
  displayPath(uri: UriLike): string;
}

/**
 * Walk the selection into zip entry inputs. Directories recurse with children
 * sorted by name; symbolic links are rejected; duplicate zip paths collapse.
 */
export async function collectZipEntries(
  fs: FsAdapter,
  selectedItems: SelectedItem[],
  options: CollectOptions
): Promise<ZipEntryInput[]> {
  const entries: ZipEntryInput[] = [];
  const seenZipPaths = new Set<string>();

  for (const item of selectedItems) {
    const relativePath = relativeUriPath(options.rootUri, item.uri);
    // A root of '/' with a drive-letter first segment means the selection was
    // a Windows drive root or spanned drives — there is no real common parent
    // (file-URI paths are '/c:/...'), and 'c:/...' entry names would not
    // extract on Windows.
    if (!relativePath || (options.rootUri.path === '/' && /^[a-zA-Z]:$/.test(relativePath.split('/', 1)[0]))) {
      throw new Error(`Selected item is outside the archive root: ${options.displayPath(item.uri)}`);
    }

    await collectUri(fs, item.uri, relativePath, entries, seenZipPaths, options);
  }

  return entries;
}

async function collectUri(
  fs: FsAdapter,
  uri: UriLike,
  zipPath: string,
  entries: ZipEntryInput[],
  seenZipPaths: Set<string>,
  options: CollectOptions
): Promise<void> {
  const stat = await fs.stat(uri);
  if (shouldExclude(uri, options)) {
    return;
  }

  if (stat.isSymbolicLink) {
    throw new Error(`Symbolic links are not supported: ${options.displayPath(uri)}`);
  }

  if (stat.isDirectory) {
    const directoryZipPath = zipPath.endsWith('/') ? zipPath : `${zipPath}/`;
    addEntry(entries, seenZipPaths, {
      kind: 'directory',
      zipPath: directoryZipPath,
      displayPath: options.displayPath(uri),
      mtimeMs: stat.mtimeMs,
      mode: stat.mode
    });

    const children = await fs.readDirectory(uri);
    children.sort((a, b) => a.localeCompare(b));
    for (const name of children) {
      await collectUri(fs, joinUriPath(uri, name), `${directoryZipPath}${name}`, entries, seenZipPaths, options);
    }
    return;
  }

  if (stat.isFile) {
    addEntry(entries, seenZipPaths, {
      kind: 'file',
      zipPath,
      displayPath: options.displayPath(uri),
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
      getData: () => fs.readFile(uri)
    });
  }
}

function addEntry(entries: ZipEntryInput[], seenZipPaths: Set<string>, entry: ZipEntryInput): void {
  if (seenZipPaths.has(entry.zipPath)) {
    return;
  }
  seenZipPaths.add(entry.zipPath);
  entries.push(entry);
}

function shouldExclude(uri: UriLike, options: CollectOptions): boolean {
  if (options.excludeUris) {
    for (const excludeUri of options.excludeUris) {
      if (!excludeUri) {
        continue;
      }
      if (isSameUri(excludeUri, uri) || isUriInside(excludeUri, uri)) {
        return true;
      }
    }
  }

  return Boolean(options.excludeBaseNames && options.excludeBaseNames.includes(uriBasename(uri)));
}
