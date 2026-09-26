// Packaging checks: what `npm run gen-vsix` would put in the .vsix. The file
// list comes from vsce itself (`vsce ls`), run with the same dependency mode
// as the gen-vsix script, so an empty or wrong package fails here instead of
// at `vsce package` time (or, worse, in a lab image build).
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';

const rootDir = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const vsceBin = path.join(rootDir, 'node_modules', '@vscode', 'vsce', 'vsce');

function vsceList(flags: string[]): string[] {
  const result = spawnSync(process.execPath, [vsceBin, 'ls', ...flags], { cwd: rootDir, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `vsce ls failed: ${result.stderr}`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

test('gen-vsix packages without npm dependency discovery', () => {
  // esbuild bundles both entries, so there are no runtime dependencies to
  // collect. vsce's default mode parses `npm list --parseable`, which npm >= 11
  // redacts: any UUID-shaped path segment becomes '***', so a checkout under
  // such a path packages zero files and vsce fails with "entrypoint(s) missing".
  assert.deepStrictEqual(Object.keys(packageJson.dependencies ?? {}), [], 'runtime dependencies must be bundled');
  assert.match(packageJson.scripts['gen-vsix'], /\bvsce package\b.*--no-dependencies/);
});

test('the vsix contains exactly the manifest, docs, and both built entry points', () => {
  const flags = /--no-dependencies/.test(packageJson.scripts['gen-vsix']) ? ['--no-dependencies'] : [];
  const files = vsceList(flags);

  assert.ok(files.length > 0, 'vsce ls listed no files');
  const entryPoints = [packageJson.main, packageJson.browser].map((entry: string) => path.posix.normalize(entry));
  for (const entry of entryPoints) {
    assert.ok(files.includes(entry), `entry point ${entry} is not packaged: ${files.join(', ')}`);
  }
  assert.deepStrictEqual(files, ['LICENSE', 'README.md', 'dist/extension.js', 'dist/web/extension.js', 'package.json']);
});
