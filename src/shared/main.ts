import type { PlatformAdapter, UriLike } from './types';
import { collectZipEntries } from './collect';
import { createArchivePlan, getSelectedUris, removeNestedSelections } from './plan';
import { buildZip } from './zip-core';
import { relativeUriPath } from './uri-path';
import { formatBytes, isUriString } from './util';

type VscodeHost = typeof import('vscode');
type ExtensionContextLike = { subscriptions: Array<{ dispose(): unknown }> };

export const COMMAND_ID = 'saveFilesAsZip.saveAsZip';
const CONFIG_SECTION = 'saveFilesAsZip';
const TEMP_DIRECTORY_SETTING = 'tempDirectory';
const EXCLUDE_NAMES_SETTING = 'excludeNames';
export const DEFAULT_TEMP_DOWNLOAD_DIR = '.save-files-as-zip';
// The Coursera lab persists saved Git credentials, VS Code settings and every
// installed extension in this folder inside the learner's workspace, so zipping
// the workspace root would otherwise ship all of it.
export const DEFAULT_EXCLUDE_NAMES = ['.dotfiles-coursera'];

export interface Extension {
  activate(context: ExtensionContextLike): void;
  deactivate(): void;
  saveAsZip(uri?: UriLike, selectedUris?: UriLike[]): Promise<void>;
}

export function createExtension(host: VscodeHost, adapter: PlatformAdapter): Extension {
  async function saveAsZip(uri?: UriLike, selectedUris?: UriLike[]): Promise<void> {
    const uris = getSelectedUris(uri, selectedUris, adapter.acceptsUri, adapter.dedupKey);
    if (uris.length === 0) {
      host.window.showWarningMessage('Right-click one or more files or folders in the Explorer to save them as a zip.');
      return;
    }

    adapter.ensureCompatibleSelection?.(uris);
    const selectedItems = await removeNestedSelections(adapter.fs, uris);
    const plan = createArchivePlan(selectedItems);
    const tempRootUri = resolveTempRoot(plan.rootUri);
    const skippedLinks: string[] = [];

    const zipBytes = await host.window.withProgress(
      {
        location: host.ProgressLocation.Notification,
        title: `Creating ${plan.filename}`,
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Collecting files...' });
        const entries = await collectZipEntries(adapter.fs, selectedItems, {
          rootUri: plan.rootUri,
          excludeBaseNames: [DEFAULT_TEMP_DOWNLOAD_DIR, ...getConfiguredExcludeNames()],
          excludeUris: [tempRootUri],
          displayPath: adapter.displayPath,
          onSkippedSymlink: (linkUri) => {
            skippedLinks.push(relativeUriPath(plan.rootUri, linkUri) ?? adapter.displayPath(linkUri));
          }
        });
        return buildZip(entries, {
          deflateRaw: adapter.deflateRaw,
          onProgress: (completed, total, currentPath) => {
            const increment = total > 0 ? 100 / total : 0;
            progress.report({
              increment,
              message: `${completed}/${total} ${currentPath}`
            });
          }
        });
      }
    );

    await adapter.download(plan.filename, zipBytes, tempRootUri);
    host.window.showInformationMessage(
      `Downloaded ${plan.filename} (${formatBytes(zipBytes.byteLength)}).${describeSkippedLinks(skippedLinks)}`
    );
  }

  function describeSkippedLinks(links: string[]): string {
    if (links.length === 0) {
      return '';
    }
    const noun = links.length === 1 ? 'symbolic link' : 'symbolic links';
    return ` Skipped ${links.length} ${noun} (${links[0]}${links.length > 1 ? ', ...' : ''}).`;
  }

  function resolveTempRoot(baseUri: UriLike): UriLike {
    const tempDirectory = getConfiguredTempDirectory();
    if (isUriString(tempDirectory)) {
      throw new Error('saveFilesAsZip.tempDirectory must be a filesystem path, not a URI.');
    }

    return adapter.resolveTempRoot(tempDirectory, baseUri);
  }

  function getSetting<T>(key: string, defaultValue: T): unknown {
    const configuration =
      host.workspace && typeof host.workspace.getConfiguration === 'function'
        ? host.workspace.getConfiguration(CONFIG_SECTION)
        : undefined;
    return configuration && typeof configuration.get === 'function'
      ? configuration.get(key, defaultValue)
      : defaultValue;
  }

  function getConfiguredExcludeNames(): string[] {
    const configured = getSetting(EXCLUDE_NAMES_SETTING, DEFAULT_EXCLUDE_NAMES);
    if (!Array.isArray(configured)) {
      return DEFAULT_EXCLUDE_NAMES;
    }
    return configured
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function getConfiguredTempDirectory(): string {
    const configured = getSetting(TEMP_DIRECTORY_SETTING, DEFAULT_TEMP_DOWNLOAD_DIR);

    if (typeof configured !== 'string') {
      return DEFAULT_TEMP_DOWNLOAD_DIR;
    }

    const trimmed = configured.trim();
    return trimmed || DEFAULT_TEMP_DOWNLOAD_DIR;
  }

  function activate(context: ExtensionContextLike): void {
    const disposable = host.commands.registerCommand(COMMAND_ID, async (uri?: UriLike, selectedUris?: UriLike[]) => {
      try {
        await saveAsZip(uri, selectedUris);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : String(error);
        host.window.showErrorMessage(`Download as Zip failed: ${message}`);
      }
    });

    context.subscriptions.push(disposable);
  }

  return {
    activate,
    deactivate() {},
    saveAsZip
  };
}
