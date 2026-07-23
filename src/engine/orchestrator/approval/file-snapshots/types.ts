import { isInternalGitStatusPath } from '../../../../core/paths.js';
import { uniqueInOrder } from '../../../../utils/collections.js';

export type ChangedFilesSnapshot = {
  head: string;
  files: string[];
  dirtyFileContents: Record<string, string | null>;
  gitlinks?: string[] | undefined;
  baselineFileHashes?: Record<string, string | null> | undefined;
  ignoreProjectDir?: string | undefined;
};

export type FileContentSnapshot = Record<string, string | null>;

export type RestoreChangedFilesResult = {
  restoredFiles: string[];
  conflictedFiles: string[];
};

export function uniqueProjectFiles(files: string[]): string[] {
  return uniqueInOrder(files)
    .filter((file) => file.length > 0)
    .filter((file) => !file.endsWith('/'))
    .filter((file) => !isInternalGitStatusPath(file))
    .sort();
}
