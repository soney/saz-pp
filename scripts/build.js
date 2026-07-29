// Builds the shipped bundles (dist/) and the compiled unit tests (dist-test/).
// The web extension host loads exactly one file and resolves only
// require('vscode'), which is why the web entry must be bundled.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const common = {
  bundle: true,
  format: 'cjs',
  external: ['vscode'],
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
  logOverride: {
    // Test files require() the built dist/ bundles at runtime by design.
    'unsupported-require-call': 'silent'
  }
};

async function main() {
  // Clean first so deleted/renamed sources and tests cannot survive as stale
  // bundles that keep passing (or shipping).
  fs.rmSync(path.join(rootDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(rootDir, 'dist-test'), { recursive: true, force: true });

  const testEntryPoints = fs
    .readdirSync(path.join(rootDir, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join(rootDir, 'test', name));

  await Promise.all([
    esbuild.build({
      ...common,
      platform: 'node',
      target: 'node22',
      entryPoints: [path.join(rootDir, 'src/desktop/extension.ts')],
      outfile: path.join(rootDir, 'dist/extension.js')
    }),
    esbuild.build({
      ...common,
      platform: 'browser',
      entryPoints: [path.join(rootDir, 'src/web/extension.ts')],
      outfile: path.join(rootDir, 'dist/web/extension.js')
    }),
    esbuild.build({
      ...common,
      platform: 'browser',
      entryPoints: [path.join(rootDir, 'src/web/test/suite/index.ts')],
      outfile: path.join(rootDir, 'dist/web/test/suite/index.js')
    }),
    esbuild.build({
      ...common,
      platform: 'node',
      target: 'node22',
      entryPoints: testEntryPoints,
      outdir: path.join(rootDir, 'dist-test')
    })
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
