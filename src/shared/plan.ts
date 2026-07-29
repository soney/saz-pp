import type { FsAdapter, SelectedItem, StatInfo, UriLike } from './types';
import { extname, findCommonParentUri, isUriInside, uriBasename, uriDirname } from './uri-path';

/**
 * Normalize the command arguments (primary uri + multi-selection) into a
 * deduplicated list of accepted URIs, preserving selection order.
 */
export function getSelectedUris(
  uri: UriLike | undefined,
  selectedUris: UriLike[] | undefined,
  acceptsUri: (uri: UriLike) => boolean,
  dedupKey: (uri: UriLike) => string
): UriLike[] {
  const items = Array.isArray(selectedUris) && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  const seen = new Set<string>();
  const uris: UriLike[] = [];

  for (const item of items) {
    if (!item || !acceptsUri(item)) {
      continue;
    }

    const key = dedupKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      uris.push(item);
    }
  }

  return uris;
}

/**
 * Drop selections already covered by a selected ancestor directory,
 * returning the survivors with their stats in original selection order.
 */
export async function removeNestedSelections(fs: FsAdapter, uris: UriLike[]): Promise<SelectedItem[]> {
  const withStats = await Promise.all(
    uris.map(async (uri, index) => ({
      uri,
      stat: await fs.stat(uri),
      index
    }))
  );

  const kept: Array<{ uri: UriLike; stat: StatInfo }> = [];
  for (const item of [...withStats].sort((a, b) => a.uri.path.length - b.uri.path.length)) {
    const alreadyCovered = kept.some((candidate) => candidate.stat.isDirectory && isUriInside(candidate.uri, item.uri));
    if (!alreadyCovered) {
      kept.push(item);
    }
  }

  const keptKeys = new Set(kept.map((item) => item.uri.toString()));
  return withStats
    .sort((a, b) => a.index - b.index)
    .filter((item) => keptKeys.has(item.uri.toString()))
    .map((item) => ({ uri: item.uri, stat: item.stat }));
}

export interface ArchivePlan {
  rootUri: UriLike;
  filename: string;
}

export function createArchivePlan(selectedItems: SelectedItem[]): ArchivePlan {
  if (selectedItems.length === 1) {
    const item = selectedItems[0];
    return { rootUri: uriDirname(item.uri), filename: getSingleArchiveName(item.uri, item.stat) };
  }

  return {
    rootUri: findCommonParentUri(selectedItems.map((item) => item.uri)),
    filename: 'selected-files.zip'
  };
}

export function getSingleArchiveName(uri: UriLike, stat: StatInfo): string {
  const baseName = uriBasename(uri);
  if (stat.isDirectory) {
    return `${baseName}.zip`;
  }

  const extension = extname(baseName);
  const baseWithoutExtension = extension ? baseName.slice(0, -extension.length) : baseName;
  const archiveName = `${baseWithoutExtension}.zip`;
  return archiveName === baseName ? `${baseWithoutExtension}-archive.zip` : archiveName;
}
