import * as fs from 'fs';
import * as path from 'path';

export interface TreeContentSpec {
  kind: 'text' | 'repeat' | 'xorshift';
  value?: string;
  count?: number;
  seed?: number;
  length?: number;
}

export interface TreeEntrySpec {
  path: string;
  type: 'file' | 'directory';
  mode: number;
  mtimeMs: number;
  content?: TreeContentSpec;
}

export interface TreeSpec {
  root: string;
  entries: TreeEntrySpec[];
}

export function xorshiftBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

export function contentBytes(spec: TreeContentSpec): Uint8Array {
  if (spec.kind === 'text') {
    return Buffer.from(spec.value ?? '', 'utf8');
  }
  if (spec.kind === 'repeat') {
    return Buffer.from((spec.value ?? '').repeat(spec.count ?? 0), 'utf8');
  }
  return xorshiftBytes(spec.seed ?? 0, spec.length ?? 0);
}

/** Materialize the spec on disk with exact modes and mtimes. */
export async function buildTree(baseDir: string, spec: TreeSpec): Promise<void> {
  for (const entry of spec.entries) {
    const target = path.join(baseDir, entry.path);
    if (entry.type === 'directory') {
      await fs.promises.mkdir(target, { recursive: true });
    } else {
      await fs.promises.writeFile(target, contentBytes(entry.content!));
    }
    await fs.promises.chmod(target, entry.mode);
  }

  // Set mtimes files-first, then directories deepest-first (writing children
  // bumps directory mtimes).
  const files = spec.entries.filter((entry) => entry.type === 'file');
  const dirs = spec.entries.filter((entry) => entry.type === 'directory');
  for (const entry of files) {
    const time = new Date(entry.mtimeMs);
    await fs.promises.utimes(path.join(baseDir, entry.path), time, time);
  }
  for (const entry of [...dirs].sort((a, b) => b.path.length - a.path.length)) {
    const time = new Date(entry.mtimeMs);
    await fs.promises.utimes(path.join(baseDir, entry.path), time, time);
  }
}
