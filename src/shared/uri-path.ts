import type { UriLike } from './types';

export function stripTrailingSlash(sourcePath: string): string {
  return sourcePath.length > 1 ? sourcePath.replace(/\/+$/, '') : sourcePath;
}

export function uriDirname(uri: UriLike): UriLike {
  const cleanPath = stripTrailingSlash(uri.path);
  const slashIndex = cleanPath.lastIndexOf('/');
  const parentPath = slashIndex <= 0 ? '/' : cleanPath.slice(0, slashIndex);
  return uri.with({ path: parentPath });
}

export function uriBasename(uri: UriLike): string {
  const cleanPath = stripTrailingSlash(uri.path);
  const slashIndex = cleanPath.lastIndexOf('/');
  return slashIndex < 0 ? cleanPath : cleanPath.slice(slashIndex + 1);
}

export function extname(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(dotIndex) : '';
}

export function joinUriPath(uri: UriLike, ...segments: string[]): UriLike {
  let joined = stripTrailingSlash(uri.path);
  for (const segment of segments) {
    joined = joined === '/' ? `/${segment}` : `${joined}/${segment}`;
  }
  return uri.with({ path: joined });
}

/**
 * Path of `uri` relative to `rootUri`, or undefined when `uri` is not strictly
 * inside `rootUri` (including scheme/authority mismatches and equality).
 */
export function relativeUriPath(rootUri: UriLike, uri: UriLike): string | undefined {
  if (rootUri.scheme !== uri.scheme || rootUri.authority !== uri.authority) {
    return undefined;
  }

  const rootPath = stripTrailingSlash(rootUri.path);
  const targetPath = stripTrailingSlash(uri.path);
  if (targetPath === rootPath) {
    return undefined;
  }

  const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
  if (!targetPath.startsWith(prefix)) {
    return undefined;
  }

  return targetPath.slice(prefix.length);
}

export function isUriInside(parentUri: UriLike, childUri: UriLike): boolean {
  return relativeUriPath(parentUri, childUri) !== undefined;
}

export function isSameUri(first: UriLike, second: UriLike): boolean {
  return (
    first.scheme === second.scheme &&
    first.authority === second.authority &&
    stripTrailingSlash(first.path) === stripTrailingSlash(second.path)
  );
}

export function findCommonParentUri(uris: UriLike[]): UriLike {
  const parentPaths = uris.map((uri) => uriDirname(uri).path);
  let common = splitPath(parentPaths[0]);

  for (const parentPath of parentPaths.slice(1)) {
    const parts = splitPath(parentPath);
    let index = 0;
    while (index < common.length && common[index] === parts[index]) {
      index += 1;
    }
    common = common.slice(0, index);
  }

  const path = common.length === 0 ? '/' : `/${common.join('/')}`;
  return uris[0].with({ path });
}

export function splitPath(sourcePath: string): string[] {
  return sourcePath.split('/').filter(Boolean);
}
