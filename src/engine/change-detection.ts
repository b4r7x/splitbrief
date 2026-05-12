import { getCurrentChangedFiles } from '../lib/git.js';

export function createChangeDetector(label: string) {
  return async (projectDir: string, before: string[]) => {
    const changedFiles = await getCurrentChangedFiles(projectDir);
    const beforeSet = new Set(before);
    const newChanges = changedFiles.filter(f => !beforeSet.has(f));
    if (newChanges.length === 0) {
      return { changed: false, output: `${label} exited without changing any files` };
    }
    return { changed: true, output: '' };
  };
}
