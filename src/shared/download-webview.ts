import { createNonce, toBase64 } from './util';

type VscodeHost = typeof import('vscode');

/**
 * Desktop-UI download: hand the bytes to a short-lived webview that triggers a
 * browser-style blob download.
 */
export async function downloadViaWebview(host: VscodeHost, filename: string, bytes: Uint8Array): Promise<void> {
  const panel = host.window.createWebviewPanel(
    'saveFilesAsZip.download',
    `Downloading ${filename}`,
    { viewColumn: host.ViewColumn.Active, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const nonce = createNonce();
  const base64 = toBase64(bytes);

  panel.webview.html = createDownloadHtml(nonce);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error('Timed out while starting the browser download.'));
    }, 15000);

    const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'ready') {
        panel.webview.postMessage({
          type: 'download',
          filename,
          mimeType: 'application/zip',
          base64
        });
      } else if (message.type === 'done') {
        finish();
      } else if (message.type === 'error') {
        finish(new Error(message.message || 'Browser download failed.'));
      }
    });

    const disposeDisposable = panel.onDidDispose(() => {
      finish(new Error('Download webview was closed before the download started.'));
    });

    function finish(error?: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      messageDisposable.dispose();
      disposeDisposable.dispose();
      if (error) {
        panel.dispose();
        reject(error);
      } else {
        setTimeout(() => panel.dispose(), 500);
        resolve();
      }
    }
  });
}

function createDownloadHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';">
  <title>Downloading Zip</title>
</head>
<body>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'download') {
        return;
      }

      try {
        const binary = atob(message.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const blob = new Blob([bytes], { type: message.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = message.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => {
          URL.revokeObjectURL(url);
          vscode.postMessage({ type: 'done' });
        }, 100);
      } catch (error) {
        vscode.postMessage({
          type: 'error',
          message: error && error.message ? error.message : String(error)
        });
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
