# Save Files as Zip

Right-click one or more files or folders in the VS Code Explorer and run **Download as Zip**. The extension builds the archive and immediately downloads the zip in VS Code Web/code-server without leaving a zip file in the workspace.

## Behavior

- Single file: downloads `filename.zip`.
- Single folder: downloads `foldername.zip` and preserves the folder name in the archive.
- Multiple selections: downloads `selected-files.zip` and preserves the selected item names.
- Workspace cleanup: no final `.zip` file is written next to the selected items.
- Contents: everything under a selected folder, including dot folders and `node_modules`, except the temp directory below. Names that are not plain ASCII are stored as flagged UTF-8, so Windows, 7-Zip and Python read them correctly.
- Symbolic links are never followed. Selecting a link is an error; links found inside a selected folder (such as `node_modules/.bin` after `npm install`, loops, or dangling links) are left out, and the completion message says how many were skipped.
- Two downloads started together are handed to the browser one at a time, so each gets its own zip.

In VS Code Web/code-server, the extension writes a short-lived hidden file under `.save-files-as-zip/` only so VS Code's Explorer download flow can hand the bytes to the browser. That temporary file is removed after the download command completes. In a Node-backed extension host, it uses built-in Node.js APIs for archive creation. Archives are deflate-compressed on both desktop (zlib) and web (`CompressionStream`, with uncompressed fallback on older browsers).

## Settings

- `saveFilesAsZip.tempDirectory`: directory for the short-lived zip file used to trigger the browser download. The default is `.save-files-as-zip`. Relative paths resolve from the selected files' common parent. Absolute paths are allowed; in browser-only VS Code Web they must be writable through the active workspace file-system provider.

  In VS Code Web and code-server the zip reaches the browser through the Explorer (`revealInExplorer`, then `explorer.download`, which takes no argument and downloads the Explorer's selection). So the directory must be inside the workspace and must not be hidden by `files.exclude`: with a directory outside the workspace, or a pattern such as `**/.*` that hides the default folder, VS Code downloads the right-clicked item itself, or nothing, instead of the zip.

- `saveFilesAsZip.excludeNames`: file and folder names left out of every zip, at any depth (exact base-name matches). The default is `[".dotfiles-coursera"]`: the Coursera lab image keeps saved Git credentials (`.git-credentials`), VS Code settings, the code-server key half, and every installed extension in that folder inside the learner's project, so zipping the project root would otherwise ship all of it. Setting the list replaces the default rather than adding to it.

## Development

The extension is TypeScript with a single shared core:

- `src/shared/` — platform-neutral selection, traversal, zip writing, and download flows. No Node or vscode imports; platform capabilities arrive through a small adapter interface.
- `src/desktop/` — desktop entry: direct `fs.lstat`/`zlib` adapter (preserves unix modes, symlink detection, and level-9 deflate).
- `src/web/` — web entry: `vscode.workspace.fs` adapter with `CompressionStream('deflate-raw')` compression (feature-detected; stores uncompressed on older hosts).

`npm run build` bundles both entries with esbuild into `dist/` (the web extension host loads a single file, which is why the web entry must be bundled). Tests compile to `dist-test/` and run with `node --test` against the **built** bundles, so `npm test` exercises exactly what ships — including a golden-fixture test that pins the desktop writer's exact bytes.

## Verify

```sh
npm run verify
```

This typechecks (`tsc --noEmit` for shared/web without Node globals — a stray `Buffer` in shared code is a compile error), builds, and runs the unit + bundle tests.

## Test in VS Code Web

Install dependencies, then launch the web client with the bundled fixture workspace:

```sh
npm install
npm run web
```

The test client opens `test-fixtures/workspace` at `http://localhost:3010`.
`@vscode/test-web` keeps workspace changes in the browser-backed test file system. The extension should not leave `single-file.zip`, `selected-files.zip`, `.save-files-as-zip/`, or the configured temp directory behind after a download.

Useful manual checks:

- Right-click `single-file.txt` and run **Download as Zip**.
- Select `multi-one.txt`, `multi-two.txt`, and `folder-to-zip`, then right-click one selected item and run **Download as Zip**.
- Right-click `folder-to-zip` and run **Download as Zip**.

There is also a headless web integration check:

```sh
npm run test:web
```

To verify the browser download itself, run:

```sh
npm run test:web:download
```

That smoke test starts the VS Code Web client, runs the same extension command on the fixture files, captures the browser downloads, and checks the downloaded zip contents.
