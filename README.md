# Save Files as Zip

Right-click one or more files or folders in the VS Code Explorer and run **Download as Zip**. The extension builds the archive and immediately downloads the zip in VS Code Web/code-server without leaving a zip file in the workspace.

## Behavior

- Single file: downloads `filename.zip`.
- Single folder: downloads `foldername.zip` and preserves the folder name in the archive.
- Multiple selections: downloads `selected-files.zip` and preserves the selected item names.
- Workspace cleanup: no final `.zip` file is written next to the selected items.

In VS Code Web/code-server, the extension writes a short-lived hidden file under `.save-files-as-zip/` only so VS Code's Explorer download flow can hand the bytes to the browser. That temporary file is removed after the download command completes. In a Node-backed extension host, it uses built-in Node.js APIs for archive creation.

## Settings

- `saveFilesAsZip.tempDirectory`: directory for the short-lived zip file used to trigger the browser download. The default is `.save-files-as-zip`. Relative paths resolve from the selected files' common parent. Absolute paths are allowed; in browser-only VS Code Web they must be writable through the active workspace file-system provider.

## Verify

```sh
npm run verify
```

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
