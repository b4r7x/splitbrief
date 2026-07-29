import { isInternalGitStatusPath } from '../../../../core/paths.js';
import { uniqueInOrder } from '../../../../utils/collections.js';

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
