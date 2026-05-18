const vscode = require('vscode');

const COMMAND_ID = 'saveFilesAsZip.saveAsZip';

async function run() {
  const root = getWorkspaceRoot();

  const singleFile = vscode.Uri.joinPath(root, 'single-file.txt');
  await vscode.commands.executeCommand(COMMAND_ID, singleFile, [singleFile]);
  const singleZip = vscode.Uri.joinPath(root, 'single-file.zip');
  await assertFileMissing(singleZip);
  await assertFileMissing(vscode.Uri.joinPath(root, '.save-files-as-zip'));

  const multiOne = vscode.Uri.joinPath(root, 'multi-one.txt');
  const multiTwo = vscode.Uri.joinPath(root, 'multi-two.txt');
  const folder = vscode.Uri.joinPath(root, 'folder-to-zip');
  await vscode.commands.executeCommand(COMMAND_ID, multiOne, [multiOne, multiTwo, folder]);
  const selectedZip = vscode.Uri.joinPath(root, 'selected-files.zip');
  await assertFileMissing(selectedZip);
  await assertFileMissing(vscode.Uri.joinPath(root, '.save-files-as-zip'));

  const absoluteTempRoot = vscode.Uri.joinPath(root, '.absolute-temp-zips');
  await updateTempDirectory(absoluteTempRoot.path);
  try {
    await vscode.commands.executeCommand(COMMAND_ID, folder, [folder]);
    await assertFileMissing(vscode.Uri.joinPath(root, 'folder-to-zip.zip'));
    await assertFileMissing(absoluteTempRoot);
  } finally {
    await updateTempDirectory(undefined);
  }
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Expected the vscode-test-web fixture workspace to be open.');
  }
  return folders[0].uri;
}

async function assertFileMissing(uri) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < 5000) {
    try {
      await vscode.workspace.fs.stat(uri);
      await delay(100);
    } catch (error) {
      lastError = error;
      return;
    }
  }

  throw new Error(`Expected ${uri.toString()} to be absent: ${lastError && lastError.message}`);
}

async function updateTempDirectory(value) {
  await vscode.workspace
    .getConfiguration('saveFilesAsZip')
    .update('tempDirectory', value, vscode.ConfigurationTarget.Workspace);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  run
};
