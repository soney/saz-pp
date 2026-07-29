import type { UriLike } from '../../src/shared/types';

/**
 * Minimal vscode.Uri stand-in for plain-node tests. Paths are POSIX, so
 * fsPath === path for the file scheme.
 */
export class FakeUri implements UriLike {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  with(change: { path: string }): FakeUri {
    return new FakeUri(this.scheme, this.authority, change.path);
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }

  static file(fsPath: string): FakeUri {
    return new FakeUri('file', '', fsPath);
  }
}
